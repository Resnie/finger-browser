export const MAX_HISTORY_ENTRIES = 1000;
export const HISTORY_ENTRY_LIMITS = Object.freeze({
  urlLength: 4096,
  titleLength: 4096,
  faviconLength: 32 * 1024,
  totalStringLength: 2 * 1024 * 1024,
});

export const isRecordableHistoryUrl = rawUrl => {
  if (
    typeof rawUrl !== 'string' ||
    !rawUrl.trim() ||
    rawUrl.length > HISTORY_ENTRY_LIMITS.urlLength
  ) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    return ['http:', 'https:', 'file:'].includes(parsed.protocol);
  } catch {
    return false;
  }
};

export const normalizeHistoryEntries = (rawEntries, limit = MAX_HISTORY_ENTRIES) => {
  if (!Array.isArray(rawEntries)) return [];

  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_HISTORY_ENTRIES;
  const entries = [];
  const seenUrls = new Set();
  let totalStringLength = 0;

  for (const item of rawEntries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!isRecordableHistoryUrl(item.url)) continue;

    const url = item.url.trim();
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const title =
      typeof item.title === 'string' &&
      item.title.length <= HISTORY_ENTRY_LIMITS.titleLength &&
      !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.title)
        ? item.title
        : '';
    const favicon =
      typeof item.favicon === 'string' &&
      item.favicon.length <= HISTORY_ENTRY_LIMITS.faviconLength &&
      !/[\0-\x1f\x7f]/.test(item.favicon)
        ? item.favicon
        : '';
    totalStringLength += url.length + title.length + favicon.length;
    if (totalStringLength > HISTORY_ENTRY_LIMITS.totalStringLength) break;

    entries.push({
      url,
      title,
      favicon,
      visitCount:
        Number.isSafeInteger(item.visitCount) && item.visitCount > 0 ? item.visitCount : 1,
      lastVisitTime:
        Number.isFinite(item.lastVisitTime) && item.lastVisitTime >= 0 ? item.lastVisitTime : 0,
    });

    if (entries.length >= safeLimit) break;
  }

  return entries;
};

export const normalizeRecoveryHistoryEntries = rawEntries => {
  if (!Array.isArray(rawEntries) || rawEntries.length > MAX_HISTORY_ENTRIES) return null;
  const normalized = normalizeHistoryEntries(rawEntries);
  if (normalized.length !== rawEntries.length) return null;
  for (let index = 0; index < rawEntries.length; index += 1) {
    const raw = rawEntries[index];
    const safe = normalized[index];
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      typeof raw.title !== 'string' ||
      raw.title.length > HISTORY_ENTRY_LIMITS.titleLength ||
      /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw.title) ||
      typeof raw.favicon !== 'string' ||
      raw.favicon.length > HISTORY_ENTRY_LIMITS.faviconLength ||
      /[\0-\x1f\x7f]/.test(raw.favicon) ||
      !Number.isSafeInteger(raw.visitCount) ||
      raw.visitCount <= 0 ||
      !Number.isSafeInteger(raw.lastVisitTime) ||
      raw.lastVisitTime < 0 ||
      safe.url !== raw.url.trim()
    ) {
      return null;
    }
  }
  return normalized;
};

/** 清空历史的云端 CAS 被拒绝时，恢复旧历史并保留 HTTP 等待期间的新导航。 */
export const mergeHistoryAfterRejectedClear = (originalEntries, currentEntries) => {
  const original = normalizeRecoveryHistoryEntries(originalEntries);
  const current = normalizeRecoveryHistoryEntries(currentEntries);
  if (original === null || current === null) {
    throw new Error('历史回滚数据格式无效');
  }

  const originalByUrl = new Map(original.map(entry => [entry.url, entry]));
  const merged = current.map(entry => {
    const before = originalByUrl.get(entry.url);
    if (!before) return entry;
    originalByUrl.delete(entry.url);
    return {
      url: entry.url,
      title: entry.title || before.title,
      favicon: entry.favicon || before.favicon,
      visitCount: before.visitCount + entry.visitCount,
      lastVisitTime: Math.max(before.lastVisitTime, entry.lastVisitTime),
    };
  });
  merged.push(...originalByUrl.values());
  return merged.slice(0, MAX_HISTORY_ENTRIES);
};

const normalizedMetadata = (value, maxLength) => {
  if (typeof value !== 'string' || value.length > maxLength) return '';
  const invalidControl =
    maxLength === HISTORY_ENTRY_LIMITS.faviconLength
      ? /[\0-\x1f\x7f]/.test(value)
      : /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
  return invalidControl ? '' : value;
};
const normalizedTime = value => (Number.isFinite(value) && value >= 0 ? value : Date.now());

const updateMetadata = (entry, title, favicon) => {
  const safeTitle = normalizedMetadata(title, HISTORY_ENTRY_LIMITS.titleLength);
  const safeFavicon = normalizedMetadata(favicon, HISTORY_ENTRY_LIMITS.faviconLength);
  if (safeTitle) entry.title = safeTitle;
  if (safeFavicon) entry.favicon = safeFavicon;
};

export const addHistoryVisit = (rawEntries, url, title = '', favicon = '', now = Date.now()) => {
  const entries = normalizeHistoryEntries(rawEntries);
  if (!isRecordableHistoryUrl(url)) return entries;

  const normalizedUrl = url.trim();
  const existing = entries.find(entry => entry.url === normalizedUrl);
  if (existing) {
    updateMetadata(existing, title, favicon);
    existing.visitCount += 1;
    existing.lastVisitTime = normalizedTime(now);
  } else {
    entries.unshift({
      url: normalizedUrl,
      title: normalizedMetadata(title, HISTORY_ENTRY_LIMITS.titleLength),
      favicon: normalizedMetadata(favicon, HISTORY_ENTRY_LIMITS.faviconLength),
      visitCount: 1,
      lastVisitTime: normalizedTime(now),
    });
  }

  if (entries.length > MAX_HISTORY_ENTRIES) entries.length = MAX_HISTORY_ENTRIES;
  return entries;
};

export const ensureHistoryEntry = (rawEntries, url, title = '', favicon = '', now = Date.now()) => {
  const entries = normalizeHistoryEntries(rawEntries);
  if (!isRecordableHistoryUrl(url)) return entries;

  const normalizedUrl = url.trim();
  const existing = entries.find(entry => entry.url === normalizedUrl);
  if (existing) {
    updateMetadata(existing, title, favicon);
  } else {
    entries.unshift({
      url: normalizedUrl,
      title: normalizedMetadata(title, HISTORY_ENTRY_LIMITS.titleLength),
      favicon: normalizedMetadata(favicon, HISTORY_ENTRY_LIMITS.faviconLength),
      visitCount: 1,
      lastVisitTime: normalizedTime(now),
    });
  }

  if (entries.length > MAX_HISTORY_ENTRIES) entries.length = MAX_HISTORY_ENTRIES;
  return entries;
};

export const updateHistoryMetadata = (rawEntries, url, title = '', favicon = '') => {
  const entries = normalizeHistoryEntries(rawEntries);
  if (!isRecordableHistoryUrl(url)) return entries;

  const normalizedUrl = url.trim();
  const existing = entries.find(entry => entry.url === normalizedUrl);
  if (existing) updateMetadata(existing, title, favicon);
  return entries;
};
