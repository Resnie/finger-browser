export const normalizeInitialUrl = value => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
};

export const hasInitialUrlChanged = (previousUrl, nextUrl) =>
  normalizeInitialUrl(previousUrl) !== normalizeInitialUrl(nextUrl);

/**
 * URL 变化时将新地址作为一次性页面种子写入。
 * BrowserInstance 首次打开后会用实际页面快照覆盖它，之后仍按正常会话恢复。
 */
export const createBrowserEditPlan = ({ id, config, previousUrl }) => {
  const nextUrl = normalizeInitialUrl(config?.base?.url);
  const urlChanged = hasInitialUrlChanged(previousUrl, nextUrl);
  const payload = { id, config };
  if (urlChanged) {
    // URL 被清空时同时清除旧页面，下次启动由启动层创建 about:blank。
    payload.pages = nextUrl ? [{ url: nextUrl }] : [];
  }
  return { payload, urlChanged };
};
