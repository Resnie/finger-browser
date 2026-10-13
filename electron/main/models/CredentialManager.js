import Store from 'electron-store';
import crypto from 'crypto';
import fs from 'fs';
import { safeStorage } from 'electron';
import { logger } from '../../utils/logger.js';
import { normalizeRecoveryCredentials } from './browserRecovery.mjs';

/**
 * 每实例密码管理器
 * 新数据使用操作系统安全存储；保留旧格式解密以便平滑迁移。
 */
export class CredentialManager {
  constructor(instanceId, { onChanged = null, ownerId = null } = {}) {
    this.instanceId = instanceId;
    this.ownerId = ownerId === null || ownerId === undefined ? null : String(ownerId);
    if (this.ownerId !== null && !/^[1-9][0-9]{0,19}$/.test(this.ownerId)) {
      throw new Error('凭据缓存用户 ID 格式无效');
    }
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.store = new Store({
      name: this.ownerId
        ? `credentials-u${this.ownerId}-${instanceId}`
        : `credentials-${instanceId}`,
      configFileMode: 0o600,
      clearInvalidConfig: false,
    });
    this.logger = logger.createContextLogger(`Credential:${instanceId}`);
    // 仅用于读取旧版数据；新密码使用操作系统密钥链加密。
    this.legacyEncryptionKey = this._deriveKey(instanceId);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(this.store.path, 0o600);
      } catch {
        // 文件可能尚未创建，首次写入时会使用 configFileMode。
      }
    }
  }

  /**
   * 基于实例 ID 派生加密密钥
   */
  _deriveKey(id) {
    return crypto.createHash('sha256').update(`credential-key-${id}`).digest();
  }

  /**
   * 加密字符串
   */
  _encrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法安全保存密码');
    }
    return `v2:${safeStorage.encryptString(text).toString('base64')}`;
  }

  /**
   * 解密字符串
   */
  _decrypt(data) {
    try {
      if (typeof data !== 'string') return null;
      if (data.startsWith('v2:')) {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.decryptString(Buffer.from(data.slice(3), 'base64'));
      }

      const [ivHex, authTagHex, encrypted] = data.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.legacyEncryptionKey, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      this.logger.error(`解密失败: ${error.message}`);
      return null;
    }
  }
  /**
   * 获取所有凭据（密码已解密）
   */
  _getAll({ strict = false } = {}) {
    let value;
    try {
      value = this.store.get('credentials', []);
    } catch (cause) {
      if (strict) {
        throw new Error('本地凭据缓存读取失败，已阻止覆盖云端备份', { cause });
      }
      this.logger.warn('读取凭据缓存失败，展示层已隐藏损坏数据');
      return [];
    }
    if (Array.isArray(value)) return value;
    if (strict) throw new Error('本地凭据缓存格式无效，已阻止覆盖云端备份');
    this.logger.warn('本地凭据缓存格式无效，展示层已使用空列表');
    return [];
  }

  /**
   * 保存凭据
   */
  save(domain, username, password) {
    if (
      typeof domain !== 'string' ||
      !domain.trim() ||
      domain.length > 253 ||
      typeof username !== 'string' ||
      username.length > 512 ||
      typeof password !== 'string' ||
      password.length > 4096
    ) {
      throw new Error('凭据数据格式无效');
    }

    const normalizedDomain = domain.trim().toLowerCase();
    const credentials = this._getAll({ strict: true });
    const existing = credentials.find(
      c =>
        String(c.domain || '')
          .trim()
          .toLowerCase() === normalizedDomain && c.username === username
    );

    const encryptedPassword = this._encrypt(password);

    if (existing) {
      existing.domain = normalizedDomain;
      existing.password = encryptedPassword;
      existing.lastUsedTime = Date.now();
    } else {
      credentials.push({
        domain: normalizedDomain,
        username,
        password: encryptedPassword,
        lastUsedTime: Date.now(),
      });
    }

    this.store.set('credentials', credentials);
    this.onChanged?.('credential-saved');
    this.logger.info('凭据已安全保存');
  }

  /**
   * 获取指定域名的凭据
   */
  getForDomain(domain) {
    const credentials = this._getAll();
    const normalizedDomain = String(domain || '')
      .trim()
      .toLowerCase();
    let migrated = false;
    const result = credentials
      .filter(
        c =>
          String(c.domain || '')
            .trim()
            .toLowerCase() === normalizedDomain
      )
      .map(c => {
        const password = this._decrypt(c.password);
        if (c.domain !== normalizedDomain) {
          c.domain = normalizedDomain;
          migrated = true;
        }
        if (password !== null && !c.password?.startsWith('v2:')) {
          try {
            c.password = this._encrypt(password);
            migrated = true;
          } catch {
            // 系统安全存储暂不可用时仍允许读取旧数据，下次再迁移。
          }
        }
        return {
          domain: c.domain,
          username: c.username,
          password,
          lastUsedTime: c.lastUsedTime,
        };
      });

    if (migrated) {
      this.store.set('credentials', credentials);
      this.logger.info('旧版凭据已迁移到系统安全存储');
    }
    return result;
  }

  /**
   * 获取所有凭据列表（密码不解密，用于展示）
   */
  list() {
    return this._getAll().map(c => ({
      domain: c.domain,
      username: c.username,
      lastUsedTime: c.lastUsedTime,
    }));
  }

  /**
   * 导出云端恢复凭据。明文只存在于返回值和随后的已认证 API 请求内存中。
   */
  exportEntries() {
    const plaintext = [];
    for (const item of this._getAll({ strict: true })) {
      const password = this._decrypt(item.password);
      if (password === null) throw new Error('本地凭据无法解密，已阻止覆盖云端备份');
      plaintext.push({
        domain: item.domain,
        username: item.username,
        password,
        lastUsedTime: item.lastUsedTime,
      });
    }
    const normalized = normalizeRecoveryCredentials(plaintext);
    if (normalized === null) throw new Error('本地凭据格式无效');
    return normalized;
  }

  /**
   * 将后端明文凭据先全部校验、全部 safeStorage 加密，再一次性替换本地缓存。
   */
  importEntries(rawCredentials, { notify = false } = {}) {
    const normalized = normalizeRecoveryCredentials(rawCredentials);
    if (normalized === null) throw new Error('云端凭据格式无效');
    const encrypted = normalized.map(item => ({
      domain: item.domain,
      username: item.username,
      password: this._encrypt(item.password),
      lastUsedTime: item.lastUsedTime,
    }));
    this.store.set('credentials', encrypted);
    if (notify) this.onChanged?.('credentials-imported');
    this.logger.info(`已安全恢复 ${encrypted.length} 条凭据`);
    return encrypted.length;
  }

  /**
   * 删除凭据
   */
  delete(domain, username, { notify = true } = {}) {
    const credentials = this._getAll({ strict: true });
    const normalizedDomain = String(domain || '')
      .trim()
      .toLowerCase();
    const filtered = credentials.filter(
      c =>
        !(
          String(c.domain || '')
            .trim()
            .toLowerCase() === normalizedDomain && c.username === username
        )
    );
    this.store.set('credentials', filtered);
    if (notify) this.onChanged?.('credential-deleted');
    this.logger.info('凭据已删除');
  }

  /**
   * 清除所有凭据
   */
  clear({ notify = true } = {}) {
    this.store.set('credentials', []);
    if (notify) this.onChanged?.('credentials-cleared');
    this.logger.info('所有凭据已清除');
  }
}
