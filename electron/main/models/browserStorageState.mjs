import { normalizePortableProfile } from './browserPortableProfile.mjs';
import { normalizeSessionStorage } from './browserSessionStorage.mjs';
import { normalizeOpfs } from './browserOpfs.mjs';

const SAME_SITE_VALUES = new Set(['Strict', 'Lax', 'None']);

// storageState 会在启动时整体序列化并传给 Chromium，因此除了
// 校验字段类型，还要限制条数和字符串长度，避免后端脏数据导致启动异常。
export const BROWSER_STORAGE_STATE_LIMITS = Object.freeze({
  cookies: 1000,
  origins: 100,
  localStorageEntriesPerOrigin: 1000,
  indexedDBDatabasesPerOrigin: 100,
  indexedDBStoresPerDatabase: 100,
  indexedDBIndexesPerStore: 100,
  indexedDBRecordsPerDatabase: 10_000,
  cookieNameLength: 256,
  cookieValueLength: 16 * 1024,
  cookieDomainLength: 253,
  cookiePathLength: 2048,
  cookiePartitionKeyLength: 2048,
  originLength: 2048,
  localStorageNameLength: 1024,
  localStorageValueLength: 1024 * 1024,
  indexedDBNameLength: 1024,
  indexedDBKeyPathLength: 4096,
  indexedDBRecordJsonLength: 1024 * 1024,
  totalStringLength: 10 * 1024 * 1024,
});

export const isPlainObject = value => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isBoundedString = (value, maxLength, { allowEmpty = true } = {}) =>
  typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maxLength;

const addStringLength = (budget, ...values) => {
  for (const value of values) {
    budget.used += value.length;
    if (budget.used > BROWSER_STORAGE_STATE_LIMITS.totalStringLength) return false;
  }
  return true;
};

const cloneBoundedJsonValue = (value, budget, maxLength) => {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string' || serialized.length > maxLength) return null;
    if (!addStringLength(budget, serialized)) return null;
    return JSON.parse(serialized);
  } catch {
    return null;
  }
};

const normalizeIndexedDBKeyPathArray = (keyPath, budget) => {
  if (!Array.isArray(keyPath) || keyPath.length > 100) return null;
  const normalized = [];
  for (const item of keyPath) {
    if (!isBoundedString(item, BROWSER_STORAGE_STATE_LIMITS.indexedDBKeyPathLength)) {
      return null;
    }
    if (!addStringLength(budget, item)) return null;
    normalized.push(item);
  }
  return normalized;
};

const normalizeOptionalKeyPathFields = (source, target, budget) => {
  if (Object.hasOwn(source, 'keyPath')) {
    if (!isBoundedString(source.keyPath, BROWSER_STORAGE_STATE_LIMITS.indexedDBKeyPathLength)) {
      return false;
    }
    if (!addStringLength(budget, source.keyPath)) return false;
    target.keyPath = source.keyPath;
  }
  if (Object.hasOwn(source, 'keyPathArray')) {
    const keyPathArray = normalizeIndexedDBKeyPathArray(source.keyPathArray, budget);
    if (keyPathArray === null) return false;
    target.keyPathArray = keyPathArray;
  }
  if (Object.hasOwn(source, 'keyPath') && Object.hasOwn(source, 'keyPathArray')) return false;
  return true;
};

const normalizeIndexedDB = (rawDatabases, budget) => {
  if (rawDatabases === undefined) return undefined;
  if (
    !Array.isArray(rawDatabases) ||
    rawDatabases.length > BROWSER_STORAGE_STATE_LIMITS.indexedDBDatabasesPerOrigin
  ) {
    return null;
  }

  const databases = [];
  const seenNames = new Set();
  for (const database of rawDatabases) {
    if (
      !isPlainObject(database) ||
      !isBoundedString(database.name, BROWSER_STORAGE_STATE_LIMITS.indexedDBNameLength, {
        allowEmpty: false,
      }) ||
      !Number.isSafeInteger(database.version) ||
      database.version <= 0 ||
      !Array.isArray(database.stores) ||
      database.stores.length > BROWSER_STORAGE_STATE_LIMITS.indexedDBStoresPerDatabase ||
      seenNames.has(database.name)
    ) {
      return null;
    }
    seenNames.add(database.name);
    if (!addStringLength(budget, database.name)) return null;

    const stores = [];
    const seenStoreNames = new Set();
    for (const store of database.stores) {
      if (
        !isPlainObject(store) ||
        !isBoundedString(store.name, BROWSER_STORAGE_STATE_LIMITS.indexedDBNameLength, {
          allowEmpty: false,
        }) ||
        typeof store.autoIncrement !== 'boolean' ||
        !Array.isArray(store.records) ||
        store.records.length > BROWSER_STORAGE_STATE_LIMITS.indexedDBRecordsPerDatabase ||
        !Array.isArray(store.indexes) ||
        store.indexes.length > BROWSER_STORAGE_STATE_LIMITS.indexedDBIndexesPerStore ||
        seenStoreNames.has(store.name)
      ) {
        return null;
      }
      seenStoreNames.add(store.name);
      if (!addStringLength(budget, store.name)) return null;

      const normalizedStore = {
        name: store.name,
        records: [],
        indexes: [],
        autoIncrement: store.autoIncrement,
      };
      if (!normalizeOptionalKeyPathFields(store, normalizedStore, budget)) return null;

      for (const record of store.records) {
        if (
          !isPlainObject(record) ||
          (!Object.hasOwn(record, 'value') && !Object.hasOwn(record, 'valueEncoded'))
        ) {
          return null;
        }
        const normalizedRecord = {};
        for (const field of ['key', 'keyEncoded', 'value', 'valueEncoded']) {
          if (!Object.hasOwn(record, field)) continue;
          const cloned = cloneBoundedJsonValue(
            record[field],
            budget,
            BROWSER_STORAGE_STATE_LIMITS.indexedDBRecordJsonLength
          );
          if (cloned === null && record[field] !== null) return null;
          normalizedRecord[field] = cloned;
        }
        normalizedStore.records.push(normalizedRecord);
      }

      const seenIndexNames = new Set();
      for (const index of store.indexes) {
        if (
          !isPlainObject(index) ||
          !isBoundedString(index.name, BROWSER_STORAGE_STATE_LIMITS.indexedDBNameLength, {
            allowEmpty: false,
          }) ||
          typeof index.multiEntry !== 'boolean' ||
          typeof index.unique !== 'boolean' ||
          seenIndexNames.has(index.name)
        ) {
          return null;
        }
        seenIndexNames.add(index.name);
        if (!addStringLength(budget, index.name)) return null;
        const normalizedIndex = {
          name: index.name,
          multiEntry: index.multiEntry,
          unique: index.unique,
        };
        if (!normalizeOptionalKeyPathFields(index, normalizedIndex, budget)) return null;
        normalizedStore.indexes.push(normalizedIndex);
      }
      stores.push(normalizedStore);
    }

    databases.push({
      name: database.name,
      version: database.version,
      stores,
    });
  }
  return databases;
};

const normalizeCookie = (cookie, budget) => {
  if (!isPlainObject(cookie)) return null;
  if (
    !isBoundedString(cookie.name, BROWSER_STORAGE_STATE_LIMITS.cookieNameLength, {
      allowEmpty: false,
    }) ||
    !isBoundedString(cookie.value, BROWSER_STORAGE_STATE_LIMITS.cookieValueLength) ||
    !isBoundedString(cookie.domain, BROWSER_STORAGE_STATE_LIMITS.cookieDomainLength, {
      allowEmpty: false,
    }) ||
    cookie.domain.trim() !== cookie.domain ||
    !isBoundedString(cookie.path, BROWSER_STORAGE_STATE_LIMITS.cookiePathLength, {
      allowEmpty: false,
    }) ||
    !cookie.path.startsWith('/') ||
    !Number.isFinite(cookie.expires) ||
    (cookie.expires !== -1 && (cookie.expires < 0 || cookie.expires > 253402300799)) ||
    typeof cookie.httpOnly !== 'boolean' ||
    typeof cookie.secure !== 'boolean' ||
    !SAME_SITE_VALUES.has(cookie.sameSite)
  ) {
    return null;
  }

  if (
    Object.hasOwn(cookie, 'partitionKey') &&
    !isBoundedString(cookie.partitionKey, BROWSER_STORAGE_STATE_LIMITS.cookiePartitionKeyLength, {
      allowEmpty: false,
    })
  ) {
    return null;
  }
  if (
    Object.hasOwn(cookie, '_crHasCrossSiteAncestor') &&
    typeof cookie._crHasCrossSiteAncestor !== 'boolean'
  ) {
    return null;
  }

  if (!addStringLength(budget, cookie.name, cookie.value, cookie.domain, cookie.path)) return null;
  if (cookie.partitionKey && !addStringLength(budget, cookie.partitionKey)) return null;

  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
    ...(cookie._crHasCrossSiteAncestor === undefined
      ? {}
      : { _crHasCrossSiteAncestor: cookie._crHasCrossSiteAncestor }),
  };
};

const normalizeOrigin = (origin, budget) => {
  if (
    !isPlainObject(origin) ||
    !isBoundedString(origin.origin, BROWSER_STORAGE_STATE_LIMITS.originLength, {
      allowEmpty: false,
    }) ||
    origin.origin.trim() !== origin.origin
  ) {
    return null;
  }
  if (!Array.isArray(origin.localStorage)) return null;
  if (origin.localStorage.length > BROWSER_STORAGE_STATE_LIMITS.localStorageEntriesPerOrigin) {
    return null;
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin.origin);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(parsedOrigin.protocol) ||
    parsedOrigin.origin !== origin.origin
  ) {
    return null;
  }
  if (!addStringLength(budget, origin.origin)) return null;

  const localStorage = [];
  for (const item of origin.localStorage) {
    if (
      !isPlainObject(item) ||
      !isBoundedString(item.name, BROWSER_STORAGE_STATE_LIMITS.localStorageNameLength) ||
      !isBoundedString(item.value, BROWSER_STORAGE_STATE_LIMITS.localStorageValueLength)
    ) {
      return null;
    }
    if (!addStringLength(budget, item.name, item.value)) return null;
    localStorage.push({ name: item.name, value: item.value });
  }

  const indexedDB = normalizeIndexedDB(origin.indexedDB, budget);
  if (indexedDB === null) return null;
  return {
    origin: origin.origin,
    localStorage,
    ...(indexedDB === undefined ? {} : { indexedDB }),
  };
};

/**
 * 将后端保存的 Playwright storageState 收敛为可安全传给
 * launchPersistentContext 的结构。任何格式异常都会忽略整个快照，
 * 避免只恢复部分登录态造成更难理解的状态。
 */
export const normalizeBrowserStorageState = state => {
  try {
    if (!isPlainObject(state) || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      return null;
    }
    if (
      state.cookies.length > BROWSER_STORAGE_STATE_LIMITS.cookies ||
      state.origins.length > BROWSER_STORAGE_STATE_LIMITS.origins
    ) {
      return null;
    }

    const budget = { used: 0 };

    const cookies = [];
    for (const cookie of state.cookies) {
      const normalized = normalizeCookie(cookie, budget);
      if (!normalized) return null;
      cookies.push(normalized);
    }

    const origins = [];
    const seenOrigins = new Set();
    for (const origin of state.origins) {
      const normalized = normalizeOrigin(origin, budget);
      if (!normalized) return null;
      if (seenOrigins.has(normalized.origin)) return null;
      seenOrigins.add(normalized.origin);
      origins.push(normalized);
    }

    const result = { cookies, origins };
    if (Object.hasOwn(state, 'portableProfile')) {
      const portableProfile = normalizePortableProfile(state.portableProfile);
      if (!portableProfile) return null;
      result.portableProfile = portableProfile;
    }
    if (Object.hasOwn(state, 'sessionStorage')) {
      const sessionStorage = normalizeSessionStorage(state.sessionStorage);
      if (!sessionStorage) return null;
      result.sessionStorage = sessionStorage;
    }
    if (Object.hasOwn(state, 'opfs')) {
      const opfs = normalizeOpfs(state.opfs);
      if (!opfs) return null;
      result.opfs = opfs;
    }
    // 请求还包含pages/history/credentials，给32MiB API限制保留头部余量。
    if (Buffer.byteLength(JSON.stringify(result)) > 28 * 1024 * 1024) return null;
    return result;
  } catch {
    return null;
  }
};
