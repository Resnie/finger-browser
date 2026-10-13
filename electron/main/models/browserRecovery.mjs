import { normalizeRecoveryHistoryEntries } from './historyEntries.mjs';
import { isRestorableBrowserPageUrl, isTransientRecoveryPageUrl } from './browserPageUrl.mjs';

export const CLOUD_RECOVERY_VERSION = 1;

export const BROWSER_RECOVERY_LIMITS = Object.freeze({
  pages: 100,
  pageUrlLength: 4096,
  pageTitleLength: 4096,
  credentials: 500,
  credentialDomainLength: 253,
  credentialUsernameLength: 512,
  credentialPasswordLength: 4096,
  credentialsTotalStringLength: 2 * 1024 * 1024,
});

export const normalizeRecoveryPagesForUpload = rawPages => {
  if (!Array.isArray(rawPages) || rawPages.length > BROWSER_RECOVERY_LIMITS.pages) return null;
  const pages = [];
  for (const item of rawPages) {
    if (
      !isPlainObject(item) ||
      !isBoundedString(item.url, BROWSER_RECOVERY_LIMITS.pageUrlLength, false)
    ) {
      return null;
    }
    if (isTransientRecoveryPageUrl(item.url)) continue;
    if (!isRestorableBrowserPageUrl(item.url)) return null;
    if (
      item.title !== undefined &&
      (!isBoundedString(item.title, BROWSER_RECOVERY_LIMITS.pageTitleLength) ||
        /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.title))
    ) {
      return null;
    }
    pages.push({
      url: item.url,
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
    });
  }
  return pages;
};

const isPlainObject = value => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isBoundedString = (value, maxLength, allowEmpty = true) =>
  typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maxLength;

const normalizeDomain = value => {
  if (!isBoundedString(value, BROWSER_RECOVERY_LIMITS.credentialDomainLength, false)) return null;
  const domain = value.trim().toLowerCase();
  if (!domain || domain !== value.trim().toLowerCase() || /[\s/\\@\0-\x1f\x7f]/.test(domain)) {
    return null;
  }
  return domain;
};

/**
 * Validate the plaintext credential envelope exchanged with the authenticated backend.
 * Local stores never persist this representation; CredentialManager immediately encrypts it
 * with safeStorage before writing the 0600 cache.
 */
export const normalizeRecoveryCredentials = rawCredentials => {
  if (!Array.isArray(rawCredentials)) return null;
  if (rawCredentials.length > BROWSER_RECOVERY_LIMITS.credentials) return null;

  const result = [];
  const seen = new Set();
  let totalStringLength = 0;

  for (const item of rawCredentials) {
    if (!isPlainObject(item)) return null;
    const domain = normalizeDomain(item.domain);
    if (
      !domain ||
      !isBoundedString(item.username, BROWSER_RECOVERY_LIMITS.credentialUsernameLength) ||
      !isBoundedString(item.password, BROWSER_RECOVERY_LIMITS.credentialPasswordLength)
    ) {
      return null;
    }

    totalStringLength += domain.length + item.username.length + item.password.length;
    if (totalStringLength > BROWSER_RECOVERY_LIMITS.credentialsTotalStringLength) return null;

    const key = `${domain}\0${item.username}`;
    if (seen.has(key)) return null;
    seen.add(key);

    result.push({
      domain,
      username: item.username,
      password: item.password,
      lastUsedTime:
        Number.isSafeInteger(item.lastUsedTime) && item.lastUsedTime >= 0 ? item.lastUsedTime : 0,
    });
  }

  return result;
};

export const normalizeRecoveryRevision = value =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

export const normalizeCloudRecoveryVersion = value => {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= CLOUD_RECOVERY_VERSION
    ? CLOUD_RECOVERY_VERSION
    : 0;
};

/**
 * Validate and atomically hand cloud cache data to the local encrypted cache writers.
 * A capable backend is authoritative, so malformed data or an unavailable safeStorage
 * implementation must stop startup instead of leaving stale local data active.
 */
export const importCloudRecoveryCaches = ({
  recovery,
  cloudRecoveryVersion,
  importHistory,
  importCredentials,
}) => {
  if (!recovery || typeof recovery !== 'object') return { restored: false, failed: false };

  try {
    const hasHistory = Object.hasOwn(recovery, 'history') && recovery.history !== undefined;
    const hasCredentials =
      Object.hasOwn(recovery, 'credentials') && recovery.credentials !== undefined;

    if (hasHistory && !Array.isArray(recovery.history)) {
      throw new Error('Invalid cloud history');
    }
    if (hasCredentials && !Array.isArray(recovery.credentials)) {
      throw new Error('Invalid cloud credentials');
    }

    const history = hasHistory ? normalizeRecoveryHistoryEntries(recovery.history) : undefined;
    const credentials = hasCredentials
      ? normalizeRecoveryCredentials(recovery.credentials)
      : undefined;
    if (hasHistory && history === null) throw new Error('Invalid cloud history');
    if (hasCredentials && credentials === null) throw new Error('Invalid cloud credentials');

    // Encrypt every credential before replacing either cache. This prevents a safeStorage
    // failure from first overwriting the history cache with only half of the cloud snapshot.
    if (hasCredentials) importCredentials(credentials);
    if (hasHistory) importHistory(history);
    return { restored: hasHistory || hasCredentials, failed: false };
  } catch {
    if (normalizeCloudRecoveryVersion(cloudRecoveryVersion) >= CLOUD_RECOVERY_VERSION) {
      throw new Error('云端浏览历史或凭据恢复失败，已阻止使用陈旧本地缓存');
    }
    return { restored: false, failed: true };
  }
};

/**
 * Old backends keep receiving the exact pages/state request they already understand.
 * Recovery fields are added only after capability negotiation succeeds.
 */
export const buildBrowserSessionPayload = (snapshot, cloudRecoveryVersion) => {
  const pages = normalizeRecoveryPagesForUpload(snapshot.pages);
  if (pages === null) throw new Error('浏览器云端恢复数据格式无效');
  const payload = {
    id: snapshot.id,
    pages,
    state: snapshot.state ?? null,
  };

  if (normalizeCloudRecoveryVersion(cloudRecoveryVersion) < CLOUD_RECOVERY_VERSION) {
    return payload;
  }

  const credentials = normalizeRecoveryCredentials(snapshot.credentials);
  if (!Array.isArray(snapshot.history) || credentials === null) {
    throw new Error('浏览器云端恢复数据格式无效');
  }
  const history = normalizeRecoveryHistoryEntries(snapshot.history);
  if (history === null) {
    throw new Error('浏览器云端历史数据格式无效');
  }

  return {
    ...payload,
    history,
    credentials,
    recoveryRevision: normalizeRecoveryRevision(snapshot.recoveryRevision),
    cloudRecoveryVersion: CLOUD_RECOVERY_VERSION,
  };
};
