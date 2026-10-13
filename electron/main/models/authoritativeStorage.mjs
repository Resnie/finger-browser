const MAX_AUTHORITATIVE_ORIGINS = 100;
export const DEFAULT_STORAGE_OPERATION_TIMEOUT_MS = 8000;

/**
 * Chromium 退出或存储进程异常时 storageState() 可能永久不返回。
 * 限时失败后由调用方使用上一次成功检查点，不阻塞关闭流程。
 */
export const withStorageOperationTimeout = async (
  operation,
  timeoutMs = DEFAULT_STORAGE_OPERATION_TIMEOUT_MS
) => {
  if (!operation || typeof operation.then !== 'function') {
    throw new TypeError('存储操作必须是 Promise');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('存储操作超时时间必须大于 0');
  }

  let timeoutId;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('浏览器存储采集超时')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

export const buildAuthoritativeCookiePlan = cookies => ({
  clearExisting: true,
  cookies: Array.isArray(cookies) ? structuredClone(cookies) : [],
});

export const buildAuthoritativeOriginStoragePlan = originState => ({
  origin: originState.origin,
  localStorageMode: 'replace',
  indexedDBMode: 'replace',
  localStorage: structuredClone(originState.localStorage || []),
  indexedDB: structuredClone(originState.indexedDB || []),
});

/** Pure helper used by tests to make the no-merge policy explicit. */
export const applyAuthoritativeNameValueSnapshot = (_staleEntries, authoritativeEntries) =>
  structuredClone(Array.isArray(authoritativeEntries) ? authoritativeEntries : []);

/**
 * Build the exact set of origins that must be restored. An origin present only in the
 * persistent local profile receives an empty authoritative snapshot so stale localStorage
 * and IndexedDB cannot reappear after navigating to it later.
 */
export const buildAuthoritativeOriginUnion = (remoteOrigins, localOrigins) => {
  if (!Array.isArray(remoteOrigins) || !Array.isArray(localOrigins)) {
    throw new TypeError('Authoritative origin snapshots must be arrays');
  }

  const result = [];
  const seenOrigins = new Set();
  for (const originState of remoteOrigins) {
    if (
      !originState ||
      typeof originState.origin !== 'string' ||
      seenOrigins.has(originState.origin)
    ) {
      throw new TypeError('Invalid authoritative remote origin snapshot');
    }
    seenOrigins.add(originState.origin);
    result.push({
      origin: originState.origin,
      localStorage: structuredClone(originState.localStorage || []),
      indexedDB: structuredClone(originState.indexedDB || []),
    });
  }

  for (const originState of localOrigins) {
    if (!originState || typeof originState.origin !== 'string') {
      throw new TypeError('Invalid local origin snapshot');
    }
    if (seenOrigins.has(originState.origin)) continue;
    seenOrigins.add(originState.origin);
    result.push({ origin: originState.origin, localStorage: [], indexedDB: [] });
  }

  if (result.length > MAX_AUTHORITATIVE_ORIGINS) {
    throw new RangeError('Too many authoritative origins');
  }
  return result;
};

/** Initial creation cookies are never allowed to overwrite an existing valid saved snapshot. */
export const shouldApplyInitialCookies = hasSavedStorageState => hasSavedStorageState !== true;

/** Await the last in-flight checkpoint before a closed context falls back to cached state. */
export const awaitPendingStorageCapture = async pendingCapture => {
  if (!pendingCapture || typeof pendingCapture.then !== 'function') {
    return { waited: false, captured: false };
  }
  try {
    const result = await pendingCapture;
    return { waited: true, captured: result?.captured === true };
  } catch {
    return { waited: true, captured: false };
  }
};
