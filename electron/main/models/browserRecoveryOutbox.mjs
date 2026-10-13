import crypto from 'crypto';
import fs from 'fs';

export const BROWSER_RECOVERY_OUTBOX_VERSION = 1;
export const BROWSER_RECOVERY_OUTBOX_MAX_PAYLOAD_BYTES = 48 * 1024 * 1024;

const SAFE_INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_OWNER_ID = /^[1-9][0-9]{0,19}$/;
const SAFE_SEQUENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REASON = /^[a-z0-9_-]{1,64}$/;

const isPlainObject = value => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const assertBrowserId = value => {
  if (typeof value !== 'string' || !SAFE_INSTANCE_ID.test(value)) {
    throw new Error('浏览器实例 ID 格式无效');
  }
  return value;
};

export const normalizeRecoveryOwnerId = value => {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('云恢复用户 ID 格式无效');
  }
  const ownerId = String(value ?? '');
  if (!SAFE_OWNER_ID.test(ownerId)) throw new Error('云恢复用户 ID 格式无效');
  return ownerId;
};

const assertRevision = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('恢复版本格式无效');
  return value;
};

const assertSequence = value => {
  if (typeof value !== 'string' || !SAFE_SEQUENCE.test(value)) {
    throw new Error('Outbox 序列格式无效');
  }
  return value;
};

const assertReason = value => {
  if (typeof value !== 'string' || !SAFE_REASON.test(value)) {
    throw new Error('Outbox 脏标记原因格式无效');
  }
  return value;
};

const cloneJson = value => JSON.parse(JSON.stringify(value));

const normalizeStoredEntry = entry => {
  if (
    !isPlainObject(entry) ||
    entry.version !== BROWSER_RECOVERY_OUTBOX_VERSION ||
    typeof entry.encryptedPayload !== 'string' ||
    !entry.encryptedPayload ||
    entry.encryptedPayload.length > BROWSER_RECOVERY_OUTBOX_MAX_PAYLOAD_BYTES * 2 ||
    !Number.isSafeInteger(entry.updatedAt) ||
    entry.updatedAt < 0
  ) {
    return null;
  }
  try {
    assertSequence(entry.sequence);
    assertRevision(entry.expectedRevision);
    normalizeRecoveryOwnerId(entry.ownerId);
  } catch {
    return null;
  }
  return {
    version: BROWSER_RECOVERY_OUTBOX_VERSION,
    ownerId: String(entry.ownerId),
    sequence: entry.sequence,
    expectedRevision: entry.expectedRevision,
    encryptedPayload: entry.encryptedPayload,
    updatedAt: entry.updatedAt,
  };
};

const normalizeMarker = marker => {
  if (
    !isPlainObject(marker) ||
    marker.version !== BROWSER_RECOVERY_OUTBOX_VERSION ||
    !Number.isSafeInteger(marker.updatedAt) ||
    marker.updatedAt < 0
  ) {
    return null;
  }
  try {
    assertSequence(marker.sequence);
    assertRevision(marker.expectedRevision);
    normalizeRecoveryOwnerId(marker.ownerId);
    assertReason(marker.reason);
  } catch {
    return null;
  }
  return {
    version: BROWSER_RECOVERY_OUTBOX_VERSION,
    ownerId: String(marker.ownerId),
    sequence: marker.sequence,
    expectedRevision: marker.expectedRevision,
    reason: marker.reason,
    updatedAt: marker.updatedAt,
  };
};

const normalizeDeletionIntent = intent => {
  if (
    !isPlainObject(intent) ||
    intent.version !== BROWSER_RECOVERY_OUTBOX_VERSION ||
    !Number.isSafeInteger(intent.updatedAt) ||
    intent.updatedAt < 0
  ) {
    return null;
  }
  try {
    assertSequence(intent.sequence);
    normalizeRecoveryOwnerId(intent.ownerId);
  } catch {
    return null;
  }
  return {
    version: BROWSER_RECOVERY_OUTBOX_VERSION,
    ownerId: String(intent.ownerId),
    sequence: intent.sequence,
    updatedAt: intent.updatedAt,
  };
};

const assertOwned = (record, ownerId) => {
  if (record.ownerId !== normalizeRecoveryOwnerId(ownerId)) {
    throw new Error('本机待恢复数据属于其他用户，已阻止读写');
  }
  return record;
};

const stableJson = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
};

const cloneComparableJson = value => {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return null;
    return JSON.parse(serialized);
  } catch {
    return null;
  }
};

const comparableSnapshot = snapshot => {
  if (
    !isPlainObject(snapshot) ||
    !Array.isArray(snapshot.pages) ||
    !Array.isArray(snapshot.history) ||
    !Array.isArray(snapshot.credentials)
  ) {
    return null;
  }
  const pages = [];
  for (const page of snapshot.pages) {
    if (
      !isPlainObject(page) ||
      typeof page.url !== 'string' ||
      !page.url ||
      (page.title !== undefined && typeof page.title !== 'string')
    ) {
      return null;
    }
    pages.push({ url: page.url, title: page.title ?? '' });
  }
  const state = cloneComparableJson(snapshot.state ?? null);
  const history = cloneComparableJson(snapshot.history);
  const credentials = cloneComparableJson(snapshot.credentials);
  if (state === null && snapshot.state !== null && snapshot.state !== undefined) return null;
  if (!Array.isArray(history) || !history.every(isPlainObject)) return null;
  if (!Array.isArray(credentials) || !credentials.every(isPlainObject)) return null;
  return { pages, state, history, credentials };
};

/** 解决服务端已接受、客户端未 ACK 时的崩溃窗口。 */
export const areRecoverySnapshotsEquivalent = (pending, server) => {
  try {
    const normalizedPending = comparableSnapshot(pending);
    const normalizedServer = comparableSnapshot(server);
    return (
      normalizedPending !== null &&
      normalizedServer !== null &&
      stableJson(normalizedPending) === stableJson(normalizedServer)
    );
  } catch {
    return false;
  }
};

export const shouldClearRecoveryOutbox = (currentSequence, completedSequence) =>
  typeof currentSequence === 'string' && currentSequence === completedSequence;

export const decideRecoveryOutboxReplay = ({
  hasPendingEntry,
  cloudRecoveryVersion,
  expectedRevision,
  serverRevision,
}) => {
  if (!hasPendingEntry) return { action: 'none' };
  if (cloudRecoveryVersion !== BROWSER_RECOVERY_OUTBOX_VERSION) {
    return { action: 'block', reason: 'capability' };
  }
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !Number.isSafeInteger(serverRevision) ||
    serverRevision < 0
  ) {
    return { action: 'block', reason: 'revision-invalid' };
  }
  if (expectedRevision === serverRevision) return { action: 'replay' };
  if (serverRevision === expectedRevision + 1) return { action: 'verify-committed' };
  return { action: 'block', reason: 'conflict' };
};

export const validateRecoveryReplayRevision = (expectedRevision, nextRevision) =>
  Number.isSafeInteger(expectedRevision) &&
  expectedRevision >= 0 &&
  Number.isSafeInteger(nextRevision) &&
  nextRevision === expectedRevision + 1;

const createStore = (store, StoreClass, name) => {
  if (store) return store;
  if (typeof StoreClass !== 'function') throw new Error('Outbox 存储实现未配置');
  return new StoreClass({
    name,
    configFileMode: 0o600,
    clearInvalidConfig: false,
  });
};

const enforcePermissions = store => {
  if (process.platform === 'win32' || !store?.path) return;
  try {
    fs.chmodSync(store.path, 0o600);
  } catch {
    // 首次写入仍由 electron-store 的 configFileMode 保证。
  }
};

export class BrowserRecoveryOutbox {
  constructor({
    store = null,
    StoreClass = null,
    safeStorageAdapter = null,
    sequenceFactory = () => crypto.randomUUID(),
    now = () => Date.now(),
  } = {}) {
    this.store = createStore(store, StoreClass, 'browser-recovery-outbox');
    this.safeStorage = safeStorageAdapter;
    this.sequenceFactory = sequenceFactory;
    this.now = now;
    enforcePermissions(this.store);
  }

  _assertEncryptionAvailable() {
    if (
      !this.safeStorage ||
      typeof this.safeStorage.isEncryptionAvailable !== 'function' ||
      !this.safeStorage.isEncryptionAvailable() ||
      typeof this.safeStorage.encryptString !== 'function' ||
      typeof this.safeStorage.decryptString !== 'function'
    ) {
      throw new Error('系统安全存储不可用，无法保存待同步恢复快照');
    }
  }

  _readMap(key, label) {
    const value = this.store.get(key);
    if (value === undefined) return {};
    if (!isPlainObject(value)) throw new Error(`${label}格式损坏，已阻止忽略待同步数据`);
    return value;
  }

  _writeMap(key, value) {
    this.store.set(key, value);
    enforcePermissions(this.store);
  }

  _writeMaps(values) {
    this.store.set(values);
    enforcePermissions(this.store);
  }

  getRawEntry(browserId, ownerId) {
    const id = assertBrowserId(browserId);
    const owner = normalizeRecoveryOwnerId(ownerId);
    const entries = this._readMap('entries', 'Outbox 队列');
    if (!Object.hasOwn(entries, id)) return null;
    const entry = normalizeStoredEntry(entries[id]);
    if (!entry) throw new Error('Outbox 记录格式损坏，已阻止忽略待同步数据');
    return structuredClone(assertOwned(entry, owner));
  }

  getMetadata(browserId, ownerId) {
    const entry = this.getRawEntry(browserId, ownerId);
    return entry
      ? {
          ownerId: entry.ownerId,
          sequence: entry.sequence,
          expectedRevision: entry.expectedRevision,
          updatedAt: entry.updatedAt,
        }
      : null;
  }

  getDirtyMarker(browserId, ownerId) {
    const id = assertBrowserId(browserId);
    const owner = normalizeRecoveryOwnerId(ownerId);
    const markers = this._readMap('dirtyMarkers', 'Outbox 脏标记');
    if (!Object.hasOwn(markers, id)) return null;
    const marker = normalizeMarker(markers[id]);
    if (!marker) throw new Error('Outbox 脏标记格式损坏，已阻止恢复');
    return structuredClone(assertOwned(marker, owner));
  }

  markDirty(browserId, expectedRevision, reason, { ownerId, sequence } = {}) {
    const id = assertBrowserId(browserId);
    const marker = {
      version: BROWSER_RECOVERY_OUTBOX_VERSION,
      ownerId: normalizeRecoveryOwnerId(ownerId),
      sequence: assertSequence(sequence || this.sequenceFactory()),
      expectedRevision: assertRevision(expectedRevision),
      reason: assertReason(reason),
      updatedAt: this.now(),
    };
    const markers = this._readMap('dirtyMarkers', 'Outbox 脏标记');
    if (Object.hasOwn(markers, id)) {
      const current = normalizeMarker(markers[id]);
      if (!current) throw new Error('Outbox 脏标记格式损坏，已阻止覆盖');
      assertOwned(current, marker.ownerId);
    }
    markers[id] = marker;
    try {
      this._writeMap('dirtyMarkers', markers);
    } catch (cause) {
      const error = new Error('无法写入本地恢复脏标记', { cause });
      error.code = 'RECOVERY_DIRTY_MARKER_WRITE_FAILED';
      error.outboxSequence = marker.sequence;
      throw error;
    }
    return structuredClone(marker);
  }

  clearDirtyIfSequence(browserId, completedSequence, ownerId) {
    const id = assertBrowserId(browserId);
    const markers = this._readMap('dirtyMarkers', 'Outbox 脏标记');
    if (!Object.hasOwn(markers, id)) return false;
    const marker = normalizeMarker(markers[id]);
    if (!marker) throw new Error('Outbox 脏标记格式损坏，已阻止清理');
    assertOwned(marker, ownerId);
    if (!shouldClearRecoveryOutbox(marker.sequence, completedSequence)) return false;
    delete markers[id];
    this._writeMap('dirtyMarkers', markers);
    return true;
  }

  getDeletionIntent(browserId, ownerId) {
    const id = assertBrowserId(browserId);
    const owner = normalizeRecoveryOwnerId(ownerId);
    const intents = this._readMap('deletionIntents', '删除意图队列');
    if (!Object.hasOwn(intents, id)) return null;
    const intent = normalizeDeletionIntent(intents[id]);
    if (!intent) throw new Error('删除意图记录格式损坏，已阻止忽略');
    return structuredClone(assertOwned(intent, owner));
  }

  stageDeletionIntent(browserId, ownerId, sequence = this.sequenceFactory()) {
    const id = assertBrowserId(browserId);
    const owner = normalizeRecoveryOwnerId(ownerId);
    const intents = this._readMap('deletionIntents', '删除意图队列');
    if (Object.hasOwn(intents, id)) {
      const current = normalizeDeletionIntent(intents[id]);
      if (!current) throw new Error('删除意图记录格式损坏，已阻止覆盖');
      return structuredClone(assertOwned(current, owner));
    }
    const intent = {
      version: BROWSER_RECOVERY_OUTBOX_VERSION,
      ownerId: owner,
      sequence: assertSequence(sequence),
      updatedAt: this.now(),
    };
    intents[id] = intent;
    this._writeMap('deletionIntents', intents);
    return structuredClone(intent);
  }

  clearDeletionIntentIfSequence(browserId, completedSequence, ownerId) {
    const id = assertBrowserId(browserId);
    const intents = this._readMap('deletionIntents', '删除意图队列');
    if (!Object.hasOwn(intents, id)) return false;
    const current = normalizeDeletionIntent(intents[id]);
    if (!current) throw new Error('删除意图记录格式损坏，已阻止清理');
    assertOwned(current, ownerId);
    if (current.sequence !== completedSequence) return false;
    delete intents[id];
    this._writeMap('deletionIntents', intents);
    return true;
  }

  listBrowserIdsForOwner(ownerId) {
    const owner = normalizeRecoveryOwnerId(ownerId);
    const ids = new Set();
    for (const [key, label, normalize] of [
      ['entries', 'Outbox 队列', normalizeStoredEntry],
      ['dirtyMarkers', 'Outbox 脏标记', normalizeMarker],
      ['deletionIntents', '删除意图队列', normalizeDeletionIntent],
    ]) {
      const values = this._readMap(key, label);
      for (const [id, raw] of Object.entries(values)) {
        assertBrowserId(id);
        const record = normalize(raw);
        if (!record) throw new Error(`${label}包含损坏记录，已阻止忽略`);
        if (record.ownerId === owner) ids.add(id);
      }
    }
    return Array.from(ids).sort();
  }

  put(browserId, payload, expectedRevision, { sequence, ownerId } = {}) {
    const id = assertBrowserId(browserId);
    const revision = assertRevision(expectedRevision);
    const owner = normalizeRecoveryOwnerId(ownerId);
    const nextSequence = assertSequence(sequence || this.sequenceFactory());

    // 必须在写 dirty marker 前验证现有 entry 的归属，否则其他用户
    // 可用一次失败 put 破坏原用户的失败关闭标记。
    const existingEntries = this._readMap('entries', 'Outbox 队列');
    if (Object.hasOwn(existingEntries, id)) {
      const existing = normalizeStoredEntry(existingEntries[id]);
      if (!existing) throw new Error('Outbox 记录格式损坏，已阻止覆盖');
      assertOwned(existing, owner);
    }

    try {
      this.markDirty(id, revision, 'snapshot-not-secured', {
        ownerId: owner,
        sequence: nextSequence,
      });
    } catch (cause) {
      const error = new Error('无法写入本地恢复脏标记，已阻止安全关闭', { cause });
      error.code = 'RECOVERY_DIRTY_MARKER_WRITE_FAILED';
      error.outboxSequence = nextSequence;
      error.recoveryDirtyMarkerPersisted = false;
      throw error;
    }

    try {
      if (!isPlainObject(payload) || payload.id !== id || payload.recoveryRevision !== revision) {
        throw new Error('Outbox 恢复快照格式无效');
      }
      const serialized = JSON.stringify(payload);
      if (
        !serialized ||
        Buffer.byteLength(serialized, 'utf8') > BROWSER_RECOVERY_OUTBOX_MAX_PAYLOAD_BYTES
      ) {
        throw new Error('Outbox 恢复快照超出大小限制');
      }
      this._assertEncryptionAvailable();
      const encrypted = this.safeStorage.encryptString(serialized);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
        throw new Error('Outbox 恢复快照加密失败');
      }

      const entry = {
        version: BROWSER_RECOVERY_OUTBOX_VERSION,
        ownerId: owner,
        sequence: nextSequence,
        expectedRevision: revision,
        encryptedPayload: encrypted.toString('base64'),
        updatedAt: this.now(),
      };
      const entries = this._readMap('entries', 'Outbox 队列');
      if (Object.hasOwn(entries, id)) {
        const current = normalizeStoredEntry(entries[id]);
        if (!current) throw new Error('Outbox 记录格式损坏，已阻止覆盖');
        assertOwned(current, owner);
      }
      entries[id] = entry;
      this._writeMap('entries', entries);
      this.clearDirtyIfSequence(id, nextSequence, owner);
      return {
        ownerId: owner,
        sequence: entry.sequence,
        expectedRevision: entry.expectedRevision,
        updatedAt: entry.updatedAt,
      };
    } catch (cause) {
      const error = new Error(cause.message || 'Outbox 恢复快照写入失败', { cause });
      error.code = 'RECOVERY_OUTBOX_WRITE_FAILED';
      error.outboxSequence = nextSequence;
      error.recoveryDirtyMarkerPersisted = true;
      throw error;
    }
  }

  read(browserId, ownerId) {
    const id = assertBrowserId(browserId);
    const entry = this.getRawEntry(id, ownerId);
    if (!entry) return null;
    this._assertEncryptionAvailable();
    let payload;
    try {
      const decrypted = this.safeStorage.decryptString(
        Buffer.from(entry.encryptedPayload, 'base64')
      );
      if (
        typeof decrypted !== 'string' ||
        Buffer.byteLength(decrypted, 'utf8') > BROWSER_RECOVERY_OUTBOX_MAX_PAYLOAD_BYTES
      ) {
        throw new Error('invalid payload');
      }
      payload = JSON.parse(decrypted);
    } catch {
      throw new Error('待同步恢复快照无法解密，已阻止覆盖云端数据');
    }
    if (
      !isPlainObject(payload) ||
      payload.id !== id ||
      payload.recoveryRevision !== entry.expectedRevision
    ) {
      throw new Error('待同步恢复快照校验失败，已阻止覆盖云端数据');
    }
    return { ...entry, payload: cloneJson(payload) };
  }

  removeIfSequence(browserId, completedSequence, ownerId) {
    const id = assertBrowserId(browserId);
    const entries = this._readMap('entries', 'Outbox 队列');
    const current = Object.hasOwn(entries, id) ? normalizeStoredEntry(entries[id]) : null;
    if (Object.hasOwn(entries, id) && !current) throw new Error('Outbox 记录格式损坏，已阻止清理');
    if (!current) return false;
    assertOwned(current, ownerId);
    if (!shouldClearRecoveryOutbox(current.sequence, completedSequence)) return false;
    delete entries[id];
    this._writeMap('entries', entries);
    return true;
  }

  rollbackAttempt(
    browserId,
    failedSequence,
    previousRawEntry,
    ownerId,
    previousDirtyMarker = null
  ) {
    const id = assertBrowserId(browserId);
    const owner = normalizeRecoveryOwnerId(ownerId);
    const sequence = assertSequence(failedSequence);
    const entries = this._readMap('entries', 'Outbox 队列');
    const markers = this._readMap('dirtyMarkers', 'Outbox 脏标记');
    const current = Object.hasOwn(entries, id) ? normalizeStoredEntry(entries[id]) : null;
    if (Object.hasOwn(entries, id) && !current) throw new Error('Outbox 记录格式损坏，已阻止回滚');
    if (current) assertOwned(current, owner);
    const currentMarker = Object.hasOwn(markers, id) ? normalizeMarker(markers[id]) : null;
    if (Object.hasOwn(markers, id) && !currentMarker) {
      throw new Error('Outbox 脏标记格式损坏，已阻止回滚');
    }
    if (currentMarker) assertOwned(currentMarker, owner);

    const entryMatches = current?.sequence === sequence;
    const markerMatches = currentMarker?.sequence === sequence;
    if (!entryMatches && !markerMatches) return false;
    // 另一次更新已经写入新 marker 时，不得用旧请求的回滚覆盖它。
    if (currentMarker && !markerMatches) return false;

    if (entryMatches) {
      if (previousRawEntry === null || previousRawEntry === undefined) delete entries[id];
      else {
        const previous = normalizeStoredEntry(previousRawEntry);
        if (!previous) throw new Error('Outbox 回滚记录格式无效');
        assertOwned(previous, owner);
        entries[id] = previous;
      }
    }

    if (previousDirtyMarker === null || previousDirtyMarker === undefined) {
      delete markers[id];
    } else {
      const previousMarker = normalizeMarker(previousDirtyMarker);
      if (!previousMarker) throw new Error('Outbox 回滚脏标记格式无效');
      assertOwned(previousMarker, owner);
      markers[id] = previousMarker;
    }

    // entry 与 dirty marker 在同一份 electron-store 配置中一次落盘，
    // 避免先清 marker 再恢复旧 marker 之间崩溃丢失失败证据。
    this._writeMaps({ entries, dirtyMarkers: markers });
    return true;
  }

  restoreIfSequence(browserId, failedSequence, previousRawEntry, ownerId) {
    return this.rollbackAttempt(browserId, failedSequence, previousRawEntry, ownerId);
  }

  delete(browserId, ownerId) {
    const id = assertBrowserId(browserId);
    const owner = normalizeRecoveryOwnerId(ownerId);
    let changed = false;
    for (const [key, label, normalize] of [
      ['entries', 'Outbox 队列', normalizeStoredEntry],
      ['dirtyMarkers', 'Outbox 脏标记', normalizeMarker],
    ]) {
      const values = this._readMap(key, label);
      if (!Object.hasOwn(values, id)) continue;
      const current = normalize(values[id]);
      if (!current) throw new Error(`${label}格式损坏，已阻止清理`);
      assertOwned(current, owner);
      delete values[id];
      this._writeMap(key, values);
      changed = true;
    }
    return changed;
  }
}

/** 主 outbox 自身无法写入时，仅存非业务元数据的独立 0600 紧急标记。 */
export class BrowserRecoveryEmergencySentinel {
  constructor({ store = null, StoreClass = null, now = () => Date.now() } = {}) {
    this.store = createStore(store, StoreClass, 'browser-recovery-emergency-sentinel');
    this.now = now;
    enforcePermissions(this.store);
  }

  _readMarkers() {
    const value = this.store.get('markers');
    if (value === undefined) return {};
    if (!isPlainObject(value)) throw new Error('紧急恢复标记格式损坏，已阻止恢复');
    return value;
  }

  mark(browserId, expectedRevision, reason, { ownerId, sequence } = {}) {
    const id = assertBrowserId(browserId);
    const marker = {
      version: BROWSER_RECOVERY_OUTBOX_VERSION,
      ownerId: normalizeRecoveryOwnerId(ownerId),
      sequence: assertSequence(sequence),
      expectedRevision: assertRevision(expectedRevision),
      reason: assertReason(reason),
      updatedAt: this.now(),
    };
    const markers = this._readMarkers();
    if (Object.hasOwn(markers, id)) {
      const current = normalizeMarker(markers[id]);
      if (!current) throw new Error('紧急恢复标记格式损坏，已阻止覆盖');
      assertOwned(current, marker.ownerId);
    }
    markers[id] = marker;
    this.store.set('markers', markers);
    enforcePermissions(this.store);
    return structuredClone(marker);
  }

  get(browserId, ownerId) {
    const id = assertBrowserId(browserId);
    const markers = this._readMarkers();
    if (!Object.hasOwn(markers, id)) return null;
    const marker = normalizeMarker(markers[id]);
    if (!marker) throw new Error('紧急恢复标记格式损坏，已阻止恢复');
    return structuredClone(assertOwned(marker, ownerId));
  }

  clearIfSequence(browserId, completedSequence, ownerId) {
    const id = assertBrowserId(browserId);
    const markers = this._readMarkers();
    if (!Object.hasOwn(markers, id)) return false;
    const marker = normalizeMarker(markers[id]);
    if (!marker) throw new Error('紧急恢复标记格式损坏，已阻止清理');
    assertOwned(marker, ownerId);
    if (!shouldClearRecoveryOutbox(marker.sequence, completedSequence)) return false;
    delete markers[id];
    this.store.set('markers', markers);
    enforcePermissions(this.store);
    return true;
  }

  restoreIfSequence(browserId, failedSequence, previousMarker, ownerId) {
    const id = assertBrowserId(browserId);
    const owner = normalizeRecoveryOwnerId(ownerId);
    const sequence = assertSequence(failedSequence);
    const markers = this._readMarkers();
    if (!Object.hasOwn(markers, id)) return false;
    const current = normalizeMarker(markers[id]);
    if (!current) throw new Error('紧急恢复标记格式损坏，已阻止回滚');
    assertOwned(current, owner);
    if (current.sequence !== sequence) return false;
    if (previousMarker === null || previousMarker === undefined) {
      delete markers[id];
    } else {
      const previous = normalizeMarker(previousMarker);
      if (!previous) throw new Error('紧急恢复回滚标记格式无效');
      assertOwned(previous, owner);
      markers[id] = previous;
    }
    // 原位替换只进行一次 store 写入，不产生 clear -> mark 窗口。
    this.store.set('markers', markers);
    enforcePermissions(this.store);
    return true;
  }

  listBrowserIdsForOwner(ownerId) {
    const owner = normalizeRecoveryOwnerId(ownerId);
    const ids = [];
    for (const [id, raw] of Object.entries(this._readMarkers())) {
      assertBrowserId(id);
      const marker = normalizeMarker(raw);
      if (!marker) throw new Error('紧急恢复标记包含损坏记录，已阻止忽略');
      if (marker.ownerId === owner) ids.push(id);
    }
    return ids.sort();
  }
}
