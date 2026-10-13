import { logger } from '../utils/logger.js';
import { ipcRegistry } from './ipc/registry.js';
import { ipcEmitter } from './ipc/emitter.js';
import { BrowserInstance } from './models/BrowserInstance.js';
import { closeContextWithTimeout } from './models/browserLifecycle.mjs';
import { HistoryManager } from './models/HistoryManager.js';
import { CredentialManager } from './models/CredentialManager.js';
import { getApiBaseUrl } from '../utils/config.js';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  buildBrowserSessionPayload,
  normalizeCloudRecoveryVersion,
} from './models/browserRecovery.mjs';
import {
  BrowserRecoveryEmergencySentinel,
  BrowserRecoveryOutbox,
  BrowserRuntimeLeaseTokens,
  areRecoverySnapshotsEquivalent,
  decideRecoveryOutboxReplay,
  normalizeRecoveryOwnerId,
  validateRecoveryReplayRevision,
} from './models/browserRecoveryOutboxElectron.mjs';
import {
  parseBrowserRecoveryResponse,
  parseLegacyBrowserSearchRecovery,
} from './models/browserRecoveryResponse.mjs';
import { planLegacyRecoveryMigration } from './models/browserRecoveryMigration.mjs';
import {
  listOwnedBrowserProfileIds,
  removeOwnedBrowserProfiles,
  resolveBrowserProfilePaths,
} from './models/browserProfilePath.mjs';
import { getAppPath } from '../utils/tools.js';
import { mergeHistoryAfterRejectedClear } from './models/historyEntries.mjs';
import { BrowserRuntimeLeases } from './models/browserRuntimeLease.mjs';

const browserLogger = logger.createContextLogger('BrowserManager');
const SAFE_INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const assertInstanceId = id => {
  if (typeof id !== 'string' || !SAFE_INSTANCE_ID.test(id)) {
    throw new Error('浏览器实例 ID 格式无效');
  }
  return id;
};

/**
 * 多浏览器实例管理器
 * 负责管理所有浏览器实例的创建、恢复和关闭
 */
class MultiBrowserManager {
  constructor() {
    this.instances = new Map();
    // 记录正在关闭的实例，避免重复处理
    this.closingInstances = new Set();
    // 同一实例的启动、关闭和快照写入必须串行，避免共用数据目录和旧状态覆盖新状态。
    this.launchingInstances = new Map();
    this.closePromises = new Map();
    this._backgroundCleanupPromises = new Map();
    this._persistChains = new Map();
    // 每个实例的防抖定时器（用于页面事件触发的保存）
    this._saveTimers = new Map();
    this._cloudRecoveryCapability = { status: 'unknown', version: 0, expiresAt: 0 };
    this.recoveryOutbox = new BrowserRecoveryOutbox();
    this.recoveryEmergencySentinel = new BrowserRecoveryEmergencySentinel();
    this._detachedRecoveryRevisions = new Map();
    this._detachedRecoveryReady = new Set();
    this._detachedRecoveryOwners = new Map();
    // Chromium 已被用户直接关闭，且 safeStorage/outbox 未能落下完整载荷时，
    // 在主进程内保留实例恢复缓存，直到重试成功或加密 outbox 已安全落盘。
    this._unsafeClosedInstances = new Map();
    this._sessionCache = null;
    this._sessionTransitioning = false;
    this._frozenToken = '';
    this.runtimeLeases = new BrowserRuntimeLeases({
      tokenStore: new BrowserRuntimeLeaseTokens(),
      request: async (action, payload) => {
        const { token } = await this._getCurrentSession();
        let response;
        try {
          response = await axios.post(`${getApiBaseUrl()}/browsers/runtime/${action}`, payload, {
            timeout: 5000,
            headers: { Authorization: token },
          });
        } catch (cause) {
          const error = new Error(
            cause.response?.status === 404
              ? '服务端尚不支持浏览器互锁，请升级后再打开'
              : '浏览器互锁连接失败'
          );
          error.definitiveLeaseRejection = Boolean(cause.response);
          throw error;
        }
        if (response.data?.code !== 0) {
          const error = new Error(response.data?.message || '浏览器互锁请求失败');
          error.definitiveLeaseRejection = true;
          throw error;
        }
        return response.data.data;
      },
      onLost: async id => {
        const instance = this.instances.get(id);
        if (instance) instance._runtimeLeaseLost = true;
        this._emitRecoveryFailure(id, {
          retained: true,
          critical: true,
          message: '浏览器互锁连接中断，正在关闭窗口并保留本地数据；恢复连接后再打开',
        });
        try {
          await this.closeInstance(id);
        } catch {
          // Expired ownership stays on the server until this device confirms shutdown.
          if (instance) {
            instance.clearTimers();
            await instance.gracefulClose().catch(() => {});
            await instance.forceKillBrowser().catch(() => {});
          }
        }
      },
    });
  }

  _sessionPayloadWithLease(payload) {
    const token = this.runtimeLeases.getToken(payload.id);
    return token ? { ...payload, runtimeLeaseToken: token } : payload;
  }

  async _runRecoveryChain(id, task) {
    assertInstanceId(id);
    const previous = this._persistChains.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this._persistChains.set(id, current);
    try {
      return await current;
    } finally {
      if (this._persistChains.get(id) === current) this._persistChains.delete(id);
    }
  }

  _assertSessionOperationsAllowed() {
    if (this._sessionTransitioning && !this._frozenToken) {
      throw new Error('正在安全收口当前登录会话，请稍后重试');
    }
  }

  _emitRecoveryFailure(id, { retained = false, critical = false, message = '' } = {}) {
    ipcEmitter.emitBrowserRecoverySyncFailed(id, { retained, critical, message });
  }

  _clearSupersededEmergencySentinel(id, ownerId) {
    const marker = this.recoveryEmergencySentinel.get(id, ownerId);
    if (marker) this.recoveryEmergencySentinel.clearIfSequence(id, marker.sequence, ownerId);
  }

  _recordDirtyWithoutPayload(id, expectedRevision, ownerId, reason = 'snapshot-invalid') {
    const sequence = crypto.randomUUID();
    const previousDirty = this.recoveryOutbox.getDirtyMarker(id, ownerId);
    const previousSentinel = this.recoveryEmergencySentinel.get(id, ownerId);
    try {
      this.recoveryOutbox.markDirty(id, expectedRevision, reason, { ownerId, sequence });
      return {
        retained: false,
        markerPersisted: true,
        sequence,
        previousDirty,
        previousSentinel,
      };
    } catch (markerError) {
      if (markerError.code !== 'RECOVERY_DIRTY_MARKER_WRITE_FAILED') throw markerError;
      try {
        this.recoveryEmergencySentinel.mark(id, expectedRevision, 'primary-store-failed', {
          ownerId,
          sequence,
        });
        return {
          retained: false,
          markerPersisted: true,
          sequence,
          emergency: true,
          previousDirty,
          previousSentinel,
        };
      } catch (sentinelError) {
        const error = new Error('无法安全保留最新恢复数据，已阻止关闭', {
          cause: sentinelError,
        });
        error.code = 'RECOVERY_UNSAFE_CLOSE';
        error.blocksClose = true;
        error.recoverySnapshotRetained = false;
        throw error;
      }
    }
  }

  _stageRecoveryOutbox(id, payload, ownerId) {
    const previousEntry = this.recoveryOutbox.getRawEntry(id, ownerId);
    const previousDirty = this.recoveryOutbox.getDirtyMarker(id, ownerId);
    // 独立 sentinel 也必须先校验 owner，不允许同 browserId 跨库覆盖。
    const previousSentinel = this.recoveryEmergencySentinel.get(id, ownerId);
    const sequence = crypto.randomUUID();
    if (previousSentinel) {
      // 将旧 sentinel 先提升到本次序列。若崩溃在 outbox 落盘与 sentinel
      // 清理之间，启动流程可用同序列的可解密 entry 安全收敛。
      this.recoveryEmergencySentinel.mark(id, payload.recoveryRevision, 'primary-store-failed', {
        ownerId,
        sequence,
      });
    }
    try {
      const write = this.recoveryOutbox.put(id, payload, payload.recoveryRevision, {
        ownerId,
        sequence,
      });
      // 一份更新、完整、已加密的 outbox 可显式取代旧紧急标记。
      this._clearSupersededEmergencySentinel(id, ownerId);
      return { write, previousEntry, previousDirty, previousSentinel };
    } catch (error) {
      error.recoveryStage = { previousEntry, previousDirty, previousSentinel };
      error.outboxSequence ||= sequence;
      if (error.code === 'RECOVERY_DIRTY_MARKER_WRITE_FAILED') {
        try {
          this.recoveryEmergencySentinel.mark(
            id,
            payload.recoveryRevision,
            'primary-store-failed',
            {
              ownerId,
              sequence: error.outboxSequence || crypto.randomUUID(),
            }
          );
        } catch (sentinelError) {
          error.code = 'RECOVERY_UNSAFE_CLOSE';
          error.blocksClose = true;
          error.cause = sentinelError;
        }
      }
      error.recoverySnapshotRetained = false;
      throw error;
    }
  }

  _restoreRecoveryMarkersAfterRejectedAttempt(id, ownerId, attemptSequence, stage) {
    const previousEntry = stage?.previousEntry ?? null;
    const currentOutbox = this.recoveryOutbox.getMetadata(id, ownerId);
    const currentDirty = this.recoveryOutbox.getDirtyMarker(id, ownerId);
    const currentSentinel = this.recoveryEmergencySentinel.get(id, ownerId);
    const mainEvidenceMatches = [currentOutbox, currentDirty].some(
      record => record?.sequence === attemptSequence
    );
    const sentinelMatches = currentSentinel?.sequence === attemptSequence;
    const hasAttemptEvidence = [currentOutbox, currentDirty, currentSentinel].some(
      record => record?.sequence === attemptSequence
    );
    if (!hasAttemptEvidence) {
      throw new Error('待同步序列已变化，已阻止回滚本地操作');
    }

    // sentinel 与主 outbox 使用不同的物理文件。先恢复 sentinel，
    // 即使两文件写入之间崩溃，下次启动也会失败关闭而不会丢证据。
    if (sentinelMatches) {
      this.recoveryEmergencySentinel.restoreIfSequence(
        id,
        attemptSequence,
        stage?.previousSentinel ?? null,
        ownerId
      );
    } else if (currentSentinel) {
      throw new Error('紧急恢复序列已变化，已阻止回滚本地操作');
    } else if (stage?.previousSentinel) {
      this.recoveryEmergencySentinel.mark(
        id,
        stage.previousSentinel.expectedRevision,
        stage.previousSentinel.reason,
        {
          ownerId,
          sequence: stage.previousSentinel.sequence,
        }
      );
    }

    if (mainEvidenceMatches) {
      const rolledBack = this.recoveryOutbox.rollbackAttempt(
        id,
        attemptSequence,
        previousEntry,
        ownerId,
        stage?.previousDirty ?? null
      );
      if (!rolledBack) {
        throw new Error('待同步序列已变化，已阻止回滚本地操作');
      }
    }
  }

  /**
   * 将快照持久化到后端 + 通知渲染进程
   * @param {{ id: string, pages: Array, state: Object|null, config: Object }} snapshot
   * @param {string} reason - 保存原因（用于日志）
   */
  async persistSnapshot(snapshot, reason = '', options = {}) {
    const id = assertInstanceId(snapshot?.id);
    return this._runRecoveryChain(id, () => this._persistSnapshotNow(snapshot, reason, options));
  }

  async _persistSnapshotNow(snapshot, reason = '', { rollbackOutboxOnFailure = false } = {}) {
    const { id } = snapshot;
    const activeInstance = this.instances.get(id);
    // 页面事件可能在显式历史/凭据操作的 HTTP 等待期间排队。
    // 真正进入同 ID 串行链时重新取活动实例快照，避免之前捕获的
    // 未确认 mutation 在回滚后又被下一个页面事件上传。
    const effectiveSnapshot = activeInstance ? activeInstance.getSnapshot() : snapshot;
    const { pages } = effectiveSnapshot;

    // 通知渲染进程更新本地 UI
    ipcEmitter.emitSaveBrowserState({ id, config: effectiveSnapshot.config });

    let outboxStage = null;
    let dirtyRecord = null;
    let requestDispatched = false;
    let definitiveRejection = false;
    let ownerId = activeInstance?.ownerId || snapshot?.ownerId || null;
    let previousOutboxEntry = null;

    // 持久化到后端。cloud v1 必须先完成本地加密 outbox 写入。
    try {
      const baseUrl = getApiBaseUrl();
      let session;
      try {
        session = await this._getCurrentSession();
      } catch (sessionError) {
        if (ownerId && normalizeCloudRecoveryVersion(effectiveSnapshot.cloudRecoveryVersion) >= 1) {
          previousOutboxEntry = this.recoveryOutbox.getRawEntry(id, ownerId);
          try {
            outboxStage = this._stageRecoveryOutbox(
              id,
              buildBrowserSessionPayload(effectiveSnapshot, 1),
              ownerId
            );
          } catch (stageError) {
            if (stageError.outboxSequence || stageError.blocksClose) throw stageError;
            dirtyRecord = this._recordDirtyWithoutPayload(
              id,
              Number(effectiveSnapshot.recoveryRevision ?? 0),
              ownerId
            );
          }
        }
        throw sessionError;
      }
      const { token } = session;
      if (activeInstance?.ownerId && activeInstance.ownerId !== ownerId) {
        throw new Error('运行中浏览器的本地归属数据已损坏');
      }
      if (ownerId && ownerId !== session.userId) {
        if (normalizeCloudRecoveryVersion(effectiveSnapshot.cloudRecoveryVersion) >= 1) {
          previousOutboxEntry = this.recoveryOutbox.getRawEntry(id, ownerId);
          outboxStage = this._stageRecoveryOutbox(
            id,
            buildBrowserSessionPayload(effectiveSnapshot, 1),
            ownerId
          );
        }
        const mismatchError = new Error('当前登录用户与运行中浏览器不一致，已阻止同步');
        mismatchError.recoverySnapshotRetained = Boolean(outboxStage);
        throw mismatchError;
      }
      ownerId = session.userId;
      previousOutboxEntry = this.recoveryOutbox.getRawEntry(id, ownerId);
      let capability;
      try {
        capability = await this._getCloudRecoveryVersion(token, ownerId);
      } catch (capabilityError) {
        const mustPreserveAsV1 =
          normalizeCloudRecoveryVersion(effectiveSnapshot.cloudRecoveryVersion) >= 1 ||
          this._cloudRecoveryCapability.status === 'v1' ||
          Boolean(this.recoveryOutbox.getMetadata(id, ownerId)) ||
          Boolean(this.recoveryOutbox.getDirtyMarker(id, ownerId)) ||
          Boolean(this.recoveryEmergencySentinel.get(id, ownerId));
        if (mustPreserveAsV1) {
          // 能力端点暂时不可用时，已知 v1 实例仍要先保住最新本地快照，
          // 但不发起可能绕过 CAS 的网络写入。
          try {
            const pendingPayload = buildBrowserSessionPayload(effectiveSnapshot, 1);
            outboxStage = this._stageRecoveryOutbox(id, pendingPayload, ownerId);
          } catch (stageError) {
            if (stageError.outboxSequence || stageError.blocksClose) throw stageError;
            dirtyRecord = this._recordDirtyWithoutPayload(
              id,
              Number(effectiveSnapshot.recoveryRevision ?? 0),
              ownerId
            );
          }
        }
        throw capabilityError;
      }

      if (
        capability < 1 &&
        (this.recoveryOutbox.getMetadata(id, ownerId) ||
          this.recoveryOutbox.getDirtyMarker(id, ownerId) ||
          this.recoveryEmergencySentinel.get(id, ownerId))
      ) {
        throw new Error('本机存在 v1 待同步快照，已阻止用旧协议绕过 CAS');
      }

      let payload;
      try {
        payload = buildBrowserSessionPayload(effectiveSnapshot, capability);
      } catch (error) {
        // 新协议下凭据/历史无法安全导出时必须整体停止，
        // 不得携带远端 revision 上传空缓存或绕过 CAS。
        browserLogger.warn(`实例 ${id} 恢复字段未上传: ${error.message}`);
        if (capability >= 1) {
          dirtyRecord = this._recordDirtyWithoutPayload(
            id,
            Number(effectiveSnapshot.recoveryRevision ?? 0),
            ownerId
          );
          throw new Error('云端恢复快照无法安全生成，已停止本次保存');
        }
        payload = buildBrowserSessionPayload(effectiveSnapshot, 0);
      }
      if (capability >= 1) outboxStage = this._stageRecoveryOutbox(id, payload, ownerId);

      requestDispatched = true;
      const response = await axios.post(
        `${baseUrl}/browsers/update_session`,
        this._sessionPayloadWithLease(payload),
        {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: token } : {}),
          },
        }
      );
      if (response.data?.code !== 0) {
        definitiveRejection = true;
        if (
          capability >= 1 &&
          /revision|conflict|版本|冲突|其他设备/i.test(String(response.data?.message || ''))
        ) {
          ipcEmitter.emitBrowserRecoveryConflict(id);
        }
        throw new Error(response.data?.message || '服务端拒绝保存浏览器状态');
      }
      let nextRevision = null;
      if (capability >= 1) {
        const expectedRevision = Number(payload.recoveryRevision);
        nextRevision = Number(response.data?.data?.recoveryRevision);
        if (!validateRecoveryReplayRevision(expectedRevision, nextRevision)) {
          throw new Error('服务端未返回有效的恢复版本');
        }
        if (
          activeInstance &&
          !activeInstance.acknowledgeRecoveryRevision(expectedRevision, nextRevision)
        ) {
          throw new Error('本地恢复版本已变化，已停止确认本次保存');
        }
        this._detachedRecoveryRevisions.set(id, nextRevision);
        this._detachedRecoveryReady.add(id);
        this._detachedRecoveryOwners.set(id, ownerId);
        if (!this.recoveryOutbox.removeIfSequence(id, outboxStage.write.sequence, ownerId)) {
          browserLogger.warn(`实例 ${id} 保存成功，但已有更新的 outbox 序列需继续同步`);
        }
      }
      browserLogger.info(`[${reason}] 实例 ${id} 状态已持久化到后端 (${pages.length} 个页面)`);
      return {
        recoveryRevision: nextRevision,
        cloudPersisted: capability >= 1,
      };
    } catch (error) {
      const attemptSequence =
        outboxStage?.write?.sequence || error.outboxSequence || dirtyRecord?.sequence;
      const canRollback = rollbackOutboxOnFailure && (!requestDispatched || definitiveRejection);
      if (canRollback && ownerId && attemptSequence) {
        try {
          this._restoreRecoveryMarkersAfterRejectedAttempt(id, ownerId, attemptSequence, {
            ...(outboxStage || dirtyRecord || error.recoveryStage || {}),
            previousEntry: outboxStage?.previousEntry ?? previousOutboxEntry,
          });
        } catch (rollbackError) {
          error.preserveLocalMutation = true;
          error.blocksClose = true;
          browserLogger.error(`实例 ${id} 恢复证据回滚失败: ${rollbackError.message}`);
        }
      } else if (rollbackOutboxOnFailure && requestDispatched && !definitiveRejection) {
        // POST 可能已被服务端接受：保留本地操作和 outbox，不制造相反证据。
        error.preserveLocalMutation = true;
        error.recoveryOutcomeUnknown = true;
      }

      let retained = false;
      if (ownerId) {
        try {
          const metadata = this.recoveryOutbox.getMetadata(id, ownerId);
          retained = Boolean(attemptSequence && metadata && metadata.sequence === attemptSequence);
        } catch {}
      }
      error.recoverySnapshotRetained = retained;
      if (ownerId || normalizeCloudRecoveryVersion(effectiveSnapshot.cloudRecoveryVersion) >= 1) {
        this._emitRecoveryFailure(id, {
          retained,
          critical: Boolean(error.blocksClose || !retained),
          message: error.message,
        });
      }
      browserLogger.error(`[${reason}] 实例 ${id} 持久化失败: ${error.message}`);
      throw error;
    }
  }

  async _getCurrentSession(existingToken = '') {
    const token = existingToken || (await this._getToken());
    if (!token) throw new Error('登录状态无效，已停止云恢复读写');
    if (this._frozenToken && this._frozenToken !== token) {
      this._frozenToken = '';
      this._sessionTransitioning = false;
    }
    if (this._frozenToken === token) throw new Error('当前会话已退出，已停止云恢复读写');

    const now = Date.now();
    if (this._sessionCache?.token === token && this._sessionCache.expiresAt > now) {
      await this._sessionCache.reconciliationPromise;
      return { token, userId: this._sessionCache.userId };
    }
    const response = await axios.get(`${getApiBaseUrl()}/users/current`, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json', Authorization: token },
    });
    if (response.data?.code !== 0) throw new Error('服务端未确认当前登录用户');
    const userId = normalizeRecoveryOwnerId(response.data?.data?.id);
    const sessionCache = { token, userId, expiresAt: now + 60_000 };
    sessionCache.reconciliationPromise = this._reconcileOwnerLocalRecovery({ token, userId }).catch(
      error => {
        // 无法拉取授权列表时不清理任何本地数据；本次会话的单实例
        // recovery 仍会另行向服务端校验归属。
        browserLogger.warn(`用户 ${userId} 本地孤儿恢复数据对账失败: ${error.message}`);
      }
    );
    this._sessionCache = sessionCache;
    await sessionCache.reconciliationPromise;
    return { token, userId };
  }

  _getOwnedRecoveryCacheIds(ownerId) {
    const owner = normalizeRecoveryOwnerId(ownerId);
    const storePath = this.recoveryOutbox.store?.path;
    if (typeof storePath !== 'string' || !storePath) return [];
    const directory = path.dirname(storePath);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('恢复缓存根目录不是受控实体目录');
    }
    const prefixes = [`history-u${owner}-`, `credentials-u${owner}-`];
    const ids = new Set();
    for (const name of fs.readdirSync(directory)) {
      for (const prefix of prefixes) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        const id = name.slice(prefix.length, -'.json'.length);
        if (SAFE_INSTANCE_ID.test(id)) ids.add(id);
      }
    }
    return Array.from(ids);
  }

  _removeOwnedRecoveryCacheFiles(id, ownerId) {
    assertInstanceId(id);
    const owner = normalizeRecoveryOwnerId(ownerId);
    const storePath = this.recoveryOutbox.store?.path;
    if (typeof storePath !== 'string' || !storePath) {
      new HistoryManager(id, { ownerId: owner }).clear({ notify: false });
      new CredentialManager(id, { ownerId: owner }).clear({ notify: false });
      return;
    }
    const directory = path.resolve(path.dirname(storePath));
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('恢复缓存根目录不是受控实体目录');
    }
    for (const name of [
      `history-u${owner}-${id}.json`,
      `credentials-u${owner}-${id}.json`,
      `history-${id}.json`,
      `credentials-${id}.json`,
    ]) {
      const target = path.resolve(directory, name);
      if (!target.startsWith(`${directory}${path.sep}`) || !fs.existsSync(target)) continue;
      const targetStat = fs.lstatSync(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new Error('恢复缓存文件不是受控实体文件');
      }
      fs.unlinkSync(target);
    }
  }

  async _reconcileOwnerLocalRecovery(session) {
    const response = await axios.post(
      `${getApiBaseUrl()}/browsers/search`,
      { page: 1, size: 200, includeRecovery: false },
      {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: session.token,
        },
      }
    );
    if (response.data?.code !== 0 || !Array.isArray(response.data?.data?.list)) {
      throw new Error('服务端未返回完整的授权浏览器列表');
    }
    const authorized = new Set(
      response.data.data.list
        .map(item => item?.browser_id ?? item?.id)
        .filter(id => typeof id === 'string' && SAFE_INSTANCE_ID.test(id))
    );
    const local = new Set([
      ...this.recoveryOutbox.listBrowserIdsForOwner(session.userId),
      ...this.recoveryEmergencySentinel.listBrowserIdsForOwner(session.userId),
      ...listOwnedBrowserProfileIds(getAppPath(), session.userId),
      ...this._getOwnedRecoveryCacheIds(session.userId),
    ]);
    for (const id of local) {
      if (authorized.has(id)) continue;
      if (
        this.instances.has(id) ||
        this.launchingInstances.has(id) ||
        this.closingInstances.has(id) ||
        this._unsafeClosedInstances.has(id)
      ) {
        throw new Error(`实例 ${id} 已不属于当前用户，但本机仍在使用它`);
      }
      this.recoveryOutbox.delete(id, session.userId);
      const intent = this.recoveryOutbox.getDeletionIntent(id, session.userId);
      if (intent) {
        this.recoveryOutbox.clearDeletionIntentIfSequence(id, intent.sequence, session.userId);
      }
      const emergency = this.recoveryEmergencySentinel.get(id, session.userId);
      if (emergency) {
        this.recoveryEmergencySentinel.clearIfSequence(id, emergency.sequence, session.userId);
      }
      this._removeOwnedRecoveryCacheFiles(id, session.userId);
      removeOwnedBrowserProfiles(getAppPath(), id, session.userId);
      this._detachedRecoveryReady.delete(id);
      this._detachedRecoveryRevisions.delete(id);
      this._detachedRecoveryOwners.delete(id);
      browserLogger.info(`已清理用户 ${session.userId} 的孤儿恢复缓存: ${id}`);
    }
  }

  async _getCloudRecoveryVersion(existingToken = '', ownerId = '') {
    const now = Date.now();
    const owner = normalizeRecoveryOwnerId(ownerId);
    if (
      this._cloudRecoveryCapability.ownerId === owner &&
      this._cloudRecoveryCapability.expiresAt > now
    ) {
      return this._cloudRecoveryCapability.version;
    }
    try {
      const token = existingToken || (await this._getToken());
      const response = await axios.get(`${getApiBaseUrl()}/users/system_config`, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: token } : {}),
        },
      });
      if (response.data?.code !== 0) throw new Error('服务端拒绝读取能力配置');
      const version = normalizeCloudRecoveryVersion(
        response.data?.data?.cloudRecoveryVersion ?? response.data?.data?.cloud_recovery_version
      );
      this._cloudRecoveryCapability = {
        status: version >= 1 ? 'v1' : 'v0',
        ownerId: owner,
        version,
        expiresAt: now + 60_000,
      };
      return version;
    } catch {
      // 未过期的 confirmed-v0 已在函数入口返回。缓存过期后任何探测失败
      // 都必须回到 unknown 并失败关闭，避免服务端已升级 v1 却被绕过 CAS。
      this._cloudRecoveryCapability = {
        status: 'unknown',
        version: 0,
        ownerId: owner,
        expiresAt: 0,
      };
      throw new Error('无法确认服务端云恢复能力，已停止恢复写入');
    }
  }

  async fetchBrowserRecovery(id, token = '') {
    assertInstanceId(id);
    try {
      const response = await axios.post(
        `${getApiBaseUrl()}/browsers/recovery`,
        { id },
        {
          timeout: 10_000,
          headers: {
            'Content-Type': 'application/json',
            'X-Finger-Runtime-Protocol': '1',
            ...(token ? { Authorization: token } : {}),
          },
        }
      );
      if (response.data?.code !== 0) {
        throw new Error(response.data?.message || '服务端拒绝读取恢复详情');
      }
      return parseBrowserRecoveryResponse(response.data?.data);
    } catch (error) {
      browserLogger.warn(`实例 ${id} 恢复详情读取失败: ${error.message}`);
      throw new Error('无法从服务端读取完整恢复详情，已阻止使用本地陈旧数据');
    }
  }

  async fetchLegacyBrowserRecovery(id, token = '') {
    assertInstanceId(id);
    try {
      const response = await axios.post(
        `${getApiBaseUrl()}/browsers/search`,
        { page: 1, size: 200, includeRecovery: true },
        {
          timeout: 10_000,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: token } : {}),
          },
        }
      );
      if (response.data?.code !== 0 || !Array.isArray(response.data?.data?.list)) {
        throw new Error('服务端拒绝读取旧协议会话');
      }
      const row = response.data.data.list.find(item => item?.browser_id === id || item?.id === id);
      if (!row) throw new Error('当前用户不拥有该浏览器');
      return parseLegacyBrowserSearchRecovery(row);
    } catch (error) {
      browserLogger.warn(`实例 ${id} 旧协议会话读取失败: ${error.message}`);
      throw new Error('无法从服务端确认旧协议浏览器归属，已阻止启动');
    }
  }

  migrateLegacyLocalCachesToOwner(id, ownerId) {
    const owner = normalizeRecoveryOwnerId(ownerId);
    const { history, credentials } = this.readLegacyLocalCaches(id);
    const scopedHistory = new HistoryManager(id, { ownerId: owner });
    const scopedCredentials = new CredentialManager(id, { ownerId: owner });

    // 全部读取/解密成功后才写新 store；任一步失败都不清理旧文件。
    if (scopedHistory.exportEntries().length === 0 && history.length > 0) {
      scopedHistory.importEntries(history);
    }
    if (scopedCredentials.exportEntries().length === 0 && credentials.length > 0) {
      scopedCredentials.importEntries(credentials);
    }
    this.clearLegacyLocalCaches(id);
    return { historyCount: history.length, credentialCount: credentials.length };
  }

  readLegacyLocalCaches(id) {
    assertInstanceId(id);
    return {
      history: new HistoryManager(id).exportEntries(),
      credentials: new CredentialManager(id).exportEntries(),
    };
  }

  clearLegacyLocalCaches(id) {
    assertInstanceId(id);
    new HistoryManager(id).clear({ notify: false });
    new CredentialManager(id).clear({ notify: false });
  }

  async maybeMigrateLegacyCachesToCloud(id, serverRecovery, session) {
    const legacy = this.readLegacyLocalCaches(id);
    const migration = planLegacyRecoveryMigration(serverRecovery, legacy);
    if (!migration) return null;

    const payload = {
      ...buildBrowserSessionPayload(
        {
          id,
          pages: serverRecovery.pages,
          state: serverRecovery.state,
          history: migration.history,
          credentials: migration.credentials,
          recoveryRevision: 0,
        },
        1
      ),
      localMigrationVersion: 1,
    };
    let stage = null;
    let dispatched = false;
    let definitiveRejection = false;
    try {
      stage = this._stageRecoveryOutbox(id, payload, session.userId);
      dispatched = true;
      const response = await axios.post(
        `${getApiBaseUrl()}/browsers/update_session`,
        this._sessionPayloadWithLease(payload),
        {
          timeout: 10_000,
          headers: {
            'Content-Type': 'application/json',
            Authorization: session.token,
          },
        }
      );
      if (response.data?.code !== 0) {
        definitiveRejection = true;
        if (/revision|conflict|版本|冲突|其他设备/i.test(String(response.data?.message || ''))) {
          ipcEmitter.emitBrowserRecoveryConflict(id);
        }
        throw new Error(response.data?.message || '旧本地缓存迁移被服务端拒绝');
      }
      const nextRevision = Number(response.data?.data?.recoveryRevision);
      if (!validateRecoveryReplayRevision(0, nextRevision)) {
        throw new Error('旧本地缓存迁移未获得有效版本');
      }
      if (!this.recoveryOutbox.removeIfSequence(id, stage.write.sequence, session.userId)) {
        throw new Error('旧本地缓存迁移完成时待同步序列已变化');
      }
      this.clearLegacyLocalCaches(id);
      return { ...payload, recoveryRevision: nextRevision };
    } catch (error) {
      const sequence = stage?.write?.sequence || error.outboxSequence;
      if ((!dispatched || definitiveRejection) && sequence) {
        try {
          this._restoreRecoveryMarkersAfterRejectedAttempt(
            id,
            session.userId,
            sequence,
            stage || error.recoveryStage
          );
        } catch (rollbackError) {
          error.blocksClose = true;
          browserLogger.error(`实例 ${id} 旧缓存迁移证据回滚失败: ${rollbackError.message}`);
        }
      }
      error.recoverySnapshotRetained = Boolean(
        this.recoveryOutbox.getMetadata(id, session.userId)?.sequence === sequence
      );
      this._emitRecoveryFailure(id, {
        retained: error.recoverySnapshotRetained,
        critical: true,
        message: error.message,
      });
      throw error;
    }
  }

  async replayRecoveryOutboxBeforeLaunch(id, serverRecovery, capability, session) {
    assertInstanceId(id);
    const { token, userId: ownerId } = session;
    const serverRevision = Number(serverRecovery?.recoveryRevision);
    let emergency = this.recoveryEmergencySentinel.get(id, ownerId);
    if (emergency) {
      const emergencyEntry = this.recoveryOutbox.getMetadata(id, ownerId);
      if (emergencyEntry?.sequence === emergency.sequence) {
        this.recoveryOutbox.read(id, ownerId);
        this.recoveryEmergencySentinel.clearIfSequence(id, emergency.sequence, ownerId);
        emergency = null;
      } else {
        this._emitRecoveryFailure(id, {
          retained: false,
          critical: true,
          message: '系统安全存储故障期间留有未完整快照',
        });
        throw new Error('本机恢复快照未能加密保存，请先修复系统安全存储');
      }
    }

    let metadata = this.recoveryOutbox.getMetadata(id, ownerId);
    const dirtyMarker = this.recoveryOutbox.getDirtyMarker(id, ownerId);
    if (dirtyMarker) {
      if (!metadata || metadata.sequence !== dirtyMarker.sequence) {
        this._emitRecoveryFailure(id, {
          retained: false,
          critical: true,
          message: '存在未形成加密载荷的 dirty marker',
        });
        throw new Error('本机最新恢复数据未能加密保存，已阻止使用旧云端快照');
      }
      // 崩溃可能发生在 entry 已落盘、marker 未清理之间。先验证可解密
      // 的完整载荷，再清 marker。
      this.recoveryOutbox.read(id, ownerId);
      this.recoveryOutbox.clearDirtyIfSequence(id, dirtyMarker.sequence, ownerId);
      metadata = this.recoveryOutbox.getMetadata(id, ownerId);
    }
    const decision = decideRecoveryOutboxReplay({
      hasPendingEntry: Boolean(metadata),
      cloudRecoveryVersion: capability,
      expectedRevision: metadata?.expectedRevision,
      serverRevision,
    });
    if (decision.action === 'none') return null;
    if (decision.action === 'block') {
      if (decision.reason === 'conflict') ipcEmitter.emitBrowserRecoveryConflict(id);
      this._emitRecoveryFailure(id, { retained: true, critical: true });
      const message =
        decision.reason === 'conflict'
          ? '本机待同步快照与云端版本冲突，已阻止启动并保留本地数据'
          : '本机存在 v1 待同步快照，当前无法安全重放，已阻止启动';
      throw new Error(message);
    }

    try {
      const pending = this.recoveryOutbox.read(id, ownerId);
      if (!pending || pending.sequence !== metadata.sequence) {
        throw new Error('待同步快照在启动过程中已变化');
      }

      if (decision.action === 'verify-committed') {
        if (!areRecoverySnapshotsEquivalent(pending.payload, serverRecovery)) {
          ipcEmitter.emitBrowserRecoveryConflict(id);
          throw new Error('本机待同步快照与更新后的云端内容不一致，已阻止启动');
        }
        if (!this.recoveryOutbox.removeIfSequence(id, pending.sequence, ownerId)) {
          throw new Error('确认已提交时发现更新的待同步快照');
        }
        if (pending.payload.localMigrationVersion === 1) this.clearLegacyLocalCaches(id);
        this._detachedRecoveryRevisions.set(id, serverRevision);
        this._detachedRecoveryReady.add(id);
        this._detachedRecoveryOwners.set(id, ownerId);
        return {
          payload: pending.payload,
          recoveryRevision: serverRevision,
          alreadyCommitted: true,
        };
      }

      const payload = buildBrowserSessionPayload(pending.payload, 1);
      if (payload.recoveryRevision !== pending.expectedRevision) {
        throw new Error('待同步快照版本校验失败');
      }

      const response = await axios.post(
        `${getApiBaseUrl()}/browsers/update_session`,
        this._sessionPayloadWithLease(payload),
        {
          timeout: 10_000,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: token } : {}),
          },
        }
      );
      if (response.data?.code !== 0) {
        if (/revision|conflict|版本|冲突|其他设备/i.test(String(response.data?.message || ''))) {
          ipcEmitter.emitBrowserRecoveryConflict(id);
        }
        throw new Error(response.data?.message || '服务端拒绝重放待同步快照');
      }

      const nextRevision = Number(response.data?.data?.recoveryRevision);
      if (!validateRecoveryReplayRevision(pending.expectedRevision, nextRevision)) {
        throw new Error('服务端未返回有效的恢复版本');
      }
      if (!this.recoveryOutbox.removeIfSequence(id, pending.sequence, ownerId)) {
        throw new Error('重放完成时发现更新的待同步快照，已阻止启动');
      }
      if (pending.payload.localMigrationVersion === 1) this.clearLegacyLocalCaches(id);
      this._detachedRecoveryRevisions.set(id, nextRevision);
      this._detachedRecoveryReady.add(id);
      this._detachedRecoveryOwners.set(id, ownerId);
      browserLogger.info(`实例 ${id} 待同步恢复快照重放成功`);
      return { payload: pending.payload, recoveryRevision: nextRevision };
    } catch (error) {
      this._emitRecoveryFailure(id, { retained: true, critical: true, message: error.message });
      browserLogger.warn(`实例 ${id} 待同步快照重放失败: ${error.message}`);
      throw error;
    }
  }

  createDetachedRecoveryManagers(id, recovery = {}, ownerId) {
    assertInstanceId(id);
    const owner = normalizeRecoveryOwnerId(ownerId);
    const historyManager = new HistoryManager(id, { ownerId: owner });
    const credentialManager = new CredentialManager(id, { ownerId: owner });
    const remoteRevision = Number(recovery?.recoveryRevision ?? recovery?.recovery_revision ?? 0);
    const cachedRevision = this._detachedRecoveryRevisions.get(id);
    const cachedOwner = this._detachedRecoveryOwners.get(id);
    if (cachedOwner && cachedOwner !== owner) {
      this._detachedRecoveryReady.delete(id);
      this._detachedRecoveryRevisions.delete(id);
      this._detachedRecoveryOwners.delete(id);
    }
    const shouldImportRemote =
      Number.isSafeInteger(remoteRevision) &&
      remoteRevision >= 0 &&
      (cachedOwner !== owner ||
        !Number.isSafeInteger(cachedRevision) ||
        remoteRevision > cachedRevision ||
        !this._detachedRecoveryReady.has(id));

    if (shouldImportRemote) {
      const hasCompleteRemoteCaches =
        Array.isArray(recovery.history) && Array.isArray(recovery.credentials);
      if (!hasCompleteRemoteCaches) {
        this._detachedRecoveryReady.delete(id);
        this._detachedRecoveryRevisions.delete(id);
        this._detachedRecoveryOwners.delete(id);
        if (normalizeCloudRecoveryVersion(recovery?.cloudRecoveryVersion) >= 1) {
          throw new Error('云端恢复数据不完整，已阻止使用本地陈旧缓存');
        }
        return { historyManager, credentialManager };
      }

      // 先完成 safeStorage 加密；失败时不保留远端 revision/ready 状态。
      this._detachedRecoveryReady.delete(id);
      this._detachedRecoveryRevisions.delete(id);
      this._detachedRecoveryOwners.delete(id);
      credentialManager.importEntries(recovery.credentials);
      historyManager.importEntries(recovery.history);
      this._detachedRecoveryReady.add(id);
      this._detachedRecoveryRevisions.set(id, remoteRevision);
      this._detachedRecoveryOwners.set(id, owner);
    }
    return { historyManager, credentialManager };
  }

  async loadDetachedRecoveryManagers(id) {
    this._assertSessionOperationsAllowed();
    return this._runRecoveryChain(assertInstanceId(id), async () => {
      const session = await this._getCurrentSession();
      const capability = await this._getCloudRecoveryVersion(session.token, session.userId);
      return this._loadDetachedRecoveryManagersNow(id, session, capability);
    });
  }

  async _loadDetachedRecoveryManagersNow(id, session, capability) {
    if (this.recoveryOutbox.getDeletionIntent(id, session.userId)) {
      throw new Error('该浏览器的服务端删除结果待确认，已阻止恢复读写');
    }
    const active = this.instances.get(id);
    if (active) {
      if (active.ownerId !== session.userId) {
        throw new Error('运行中浏览器属于其他登录用户，已阻止读取');
      }
      return {
        historyManager: active.historyManager,
        credentialManager: active.credentialManager,
        recovery: active.getSnapshot(),
      };
    }

    if (this._unsafeClosedInstances.has(id)) {
      await this._retryUnsafeClosedRecoveryNow(id, session.userId);
    }

    if (capability < 1) {
      if (
        this.recoveryOutbox.getMetadata(id, session.userId) ||
        this.recoveryOutbox.getDirtyMarker(id, session.userId) ||
        this.recoveryEmergencySentinel.get(id, session.userId)
      ) {
        throw new Error('本机存在 v1 待同步快照，已阻止用旧协议读写本地缓存');
      }
      const legacyRecovery = await this.fetchLegacyBrowserRecovery(id, session.token);
      this.migrateLegacyLocalCachesToOwner(id, session.userId);
      return {
        ...this.createDetachedRecoveryManagers(id, {}, session.userId),
        recovery: {
          pages: legacyRecovery.pages,
          state: legacyRecovery.state,
          recoveryRevision: 0,
          cloudRecoveryVersion: 0,
          ownerId: session.userId,
        },
      };
    }

    const serverRecovery = await this.fetchBrowserRecovery(id, session.token);
    const replayed = await this.replayRecoveryOutboxBeforeLaunch(
      id,
      serverRecovery,
      capability,
      session
    );
    const migrated = replayed
      ? null
      : await this.maybeMigrateLegacyCachesToCloud(id, serverRecovery, session);
    const recovered = replayed?.payload || migrated || serverRecovery;
    const recovery = {
      ...recovered,
      recoveryRevision:
        replayed?.recoveryRevision ?? migrated?.recoveryRevision ?? serverRecovery.recoveryRevision,
      cloudRecoveryVersion: 1,
      ownerId: session.userId,
    };
    return {
      ...this.createDetachedRecoveryManagers(id, recovery, session.userId),
      recovery,
    };
  }

  async persistDetachedRecovery(id, historyManager, credentialManager, recovery = {}) {
    this._assertSessionOperationsAllowed();
    return this._runRecoveryChain(assertInstanceId(id), async () => {
      if (this._unsafeClosedInstances.has(id)) {
        throw new Error('该浏览器仍有仅存内存的未落盘快照，已阻止使用旧缓存写入');
      }
      const session = await this._getCurrentSession();
      const capability = await this._getCloudRecoveryVersion(session.token, session.userId);
      return this._persistDetachedRecoveryNow(
        id,
        historyManager,
        credentialManager,
        recovery,
        session,
        capability
      );
    });
  }

  async withDetachedRecoveryMutation(id, mutate) {
    this._assertSessionOperationsAllowed();
    return this._runRecoveryChain(assertInstanceId(id), async () => {
      const session = await this._getCurrentSession();
      const capability = await this._getCloudRecoveryVersion(session.token, session.userId);
      const loaded = await this._loadDetachedRecoveryManagersNow(id, session, capability);
      return mutate({
        ...loaded,
        persist: () =>
          this._persistDetachedRecoveryNow(
            id,
            loaded.historyManager,
            loaded.credentialManager,
            loaded.recovery,
            session,
            capability
          ),
      });
    });
  }

  /** 将 active/detached 的 load→mutate→stage→POST→ACK/回滚放在同一 ID 串行链。 */
  async mutateRecoveryCaches(id, reason, mutate) {
    this._assertSessionOperationsAllowed();
    return this._runRecoveryChain(assertInstanceId(id), async () => {
      if (this.closingInstances.has(id) || this.launchingInstances.has(id)) {
        throw new Error('浏览器正在启动或关闭，请稍后再修改恢复数据');
      }
      const session = await this._getCurrentSession();
      const instance = this.instances.get(id);
      let loaded;
      let capability;
      if (instance) {
        if (instance.ownerId !== session.userId) {
          throw new Error('该运行中浏览器不属于当前登录用户');
        }
        loaded = {
          historyManager: instance.historyManager,
          credentialManager: instance.credentialManager,
          recovery: instance.getSnapshot(),
        };
      } else {
        capability = await this._getCloudRecoveryVersion(session.token, session.userId);
        loaded = await this._loadDetachedRecoveryManagersNow(id, session, capability);
      }

      const mutation = await mutate({ ...loaded, active: Boolean(instance) });
      if (!mutation || typeof mutation.rollback !== 'function') {
        throw new Error('恢复缓存操作未提供可回滚状态');
      }
      try {
        const persisted = instance
          ? await this._persistSnapshotNow(instance.getSnapshot(), reason, {
              rollbackOutboxOnFailure: true,
            })
          : await this._persistDetachedRecoveryNow(
              id,
              loaded.historyManager,
              loaded.credentialManager,
              loaded.recovery,
              session,
              capability
            );
        if (instance) instance.markRecoveryChanged(reason, { notify: false });
        return { success: true, ...persisted };
      } catch (error) {
        if (!error.preserveLocalMutation) {
          try {
            await mutation.rollback();
          } catch (rollbackError) {
            const expectedRevision = instance
              ? instance.recoveryRevision
              : (this._detachedRecoveryRevisions.get(id) ??
                Number(loaded.recovery?.recoveryRevision ?? 0));
            let markerPersisted = false;
            try {
              this._recordDirtyWithoutPayload(
                id,
                expectedRevision,
                session.userId,
                'mutation-rollback-failed'
              );
              markerPersisted = true;
            } catch (markerError) {
              error.cause = markerError;
            }
            error.preserveLocalMutation = true;
            error.blocksClose = true;
            error.recoverySnapshotRetained = false;
            error.message = markerPersisted
              ? `服务端保存失败且本地回滚未完成，已标记为待修复：${rollbackError.message}`
              : `服务端保存失败且本地回滚未完成，无法写入安全标记：${rollbackError.message}`;
            this._emitRecoveryFailure(id, {
              retained: false,
              critical: true,
              message: error.message,
            });
          }
        }
        throw error;
      }
    });
  }

  async _persistDetachedRecoveryNow(
    id,
    historyManager,
    credentialManager,
    recovery,
    session,
    capability
  ) {
    const { token, userId: ownerId } = session;
    if (capability < 1) {
      if (
        this.recoveryOutbox.getMetadata(id, ownerId) ||
        this.recoveryOutbox.getDirtyMarker(id, ownerId) ||
        this.recoveryEmergencySentinel.get(id, ownerId)
      ) {
        throw new Error('本机存在 v1 待同步快照，已阻止用旧协议修改');
      }
      return { recoveryRevision: 0, cloudPersisted: false };
    }
    if (!this._detachedRecoveryReady.has(id) || this._detachedRecoveryOwners.get(id) !== ownerId) {
      throw new Error('云端恢复数据未完整加载，请刷新窗口列表后重试');
    }

    const fallbackRevision = Number(recovery?.recoveryRevision ?? recovery?.recovery_revision ?? 0);
    const expectedRevision = this._detachedRecoveryRevisions.get(id) ?? fallbackRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('恢复版本格式无效，请刷新窗口列表后重试');
    }

    const payload = buildBrowserSessionPayload(
      {
        id,
        pages: Array.isArray(recovery?.pages) ? recovery.pages : [],
        state: recovery?.state ?? null,
        history: historyManager.exportEntries(),
        credentials: credentialManager.exportEntries(),
        recoveryRevision: expectedRevision,
      },
      1
    );
    const previousOutboxEntry = this.recoveryOutbox.getRawEntry(id, ownerId);
    let outboxStage = null;
    let requestDispatched = false;
    let definitiveRejection = false;
    try {
      outboxStage = this._stageRecoveryOutbox(id, payload, ownerId);
      requestDispatched = true;
      const response = await axios.post(
        `${getApiBaseUrl()}/browsers/update_session`,
        this._sessionPayloadWithLease(payload),
        {
          timeout: 10_000,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: token } : {}),
          },
        }
      );
      if (response.data?.code !== 0) {
        definitiveRejection = true;
        if (/revision|conflict|版本|冲突|其他设备/i.test(String(response.data?.message || ''))) {
          ipcEmitter.emitBrowserRecoveryConflict(id);
        }
        throw new Error(response.data?.message || '恢复数据保存失败');
      }
      const nextRevision = Number(response.data?.data?.recoveryRevision);
      if (!validateRecoveryReplayRevision(expectedRevision, nextRevision)) {
        throw new Error('服务端未返回有效的恢复版本');
      }
      this._detachedRecoveryRevisions.set(id, nextRevision);
      this._detachedRecoveryOwners.set(id, ownerId);
      if (!this.recoveryOutbox.removeIfSequence(id, outboxStage.write.sequence, ownerId)) {
        throw new Error('保存完成时发现更新的待同步快照');
      }
      return { recoveryRevision: nextRevision, cloudPersisted: true };
    } catch (error) {
      const attemptSequence = outboxStage?.write?.sequence || error.outboxSequence;
      if ((!requestDispatched || definitiveRejection) && attemptSequence) {
        try {
          this._restoreRecoveryMarkersAfterRejectedAttempt(id, ownerId, attemptSequence, {
            ...(outboxStage || error.recoveryStage || {}),
            previousEntry: outboxStage?.previousEntry ?? previousOutboxEntry,
          });
        } catch (rollbackError) {
          error.preserveLocalMutation = true;
          error.blocksClose = true;
          browserLogger.error(`实例 ${id} detached 恢复证据回滚失败: ${rollbackError.message}`);
        }
      } else if (requestDispatched && !definitiveRejection) {
        error.preserveLocalMutation = true;
        error.recoveryOutcomeUnknown = true;
      }
      let retained = false;
      try {
        retained = this.recoveryOutbox.getMetadata(id, ownerId)?.sequence === attemptSequence;
      } catch {}
      error.recoverySnapshotRetained = retained;
      this._emitRecoveryFailure(id, {
        retained,
        critical: Boolean(error.blocksClose || !retained),
        message: error.message,
      });
      throw error;
    }
  }

  /**
   * 获取当前用户 token
   */
  async _getToken() {
    try {
      if (
        ipcEmitter.mainWindow &&
        !ipcEmitter.mainWindow.isDestroyed() &&
        ipcEmitter.mainWindow.webContents &&
        !ipcEmitter.mainWindow.webContents.isDestroyed()
      ) {
        const token = await ipcEmitter.mainWindow.webContents.executeJavaScript(
          'localStorage.getItem("token") || ""',
          true
        );
        if (token) return token;
      }
    } catch {}
    // 主窗口先关闭时 renderer 已不可用；仅回退到本会话中已通过
    // /users/current 确认且尚未冻结的内存 token，以完成最后一次云同步。
    if (this._sessionCache?.token && this._frozenToken !== this._sessionCache.token) {
      return this._sessionCache.token;
    }
    return '';
  }

  async getOwnedActiveInstance(id) {
    this._assertSessionOperationsAllowed();
    assertInstanceId(id);
    const instance = this.instances.get(id);
    if (!instance) return null;
    const session = await this._getCurrentSession();
    if (instance.ownerId !== session.userId) {
      throw new Error('该运行中浏览器不属于当前登录用户');
    }
    return instance;
  }

  async prepareSessionLogout() {
    const token = await this._getToken();
    if (
      this._sessionTransitioning &&
      (!this._frozenToken || !token || this._frozenToken === token)
    ) {
      throw new Error('登录会话正在切换');
    }
    // 上次退出已完成后，重新登录可能只发出 renderer 请求，尚未调用浏览器 IPC。
    // 新 token 可以开始下一次收口；正在收口或旧 token 仍然保持封锁。
    this._frozenToken = '';
    this._sessionTransitioning = true;
    try {
      let ownerId = this._sessionCache?.token === token ? this._sessionCache.userId : null;
      if (!ownerId) {
        try {
          ownerId = (await this._getCurrentSession(token)).userId;
        } catch {
          const activeOwners = new Set(
            [
              ...Array.from(this.instances.values()).map(instance => instance.ownerId),
              ...Array.from(this._unsafeClosedInstances.values()).map(record => record.ownerId),
            ].filter(Boolean)
          );
          if (activeOwners.size > 1) throw new Error('运行中实例的用户归属不一致');
          ownerId = activeOwners.values().next().value || null;
        }
      }

      const launches = Array.from(this.launchingInstances.values());
      if (ownerId && launches.some(promise => promise.ownerId !== ownerId)) {
        throw new Error('检测到其他用户的启动中实例，已阻止清理当前 token');
      }
      // 封门后不再允许新启动；先等已有 launch 收敛，再重新枚举并关闭实例。
      await Promise.all(launches.map(promise => promise.catch(() => null)));

      const activeInstances = Array.from(this.instances.values());
      if (ownerId && activeInstances.some(instance => instance.ownerId !== ownerId)) {
        throw new Error('检测到其他用户的运行中实例，已阻止清理当前 token');
      }
      const ids = activeInstances.map(instance => instance.id);
      for (const id of ids) await this.closeInstance(id);
      await this._retryUnsafeClosedRecoveries(ownerId);
      await Promise.all(Array.from(this._backgroundCleanupPromises.values()));
      await Promise.all(
        Array.from(this._persistChains.values()).map(chain => chain.catch(() => {}))
      );
      if (ids.some(id => this.instances.has(id)) || this._unsafeClosedInstances.size > 0) {
        throw new Error('仍有浏览器数据未能安全收口');
      }

      this._detachedRecoveryReady.clear();
      this._detachedRecoveryRevisions.clear();
      this._detachedRecoveryOwners.clear();
      this._cloudRecoveryCapability = { status: 'unknown', version: 0, expiresAt: 0 };
      this._sessionCache = null;
      this._frozenToken = token;
      if (!token) this._sessionTransitioning = false;
      return true;
    } catch (error) {
      this._sessionTransitioning = false;
      throw error;
    }
  }

  async _retryUnsafeClosedRecoveryNow(id, ownerId) {
    const retained = this._unsafeClosedInstances.get(id);
    if (!retained) return false;
    if (retained.ownerId !== normalizeRecoveryOwnerId(ownerId)) {
      throw new Error('未落盘恢复数据属于其他用户，已阻止重试');
    }

    let secured = false;
    try {
      await retained.instance.captureStoppedPortableProfile({ notify: false });
      await this._ensureStoppedRuntimeLease(retained.instance);
      const saved = await this._persistSnapshotNow(
        retained.instance.getSnapshot(),
        'unsafe-close-retry'
      );
      retained.instance.recoveryRevision = saved.recoveryRevision;
      await this._releaseRuntimeLeaseAfterStopped(
        id,
        ownerId,
        saved.recoveryRevision,
        retained.instance,
        true
      );
      secured = true;
    } catch (error) {
      // 网络结果未知但完整加密 outbox 已落盘时，内存快照可安全释放。
      if (error.recoverySnapshotRetained) secured = true;
      else throw error;
    }
    if (secured && this._unsafeClosedInstances.get(id) === retained) {
      this._unsafeClosedInstances.delete(id);
      retained.instance.cleanupFinal();
    }
    return secured;
  }

  async _retryUnsafeClosedRecoveries(ownerId) {
    const owner =
      ownerId === null || ownerId === undefined ? null : normalizeRecoveryOwnerId(ownerId);
    for (const [id, retained] of Array.from(this._unsafeClosedInstances.entries())) {
      if (owner && retained.ownerId !== owner) {
        throw new Error('存在其他用户未落盘的恢复数据，已阻止安全收口');
      }
      await this._runRecoveryChain(id, () =>
        this._retryUnsafeClosedRecoveryNow(id, retained.ownerId)
      );
    }
  }

  hasPendingRecoveryWork() {
    return (
      this.instances.size > 0 ||
      this.launchingInstances.size > 0 ||
      this.closePromises.size > 0 ||
      this._backgroundCleanupPromises.size > 0 ||
      this.closingInstances.size > 0 ||
      this._persistChains.size > 0 ||
      this._unsafeClosedInstances.size > 0
    );
  }

  async prepareAppQuit() {
    if (this._sessionTransitioning) throw new Error('登录会话正在切换，已阻止退出');
    this._sessionTransitioning = true;
    try {
      await Promise.all(
        Array.from(this.launchingInstances.values()).map(promise => promise.catch(() => null))
      );
      for (const id of this.getInstanceIds()) await this.closeInstance(id);

      const ownerId = this._sessionCache?.userId || null;
      if (this._unsafeClosedInstances.size > 0) {
        if (!ownerId) throw new Error('无法确认未落盘恢复数据的用户归属');
        await this._retryUnsafeClosedRecoveries(ownerId);
      }
      await Promise.all(Array.from(this._backgroundCleanupPromises.values()));

      // 无活动窗口时也可能有 detached 历史/凭据写队列，必须等待收敛。
      while (this._persistChains.size > 0) {
        await Promise.all(Array.from(this._persistChains.values()));
      }
      if (this.hasPendingRecoveryWork()) {
        throw new Error('仍有恢复数据未能安全收口');
      }
      return true;
    } catch (error) {
      this._sessionTransitioning = false;
      throw error;
    }
  }

  async deleteBrowserAndCleanup(id) {
    this._assertSessionOperationsAllowed();
    return this._runRecoveryChain(assertInstanceId(id), async () => {
      if (
        this.instances.has(id) ||
        this.launchingInstances.has(id) ||
        this.closingInstances.has(id) ||
        this._unsafeClosedInstances.has(id)
      ) {
        throw new Error('浏览器实例仍在运行或关闭中，无法删除');
      }
      const session = await this._getCurrentSession();
      const intent = this.recoveryOutbox.stageDeletionIntent(id, session.userId);
      let deleteError = null;
      let deletionConfirmed = false;
      let definitiveRejection = false;
      try {
        const response = await axios.post(
          `${getApiBaseUrl()}/browsers/delete`,
          { id },
          {
            timeout: 10_000,
            headers: {
              'Content-Type': 'application/json',
              Authorization: session.token,
            },
          }
        );
        if (response.data?.code === 0) deletionConfirmed = true;
        else {
          definitiveRejection = true;
          deleteError = new Error(response.data?.message || '服务端拒绝删除浏览器');
        }
      } catch (error) {
        deleteError = error;
      }

      if (!deletionConfirmed) {
        try {
          deletionConfirmed = await this._isBrowserAbsentForCurrentUser(id, session);
          if (!deletionConfirmed && definitiveRejection) {
            this.recoveryOutbox.clearDeletionIntentIfSequence(id, intent.sequence, session.userId);
          }
        } catch {
          // 删除 POST 可能已提交但响应丢失：查询也失败时保留意图，不清本地数据。
        }
      }
      if (!deletionConfirmed) {
        throw new Error(
          definitiveRejection
            ? deleteError?.message || '服务端拒绝删除浏览器'
            : '删除结果未知，已保留本地数据，请稍后重试确认'
        );
      }

      this.recoveryOutbox.delete(id, session.userId);
      const emergency = this.recoveryEmergencySentinel.get(id, session.userId);
      if (emergency) {
        this.recoveryEmergencySentinel.clearIfSequence(id, emergency.sequence, session.userId);
      }
      new HistoryManager(id, { ownerId: session.userId }).clear({ notify: false });
      new CredentialManager(id, { ownerId: session.userId }).clear({ notify: false });
      // 服务端已确认当前 owner 拥有该 ID，此时才可清除升级前的旧名缓存。
      new HistoryManager(id).clear({ notify: false });
      new CredentialManager(id).clear({ notify: false });
      removeOwnedBrowserProfiles(getAppPath(), id, session.userId);
      if (!this.recoveryOutbox.clearDeletionIntentIfSequence(id, intent.sequence, session.userId)) {
        throw new Error('删除完成时本地删除意图序列已变化');
      }
      this._detachedRecoveryRevisions.delete(id);
      this._detachedRecoveryReady.delete(id);
      this._detachedRecoveryOwners.delete(id);
      browserLogger.info(`实例 ${id} 已从服务端删除，本地恢复缓存与 outbox 已清理`);
      return true;
    });
  }

  async _isBrowserAbsentForCurrentUser(id, session) {
    const response = await axios.post(
      `${getApiBaseUrl()}/browsers/search`,
      { page: 1, size: 200, includeRecovery: false },
      {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: session.token,
        },
      }
    );
    if (response.data?.code !== 0 || !Array.isArray(response.data?.data?.list)) {
      throw new Error('服务端未能确认删除结果');
    }
    return !response.data.data.list.some(item => item?.browser_id === id || item?.id === id);
  }

  /**
   * 处理实例状态变更（由 BrowserInstance 的页面事件回调触发）
   * 使用防抖避免高频保存
   * @param {BrowserInstance} instance
   * @param {string} reason
   */
  handleInstanceStateChanged(instance, reason) {
    const id = instance.id;

    // 启动恢复完成前的 page/load 事件只是部分快照，不得覆盖云端。
    // launch 完成后 ensureCurrentPagesInHistory 会再触发一次正常保存。
    if (
      !instance.startupReady ||
      this.launchingInstances.has(id) ||
      this.closingInstances.has(id)
    ) {
      return;
    }

    // all-tabs-closed 由生命周期检查触发，需要立即持久化
    if (reason === 'all-tabs-closed') {
      const snapshot = instance.getSnapshot();
      this.persistSnapshot(snapshot, reason).catch(() => {});
      return;
    }

    // 其他事件使用防抖
    if (instance.isClosing) return;

    // 清除该实例的旧定时器
    if (this._saveTimers.has(id)) {
      clearTimeout(this._saveTimers.get(id));
    }

    // 防抖 800ms
    const timer = setTimeout(async () => {
      this._saveTimers.delete(id);
      // 再次检查实例状态
      if (
        !instance.startupReady ||
        this.launchingInstances.has(id) ||
        instance.isClosing ||
        this.closingInstances.has(id)
      ) {
        return;
      }
      if (!this.instances.has(id)) return;

      try {
        const snapshot = instance.getSnapshot();
        browserLogger.info(`[${reason}] 触发状态保存: ${id} (${snapshot.pages.length} 个页面)`);
        await this.persistSnapshot(snapshot, reason);
      } catch (error) {
        browserLogger.error(`[${reason}] 状态保存失败: ${id}, ${error.message}`);
      }
    }, 800);

    this._saveTimers.set(id, timer);
  }

  /**
   * 创建或获取浏览器实例
   * @param {Object} createBrowserData - 浏览器配置数据
   * @returns {Promise<BrowserInstance>} 浏览器实例
   */
  async createBrowserInstance(createBrowserData) {
    const id = assertInstanceId(createBrowserData?.id);
    this._assertSessionOperationsAllowed();
    const session = await this._getCurrentSession();
    if (this.recoveryOutbox.getDeletionIntent(id, session.userId)) {
      throw new Error('该浏览器的服务端删除结果待确认，请先重试删除');
    }
    if (this._sessionTransitioning) {
      throw new Error('正在切换登录会话，请稍后再打开浏览器');
    }
    const pendingLaunch = this.launchingInstances.get(id);
    if (pendingLaunch) {
      if (pendingLaunch.ownerId !== session.userId) {
        throw new Error('该浏览器正由其他登录用户启动，已阻止复用');
      }
      browserLogger.info(`实例 ${id} 正在启动，复用当前请求`);
      return pendingLaunch;
    }

    const launchPromise = this._createBrowserInstance(createBrowserData, session);
    launchPromise.ownerId = session.userId;
    this.launchingInstances.set(id, launchPromise);
    let launchedInstance = null;
    try {
      launchedInstance = await launchPromise;
      return launchedInstance;
    } finally {
      if (this.launchingInstances.get(id) === launchPromise) {
        this.launchingInstances.delete(id);
      }
      if (launchedInstance?.startupReady && this.instances.get(id) === launchedInstance) {
        this.handleInstanceStateChanged(launchedInstance, 'startup-ready');
      }
    }
  }

  async _createBrowserInstance(createBrowserData, confirmedSession) {
    const { id: rawId, cloudRecoveryVersion: requestedRecoveryVersion } = createBrowserData || {};
    const id = assertInstanceId(rawId);

    browserLogger.info(`处理浏览器实例: ${id}`);

    // 如果实例正在关闭中，等待关闭完成
    if (this.closingInstances.has(id)) {
      browserLogger.info(`实例 ${id} 正在关闭中，等待完成...`);
      await this.waitForInstanceClose(id);
    }

    // 如果实例已存在且正在运行，直接返回
    if (this.instances.has(id)) {
      const existingInstance = this.instances.get(id);
      if (Number(existingInstance.ownerId) !== Number(confirmedSession.userId)) {
        throw new Error('该运行中浏览器属于其他登录用户，已阻止复用');
      }
      if (
        !existingInstance.isClosing &&
        existingInstance.context &&
        !existingInstance._runtimeLeaseLost &&
        this.runtimeLeases.valid(id)
      ) {
        browserLogger.info(`实例 ${id} 已存在且正在运行`);
        return existingInstance;
      }
      // The UI stops reporting a closing instance before Chromium releases its
      // profile lock. Finish its lifecycle and recovery write before relaunch.
      if (existingInstance.context) {
        await closeContextWithTimeout(existingInstance.context);
        if (this.closingInstances.has(id)) await this.waitForInstanceClose(id);
        const cleanup = this._backgroundCleanupPromises.get(id);
        if (cleanup) await cleanup;
      }
      // 实例存在但已关闭，先清理
      this.instances.delete(id);
    }

    // 启动恢复决策与 detached 读写共用同一 ID 串行链，防止重放与密码修改并发。
    const session = confirmedSession;
    let instance;
    try {
      instance = await this._runRecoveryChain(id, async () => {
        if (this._unsafeClosedInstances.has(id)) {
          await this._retryUnsafeClosedRecoveryNow(id, session.userId);
        }
        const negotiatedRecoveryVersion = await this._getCloudRecoveryVersion(
          session.token,
          session.userId
        );
        if (normalizeCloudRecoveryVersion(requestedRecoveryVersion) > negotiatedRecoveryVersion) {
          browserLogger.warn('渲染进程恢复能力高于主进程已确认能力，已以主进程为准');
        }
        if (negotiatedRecoveryVersion < 1)
          throw new Error('服务端需升级云端恢复与浏览器互锁后才能打开');
        const lease = await this.runtimeLeases.acquire(id, session.userId);
        const serverRecovery = parseBrowserRecoveryResponse(lease.recovery);
        this._detachedRecoveryRevisions.set(id, serverRecovery.recoveryRevision);
        const freshConfig = JSON.parse(lease.config);
        if (!freshConfig?.base?.name) throw new Error('启动前服务端配置刷新失败');
        const serverRevision = Number(serverRecovery.recoveryRevision ?? 0);
        if (
          negotiatedRecoveryVersion >= 1 &&
          (!Number.isSafeInteger(serverRevision) || serverRevision < 0)
        ) {
          throw new Error('云端恢复版本格式无效，已阻止启动');
        }
        const replayed = await this.replayRecoveryOutboxBeforeLaunch(
          id,
          serverRecovery,
          negotiatedRecoveryVersion,
          session
        );
        const migrated =
          negotiatedRecoveryVersion >= 1 && !replayed
            ? await this.maybeMigrateLegacyCachesToCloud(id, serverRecovery, session)
            : null;
        const recovered = replayed?.payload || migrated || serverRecovery;
        const prepared = new BrowserInstance(id, freshConfig, recovered.pages, recovered.state, {
          history: recovered.history,
          credentials: recovered.credentials,
          recoveryRevision:
            replayed?.recoveryRevision ?? migrated?.recoveryRevision ?? serverRevision,
          cloudRecoveryVersion: negotiatedRecoveryVersion,
          ownerId: session.userId,
        });
        this.instances.set(id, prepared);
        return prepared;
      });
    } catch (error) {
      await this._releaseRuntimeLeaseAfterStopped(
        id,
        session.userId,
        this._detachedRecoveryRevisions.get(id)
      ).catch(() => {});
      throw error;
    }

    // 绑定状态变更回调
    instance.onStateChanged = (inst, reason) => {
      this.handleInstanceStateChanged(inst, reason);
    };

    try {
      // 启动浏览器
      await instance.launch();
      if (!instance.startupReady) {
        throw new Error('浏览器初始页面尚未准备完成，已阻止启动');
      }
      if (!this.runtimeLeases.valid(id)) throw new Error('启动期间运行锁失效，已阻止打开');

      // 绑定浏览器关闭事件（用户手动关闭浏览器窗口的情况）
      this.bindBrowserCloseEvent(instance);

      // 发送浏览器启动状态
      browserLogger.info(`实例 ${id} 启动成功，发送 started 状态`);
      ipcEmitter.emitBrowserStatus(id, 'started');

      return instance;
    } catch (error) {
      // 启动失败可能发生在 Chromium 已启动之后，必须主动回收残留进程。
      this.instances.delete(id);
      instance.isClosing = true;
      instance.clearTimers();
      try {
        if (instance.context) await instance.gracefulClose();
        await instance.forceKillBrowser();
      } catch (cleanupError) {
        browserLogger.warn(`清理启动失败的实例 ${id} 时出错: ${cleanupError.message}`);
      } finally {
        await this._releaseRuntimeLeaseAfterStopped(
          id,
          session.userId,
          instance.recoveryRevision,
          instance
        ).catch(() => {});
        instance.cleanupFinal();
      }
      browserLogger.error(`实例 ${id} 启动失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 等待实例关闭完成
   * @param {string} id - 实例 ID
   * @param {number} timeout - 超时时间（毫秒）
   */
  async waitForInstanceClose(id, timeout = 10000) {
    const startTime = Date.now();
    while (this.closingInstances.has(id) && Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // 超时后强制清除标记
    if (this.closingInstances.has(id)) {
      throw new Error(`实例 ${id} 仍在关闭，请稍后重试`);
    }
  }

  /**
   * 绑定浏览器关闭事件（用户手动关闭浏览器窗口）
   * @param {BrowserInstance} instance - 浏览器实例
   */
  bindBrowserCloseEvent(instance) {
    if (!instance.context) return;

    instance.context.on('close', async () => {
      const id = instance.id;
      browserLogger.info(`检测到浏览器 context close 事件: ${id}`);

      // 如果已经在通过 closeInstance 关闭，跳过
      if (this.closingInstances.has(id)) {
        browserLogger.debug(`实例 ${id} 已在关闭流程中，跳过 context close 事件处理`);
        return;
      }

      // 用户手动关闭浏览器的情况
      browserLogger.info(`用户手动关闭浏览器: ${id}`);

      // 标记为正在关闭
      this.closingInstances.add(id);
      instance.isClosing = true;

      // 取消该实例的防抖保存定时器
      if (this._saveTimers.has(id)) {
        clearTimeout(this._saveTimers.get(id));
        this._saveTimers.delete(id);
      }

      let preserveRecoveryState = false;
      try {
        await this._runRecoveryChain(id, async () => {
          // 先等已入链的显式操作收敛，再取最终检查点和快照。
          const finalCapture = await instance.waitForPendingStorageCapture();
          if (finalCapture.waited && !finalCapture.captured) {
            browserLogger.warn(`实例 ${id} 最终存储采集未完成，使用上次成功检查点`);
          }
          const snapshot = instance.getSnapshot();
          browserLogger.info(`实例 ${id} 使用保留的快照 (${snapshot.pages.length} 个页面)`);
          await this._persistSnapshotNow(snapshot, 'browser-window-closed');
        });
        browserLogger.info(`实例 ${id} 状态已持久化到后端`);
      } catch (error) {
        browserLogger.warn(`实例 ${id} 持久化失败: ${error.message}`);
        if (error.blocksClose || !error.recoverySnapshotRetained) {
          preserveRecoveryState = true;
          this._unsafeClosedInstances.set(id, {
            instance,
            ownerId: normalizeRecoveryOwnerId(instance.ownerId),
          });
          this._emitRecoveryFailure(id, {
            retained: false,
            critical: true,
            message: '最新快照仅保留在本次运行内存中，已阻止安全退出',
          });
        }
      }

      // 只能清理当时绑定的实例。防止极慢的旧 close 回调误删后来启动的同 ID 实例。
      if (this.instances.get(id) === instance) {
        this.instances.delete(id);
        browserLogger.info(`发送 closed 状态: ${id}`);
        ipcEmitter.emitBrowserStatus(id, 'closed');
      }

      // 在后台进行进程清理
      const cleanupPromise = this.cleanupInstanceInBackground(instance, {
        preserveRecoveryState,
      }).finally(() => {
        this.closingInstances.delete(id);
        if (this._backgroundCleanupPromises.get(id) === cleanupPromise) {
          this._backgroundCleanupPromises.delete(id);
        }
        browserLogger.info(`实例 ${id} 后台清理完成`);
      });
      this._backgroundCleanupPromises.set(id, cleanupPromise);
    });
  }

  /**
   * 在后台清理实例资源
   * @param {BrowserInstance} instance - 浏览器实例
   */
  async cleanupInstanceInBackground(instance, { preserveRecoveryState = false } = {}) {
    const savedUserDataDir = instance.userDataDir;
    const savedBrowserPath = instance.browserPath;
    const savedId = instance.id;

    try {
      // 用户手动关闭浏览器，context 已自然退出，等待进程完全退出
      await new Promise(resolve => setTimeout(resolve, 1500));

      // 仅检查是否有残留进程，有则温和清理
      const success = await instance.forceKillBrowserByPaths(
        savedUserDataDir,
        savedBrowserPath,
        savedId
      );
      if (!success) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await instance.forceKillBrowserByPaths(savedUserDataDir, savedBrowserPath, savedId);
      }

      // 在进程退出后再修复 crash sentinel，避免被 Chromium 退出写回覆盖
      await instance.finalizeCrashSentinel(savedUserDataDir);

      preserveRecoveryState = !(await this._persistStoppedPortableProfile(instance));
    } catch (error) {
      browserLogger.error(`后台清理实例 ${savedId} 失败: ${error.message}`);
    } finally {
      if (preserveRecoveryState) {
        instance.clearTimers();
        instance.context = null;
        instance.browser = null;
      } else {
        instance.cleanupFinal();
      }
    }
  }

  /** Chromium completely flushes native files only after exit. Keep this save in
   * the same recovery chain as live checkpoints so CAS/outbox includes them. */
  async _ensureStoppedRuntimeLease(instance) {
    if (this.runtimeLeases.valid(instance.id)) return;
    const remaining = await instance.findBrowserProcesses(instance.userDataDir, instance.id, {
      strict: true,
    });
    if (remaining.length) throw new Error('原浏览器进程尚未退出，不能恢复运行锁或交接');
    const lease = await this.runtimeLeases.acquire(instance.id, instance.ownerId);
    if (Number(lease.recovery?.recoveryRevision) !== Number(instance.recoveryRevision))
      throw new Error('停止后的恢复版本不一致，已保留本地数据和原设备占用');
  }

  async _releaseRuntimeLeaseAfterStopped(
    id,
    ownerId,
    revision,
    instance = null,
    acknowledged = false
  ) {
    const entry = this.runtimeLeases.entries.get(id);
    if (!entry) return;
    const canonical = resolveBrowserProfilePaths(getAppPath(), id, ownerId).owned;
    const probe =
      instance ||
      Object.assign(Object.create(BrowserInstance.prototype), {
        logger: browserLogger,
        _profileLaunchPath: null,
      });
    if ((await probe.findBrowserProcesses(canonical, id, { strict: true })).length)
      throw new Error('原浏览器进程尚未退出，不能解除运行锁');
    if (
      this.recoveryOutbox.getMetadata(id, ownerId) ||
      this.recoveryOutbox.getDirtyMarker(id, ownerId)
    )
      throw new Error('浏览器数据尚未完整同步，已保留运行锁');
    if (!acknowledged && (entry.restored || this._unsafeClosedInstances.has(id)))
      throw new Error('原设备恢复数据尚未确认保存，已保留运行锁');
    if (!Number.isSafeInteger(revision) || revision < 0) {
      const lease = await this.runtimeLeases.acquire(id, ownerId);
      revision = Number(lease.recovery?.recoveryRevision);
    }
    await this.runtimeLeases.release(id, revision);
  }

  async _persistStoppedPortableProfile(instance) {
    try {
      await this._runRecoveryChain(instance.id, async () => {
        await instance.captureStoppedPortableProfile({ notify: false });
        await this._ensureStoppedRuntimeLease(instance);
        const saved = await this._persistSnapshotNow(
          instance.getSnapshot(),
          'portable-profile-closed'
        );
        instance.recoveryRevision = saved.recoveryRevision;
        await this._releaseRuntimeLeaseAfterStopped(
          instance.id,
          instance.ownerId,
          saved.recoveryRevision,
          instance,
          true
        );
      });
      this._unsafeClosedInstances.delete(instance.id);
      return true;
    } catch (error) {
      if (error.recoverySnapshotRetained && !error.blocksClose) {
        this._unsafeClosedInstances.delete(instance.id);
        return true;
      }
      this._unsafeClosedInstances.set(instance.id, {
        instance,
        ownerId: normalizeRecoveryOwnerId(instance.ownerId),
      });
      try {
        this._recordDirtyWithoutPayload(
          instance.id,
          instance.recoveryRevision,
          instance.ownerId,
          'portable-profile-capture-failed'
        );
      } catch (markerError) {
        browserLogger.error(`原生档案安全标记失败: ${markerError.message}`);
      }
      this._emitRecoveryFailure(instance.id, {
        retained: false,
        critical: true,
        message: `浏览器档案未完整同步：${error.message}`,
      });
      browserLogger.warn(`浏览器原生档案保存失败: ${instance.id}, ${error.message}`);
      return false;
    }
  }

  /**
   * 关闭指定实例
   * @param {string} id - 实例 ID
   */
  async closeInstance(id) {
    assertInstanceId(id);

    const pendingClose = this.closePromises.get(id);
    if (pendingClose) return pendingClose;
    const closeAlreadyInProgress = this.closingInstances.has(id);

    const closePromise = (async () => {
      const pendingLaunch = this.launchingInstances.get(id);
      if (pendingLaunch) {
        await pendingLaunch.catch(() => {});
      }
      return this._closeInstance(id);
    })();

    this.closePromises.set(id, closePromise);
    try {
      return await closePromise;
    } finally {
      if (this.closePromises.get(id) === closePromise) this.closePromises.delete(id);
      if (!closeAlreadyInProgress) this.closingInstances.delete(id);
    }
  }

  async _closeInstance(id) {
    assertInstanceId(id);

    browserLogger.info(`closeInstance 被调用: ${id}`);

    // 如果已经在关闭中，等待完成
    if (this.closingInstances.has(id)) {
      browserLogger.debug(`实例 ${id} 已在关闭中，等待完成...`);
      await this.waitForInstanceClose(id);
      return;
    }

    // 标记为正在关闭（在任何操作之前）
    this.closingInstances.add(id);

    // 取消该实例的防抖保存定时器
    if (this._saveTimers.has(id)) {
      clearTimeout(this._saveTimers.get(id));
      this._saveTimers.delete(id);
    }

    // 获取实例
    const instance = this.instances.get(id);

    // 在关闭前采集快照并持久化
    let snapshot = null;
    if (instance) {
      try {
        await this._runRecoveryChain(id, async () => {
          try {
            // 先等待已入链的显式操作，再从活跃 context 采集最新全量快照。
            snapshot = await instance.forceSaveState();
            browserLogger.info(`实例 ${id} 快照已采集 (${snapshot.pages.length} 个页面)`);
          } catch (captureError) {
            browserLogger.warn(`实例 ${id} 采集快照失败: ${captureError.message}`);
            snapshot = instance.getSnapshot();
          }
          await this._persistSnapshotNow(snapshot, 'close-instance');
        });
        browserLogger.info(`实例 ${id} 状态已持久化到后端`);
      } catch (error) {
        browserLogger.warn(`实例 ${id} 状态未能保存到后端: ${error.message}`);
        if (error.blocksClose || !error.recoverySnapshotRetained) {
          instance.isClosing = false;
          error.blocksClose = true;
          throw error;
        }
      }

      // 标记为关闭中
      instance.isClosing = true;
      instance.clearTimers();
    }

    // 从 Map 中移除实例
    this.instances.delete(id);

    // 发送关闭状态
    browserLogger.info(`发送 closed 状态: ${id}`);
    ipcEmitter.emitBrowserStatus(id, 'closed');

    if (instance) {
      const savedUserDataDir = instance.userDataDir;
      const savedBrowserPath = instance.browserPath;
      const savedContext = instance.context;

      instance.context = null;
      instance.browser = null;

      let contextClosedGracefully = false;
      try {
        if (savedContext) {
          // 先逐个关闭页面，避免直接 context.close() 导致 Chrome 异常退出提示
          try {
            const pages = savedContext.pages().filter(p => !p.isClosed());
            for (let i = pages.length - 1; i >= 1; i--) {
              try {
                await pages[i].close();
              } catch {}
            }
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch {}

          await Promise.race([
            savedContext.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('关闭超时')), 5000)),
          ]);
          contextClosedGracefully = true;
        }
        browserLogger.info(`实例 ${id} 上下文已优雅关闭`);
      } catch (error) {
        browserLogger.warn(`关闭实例 ${id} 上下文时出错: ${error.message}`);
      }

      if (contextClosedGracefully) {
        // 优雅关闭成功，等待进程自然退出
        await new Promise(resolve => setTimeout(resolve, 1500));
        // 验证是否仍有残留进程，有则强制清理（Chromium 子进程可能不会随 context.close 退出）
        const remainingPids = await instance.findBrowserProcesses(savedUserDataDir, id);
        if (remainingPids.length > 0) {
          browserLogger.info(`实例 ${id} 仍有 ${remainingPids.length} 个残留进程，强制清理`);
          await instance.forceKillBrowserByPaths(savedUserDataDir, savedBrowserPath, id);
        }
      } else {
        // 优雅关闭失败/超时，需要强制清理进程
        await new Promise(resolve => setTimeout(resolve, 300));
        for (let i = 0; i < 2; i++) {
          const success = await instance.forceKillBrowserByPaths(
            savedUserDataDir,
            savedBrowserPath,
            id
          );
          if (success) break;
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // 在进程退出后修复 crash sentinel，避免再次出现"异常关闭"提示
      await instance.finalizeCrashSentinel(savedUserDataDir);

      if (await this._persistStoppedPortableProfile(instance)) {
        instance.cleanupFinal();
      } else {
        instance.clearTimers();
      }
    } else {
      browserLogger.warn(`实例 ${id} 不存在于管理器中`);
    }

    // 清除关闭标记
    this.closingInstances.delete(id);
    browserLogger.info(`实例 ${id} 已从管理器中移除`);
  }

  /**
   * 获取所有实例 ID
   * @returns {string[]} 实例 ID 数组
   */
  getInstanceIds() {
    return Array.from(this.instances.keys());
  }

  /**
   * 获取实例数量
   * @returns {number}
   */
  getInstanceCount() {
    return this.instances.size;
  }

  /**
   * 检查实例是否存在
   * @param {string} id - 实例 ID
   * @returns {boolean}
   */
  hasInstance(id) {
    return this.instances.has(id);
  }

  /**
   * 关闭所有实例
   */
  async closeAllInstances() {
    const ids = this.getInstanceIds();
    browserLogger.info(`正在关闭 ${ids.length} 个浏览器实例`);

    // 串行关闭，避免并发问题
    for (const id of ids) {
      try {
        await this.closeInstance(id);
      } catch (error) {
        browserLogger.error(`关闭实例 ${id} 失败: ${error.message}`);
      }
    }

    browserLogger.info('所有浏览器实例已关闭');
  }
}

// 创建管理器单例
const manager = new MultiBrowserManager();

/**
 * 注册浏览器管理 IPC 处理器
 */
export const registerBrowserHandlers = () => {
  browserLogger.info('注册浏览器管理 IPC 处理器');

  ipcRegistry.registerHandlers([
    {
      channel: 'create-browser-instance',
      handler: async (event, createBrowserData) => {
        const instance = await manager.createBrowserInstance(createBrowserData);
        return { success: true, id: instance.id };
      },
      description: '创建浏览器实例',
    },
    {
      channel: 'restore-browser-instance',
      handler: async (event, updateBrowserData) => {
        const instance = await manager.createBrowserInstance(updateBrowserData);
        return { success: true, id: instance.id };
      },
      description: '恢复浏览器实例',
    },
    {
      channel: 'get-all-instances',
      handler: async () => {
        browserLogger.debug('获取所有浏览器实例列表');
        manager._assertSessionOperationsAllowed();
        const session = await manager._getCurrentSession();
        return Array.from(manager.instances.values())
          .filter(instance => instance.ownerId === session.userId)
          .map(instance => instance.id);
      },
      description: '获取所有实例',
    },
    {
      channel: 'prepare-browser-session-logout',
      handler: async () => ({ success: await manager.prepareSessionLogout() }),
      description: '退出登录前冻结会话并安全收口所有浏览器恢复写入',
    },
    {
      channel: 'remove-browser-instance',
      handler: async (event, id) => {
        browserLogger.info(`收到移除浏览器实例请求: ${id}`);
        const instance = await manager.getOwnedActiveInstance(id);
        if (!instance) return { success: true };
        await manager.closeInstance(id);
        return { success: true };
      },
      description: '移除浏览器实例',
    },
    {
      channel: 'delete-browser-and-cleanup',
      handler: async (event, id) => ({ success: await manager.deleteBrowserAndCleanup(id) }),
      description: '主进程删除服务端浏览器并原子清理本地恢复数据',
    },
    // 历史记录相关
    {
      channel: 'get-browser-history',
      handler: async (event, { instanceId, limit }) => {
        assertInstanceId(instanceId);
        const instance = await manager.getOwnedActiveInstance(instanceId);
        if (instance) return instance.historyManager.getRecent(limit || 50);
        const { historyManager } = await manager.loadDetachedRecoveryManagers(instanceId);
        return historyManager.getRecent(limit || 50);
      },
      description: '获取浏览器历史记录',
    },
    {
      channel: 'search-browser-history',
      handler: async (event, { instanceId, query, limit }) => {
        assertInstanceId(instanceId);
        const instance = await manager.getOwnedActiveInstance(instanceId);
        if (instance) return instance.historyManager.search(query, limit || 50);
        const { historyManager } = await manager.loadDetachedRecoveryManagers(instanceId);
        return historyManager.search(query, limit || 50);
      },
      description: '搜索浏览器历史记录',
    },
    {
      channel: 'clear-browser-history',
      handler: async (event, { instanceId }) => {
        return manager.mutateRecoveryCaches(
          instanceId,
          'history-cleared-explicit',
          async ({ historyManager }) => {
            const originalHistory = historyManager.exportEntries();
            historyManager.clear({ notify: false });
            return {
              rollback: () =>
                historyManager.importEntries(
                  mergeHistoryAfterRejectedClear(originalHistory, historyManager.exportEntries())
                ),
            };
          }
        );
      },
      description: '清除浏览器历史记录',
    },
    // 密码管理相关
    {
      channel: 'get-saved-credentials',
      handler: async (event, { instanceId }) => {
        assertInstanceId(instanceId);
        const instance = await manager.getOwnedActiveInstance(instanceId);
        const credentialManager = instance
          ? instance.credentialManager
          : (await manager.loadDetachedRecoveryManagers(instanceId)).credentialManager;
        return credentialManager.list();
      },
      description: '获取保存的密码列表',
    },
    {
      channel: 'save-credential',
      handler: async (event, { instanceId, domain, username, password }) => {
        return manager.mutateRecoveryCaches(
          instanceId,
          'credential-saved-explicit',
          async ({ credentialManager }) => {
            const originalCredentials = credentialManager.exportEntries();
            credentialManager.save(domain, username, password);
            return {
              rollback: () => credentialManager.importEntries(originalCredentials),
            };
          }
        );
      },
      description: '保存密码',
    },
    {
      channel: 'delete-credential',
      handler: async (event, { instanceId, domain, username }) => {
        return manager.mutateRecoveryCaches(
          instanceId,
          'credential-deleted-explicit',
          async ({ credentialManager }) => {
            const originalCredentials = credentialManager.exportEntries();
            credentialManager.delete(domain, username, { notify: false });
            return {
              rollback: () => credentialManager.importEntries(originalCredentials),
            };
          }
        );
      },
      description: '删除密码',
    },
  ]);
};

// 导出管理器实例
export { manager as browserManager, MultiBrowserManager };
