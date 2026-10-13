import { randomBytes } from 'node:crypto';

export const SESSION_STORAGE_LIMITS = Object.freeze({
  tabs: 100,
  originsPerTab: 20,
  entriesPerOrigin: 1000,
  nameLength: 1024,
  valueLength: 1024 * 1024,
  totalBytes: 2 * 1024 * 1024,
});

export const isTrustedSessionStorageCheckpoint = (source, checkpoint) => {
  try {
    return Boolean(
      source?.page &&
        source.frame === source.page.mainFrame() &&
        source.frame.url() === checkpoint?.url &&
        source.page.url() === checkpoint.url &&
        new URL(source.frame.url()).origin === checkpoint.origin
    );
  } catch {
    return false;
  }
};

const plain = value =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validOrigin = value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
};

export const normalizeSessionStorage = value => {
  try {
    if (!Array.isArray(value) || value.length > SESSION_STORAGE_LIMITS.tabs) return null;
    const tabs = [];
    const indices = new Set();
    for (const tab of value) {
      if (
        !plain(tab) ||
        !Number.isSafeInteger(tab.index) ||
        tab.index < 0 ||
        tab.index >= SESSION_STORAGE_LIMITS.tabs ||
        indices.has(tab.index) ||
        typeof tab.url !== 'string' ||
        tab.url.length > 8192 ||
        !Array.isArray(tab.origins) ||
        tab.origins.length > SESSION_STORAGE_LIMITS.originsPerTab
      )
        return null;
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      indices.add(tab.index);
      const origins = [];
      const seen = new Set();
      for (const origin of tab.origins) {
        if (
          !plain(origin) ||
          !validOrigin(origin.origin) ||
          seen.has(origin.origin) ||
          !Array.isArray(origin.entries) ||
          origin.entries.length > SESSION_STORAGE_LIMITS.entriesPerOrigin
        )
          return null;
        seen.add(origin.origin);
        const entries = [];
        const names = new Set();
        for (const entry of origin.entries) {
          if (
            !plain(entry) ||
            typeof entry.name !== 'string' ||
            entry.name.length > SESSION_STORAGE_LIMITS.nameLength ||
            typeof entry.value !== 'string' ||
            entry.value.length > SESSION_STORAGE_LIMITS.valueLength ||
            names.has(entry.name)
          )
            return null;
          names.add(entry.name);
          entries.push({ name: entry.name, value: entry.value });
        }
        origins.push({ origin: origin.origin, entries });
      }
      tabs.push({ index: tab.index, url: tab.url, origins });
    }
    if (Buffer.byteLength(JSON.stringify(tabs)) > SESSION_STORAGE_LIMITS.totalBytes) return null;
    return tabs;
  } catch {
    return null;
  }
};

export const captureSessionStorage = async (pages, previous = []) => {
  const tabs = [];
  for (const [index, page] of pages.entries()) {
    if (page.isClosed()) continue;
    const url = page.url();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    const origins = new Map();
    for (const frame of page.frames()) {
      try {
        const saved = await frame.evaluate(() => ({
          origin: location.origin,
          entries: Object.entries(sessionStorage).map(([name, value]) => ({ name, value })),
        }));
        if (validOrigin(saved.origin)) origins.set(saved.origin, saved);
      } catch {
        // 导航时 frame 可能被销毁，保留同一标签同一地址的上次检查点。
        const cached = previous.find(tab => tab.index === index && tab.url === url);
        for (const origin of cached?.origins || []) {
          if (!origins.has(origin.origin)) origins.set(origin.origin, origin);
        }
      }
    }
    tabs.push({ index, url, origins: [...origins.values()] });
  }
  const normalized = normalizeSessionStorage(tabs);
  if (!normalized) throw new Error('标签页临时存储超过同步限制或格式无效');
  return normalized;
};

export const selectSessionStorageForTab = (tabs, url, index) => {
  const normalized = normalizeSessionStorage(tabs);
  if (!normalized) throw new Error('云端标签页临时存储格式无效');
  return normalized.find(tab => tab.index === index && tab.url === url) || null;
};

/** 页面身份不随位置变化，快照index在标签关闭/新增后按当前拓扑重新编号。 */
export const reindexSessionStorageTabs = ({
  pages,
  byPage,
  indices,
  previousTabs = [],
  closedTabs = [],
}) => {
  const tabs = pages.length
    ? pages.map((page, index) => {
        const oldIndex = indices.get(page);
        const cached =
          byPage.get(page) ||
          previousTabs.find(tab => tab.index === oldIndex && tab.url === page.url());
        const tab = { index, url: page.url(), origins: structuredClone(cached?.origins || []) };
        indices.set(page, index);
        byPage.set(page, tab);
        return tab;
      })
    : closedTabs.map(({ page, url }, index) => ({
        index,
        url,
        origins: structuredClone(byPage.get(page)?.origins || []),
      }));
  const normalized = normalizeSessionStorage(tabs.filter(tab => /^https?:/.test(tab.url)));
  if (!normalized) throw new Error('标签页临时状态拓扑无效');
  return normalized;
};

// CDP脚本只服务本次恢复导航；调用方导航完成后删除，用户清理或修改
// sessionStorage 后重新加载页面不会再次被旧快照覆盖。
export const installSessionStorageForNavigation = async (context, page, snapshot) => {
  if (!snapshot?.origins?.length) return null;
  const cdp = await context.newCDPSession(page);
  const marker = '__fingerSessionRestore_' + randomBytes(16).toString('hex');
  const source = `(() => { const snapshots = ${JSON.stringify(snapshot.origins)};
    const saved = snapshots.find(item => item.origin === location.origin);
    if (!saved) return;
    sessionStorage.clear();
    for (const item of saved.entries) sessionStorage.setItem(item.name, item.value);
    Object.defineProperty(globalThis, ${JSON.stringify(marker)}, { value: true, configurable: true });
  })();`;
  let identifier;
  try {
    await cdp.send('Page.enable');
    ({ identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }));
  } catch (error) {
    await cdp.detach().catch(() => {});
    throw error;
  }
  const remove = async () => {
    page.off('close', onClose);
    try {
      if (!page.isClosed()) {
        await page.waitForFunction(key => globalThis[key] === true, marker, { timeout: 15000 });
        for (const frame of typeof page.frames === 'function' ? page.frames() : [page])
          await frame.evaluate(key => { delete globalThis[key]; }, marker).catch(() => {});
      }
    } catch {
      const error = new Error('标签页临时存储恢复未完成，已阻止部分会话启动');
      error.code = 'BROWSER_SESSION_STORAGE_RESTORE_FAILED';
      throw error;
    } finally {
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  };
  const onClose = () => {
    void remove().catch(() => {});
  };
  page.once('close', onClose);
  return remove;
};
