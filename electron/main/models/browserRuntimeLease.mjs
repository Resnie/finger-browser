import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** One random fencing token per runtime, never a browser fingerprint or a user credential. */
export class BrowserRuntimeLeases {
  constructor({
    request,
    tokenStore,
    onLost,
    device = process.platform,
    intervalMs = 15000,
    wallNow = Date.now,
    monotonicNow = () => performance.now(),
    token = () => randomBytes(32).toString('hex'),
  }) {
    Object.assign(this, {
      request,
      tokenStore,
      onLost,
      device,
      intervalMs,
      wallNow,
      monotonicNow,
      token,
    });
    this.entries = new Map();
  }
  getToken(id) {
    return this.entries.get(id)?.token || '';
  }
  valid(id) {
    const entry = this.entries.get(id);
    return Boolean(
      entry &&
        !entry.lost &&
        entry.wallDeadline > this.wallNow() &&
        entry.deadline > this.monotonicNow()
    );
  }
  _deadline(entry, response, elapsed) {
    const ttl = Number(response?.ttlMillis);
    if (!Number.isFinite(ttl) || ttl < 30000 || ttl > 300000 || ttl - elapsed < 20000)
      throw new Error('运行锁有效期异常，已阻止启动');
    const remaining = ttl - elapsed - 15000;
    entry.wallDeadline = this.wallNow() + remaining;
    entry.deadline = this.monotonicNow() + remaining;
  }
  async acquire(id, ownerId) {
    if (ownerId !== undefined) {
      ownerId = Number(ownerId);
      if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error('浏览器运行锁用户无效');
    }
    const old = this.entries.get(id);
    if (old && old.ownerId !== ownerId) throw new Error('浏览器运行锁属于其他登录用户');
    const restoredToken = old ? null : this.tokenStore?.load(ownerId, id);
    const entry = old || {
      token: restoredToken || this.token(),
      ownerId,
      restored: Boolean(restoredToken),
    };
    this.tokenStore?.save(ownerId, id, entry.token);
    this.entries.set(id, entry); // Retry unknown HTTP outcomes with the same token.
    const start = this.monotonicNow();
    let response;
    try {
      response = await this.request('acquire', { id, token: entry.token, device: this.device });
    } catch (error) {
      if (error.definitiveLeaseRejection && this.entries.get(id) === entry) {
        clearInterval(entry.timer);
        this.entries.delete(id);
      }
      throw error;
    }
    this._deadline(entry, response, this.monotonicNow() - start);
    entry.lost = false;
    entry.revision = Number(response.recovery?.recoveryRevision);
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = setInterval(() => {
      void this.renew(id);
    }, this.intervalMs);
    entry.timer.unref?.();
    return response;
  }
  async renew(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.renewing || entry.lost) return;
    entry.renewing = true;
    try {
      if (!this.valid(id)) throw new Error('运行锁已超时');
      const start = this.monotonicNow();
      const response = await this.request('renew', { id, token: entry.token });
      this._deadline(entry, response, this.monotonicNow() - start);
    } catch {
      if (this.entries.get(id) !== entry) return;
      entry.lost = true;
      clearInterval(entry.timer);
      await this.onLost(id).catch(() => {});
    } finally {
      entry.renewing = false;
    }
  }
  async release(id, revision) {
    const entry = this.entries.get(id);
    if (!entry) return;
    await this.request('release', {
      id,
      token: entry.token,
      recoveryRevision: revision ?? entry.revision,
    });
    clearInterval(entry.timer);
    if (this.entries.get(id) === entry) this.entries.delete(id);
    this.tokenStore?.clear(entry.ownerId, id);
  }
}
