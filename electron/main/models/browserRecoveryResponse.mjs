import { normalizeBrowserStorageState } from './browserStorageState.mjs';
import { normalizeRecoveryCredentials } from './browserRecovery.mjs';
import { normalizeRecoveryHistoryEntries } from './historyEntries.mjs';
import { isRestorableBrowserPageUrl, isTransientRecoveryPageUrl } from './browserPageUrl.mjs';

const MAX_RECOVERY_JSON_LENGTH = 32 * 1024 * 1024;
const MAX_RECOVERY_PAGES = 100;
const MAX_RECOVERY_PAGE_URL_LENGTH = 4096;
const MAX_RECOVERY_PAGE_TITLE_LENGTH = 4096;
const isPlainObject = value => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const parseJsonField = (value, field, { emptyStringAsNull = false } = {}) => {
  if (typeof value !== 'string') return value;
  // 后端新建窗口的加密空 state 解密后是空字符串。对 state 将它
  // 明确视为“云端权威空快照”；其他字段仍严格拒绝空字符串。
  if (emptyStringAsNull && value === '') return null;
  if (value.length > MAX_RECOVERY_JSON_LENGTH) {
    throw new Error(`云端恢复字段超限: ${field}`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`云端恢复字段格式无效: ${field}`);
  }
};

const normalizePages = rawPages => {
  if (!Array.isArray(rawPages) || rawPages.length > MAX_RECOVERY_PAGES) return null;
  const pages = [];
  for (const page of rawPages) {
    if (
      !isPlainObject(page) ||
      typeof page.url !== 'string' ||
      !page.url ||
      page.url.length > MAX_RECOVERY_PAGE_URL_LENGTH
    ) {
      return null;
    }
    if (isTransientRecoveryPageUrl(page.url)) continue;
    if (!isRestorableBrowserPageUrl(page.url)) return null;
    if (
      Object.hasOwn(page, 'title') &&
      (typeof page.title !== 'string' ||
        page.title.length > MAX_RECOVERY_PAGE_TITLE_LENGTH ||
        /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(page.title))
    ) {
      return null;
    }
    pages.push({
      url: page.url,
      ...(typeof page.title === 'string' ? { title: page.title } : {}),
    });
  }
  return pages;
};

/** Parse the authenticated main-process recovery endpoint without exposing raw values to logs. */
export const parseBrowserRecoveryResponse = rawData => {
  if (!isPlainObject(rawData)) throw new Error('云端恢复详情格式无效');
  for (const field of ['pages', 'state', 'history', 'credentials']) {
    if (!Object.hasOwn(rawData, field)) {
      throw new Error(`云端恢复详情缺少字段: ${field}`);
    }
  }

  const pages = normalizePages(parseJsonField(rawData.pages, 'pages'));
  const rawState = parseJsonField(rawData.state, 'state', { emptyStringAsNull: true });
  const state = rawState === null ? null : normalizeBrowserStorageState(rawState);
  const history = normalizeRecoveryHistoryEntries(parseJsonField(rawData.history, 'history'));
  const credentials = normalizeRecoveryCredentials(
    parseJsonField(rawData.credentials, 'credentials')
  );
  const recoveryRevision = Number(rawData.recoveryRevision ?? rawData.recovery_revision);

  if (
    pages === null ||
    (rawState !== null && state === null) ||
    history === null ||
    credentials === null ||
    !Number.isSafeInteger(recoveryRevision) ||
    recoveryRevision < 0
  ) {
    throw new Error('云端恢复详情校验失败');
  }
  return { pages, state, history, credentials, recoveryRevision };
};

/** v0 旧后端没有单条 recovery 接口，主进程从已鉴权 search 行只提取页面/状态。 */
export const parseLegacyBrowserSearchRecovery = rawData => {
  if (!isPlainObject(rawData)) throw new Error('旧协议恢复行格式无效');
  const pages = normalizePages(parseJsonField(rawData.pages ?? '[]', 'pages'));
  const rawState = parseJsonField(rawData.state ?? null, 'state', { emptyStringAsNull: true });
  const state = rawState === null ? null : normalizeBrowserStorageState(rawState);
  if (pages === null || (rawState !== null && state === null)) {
    throw new Error('旧协议恢复行校验失败');
  }
  return { pages, state, recoveryRevision: 0 };
};
