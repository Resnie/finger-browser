import { isRestorableBrowserPageUrl } from './browserPageUrl.mjs';

export const PROXY_STARTUP_NAVIGATION_FAILED = 'PROXY_STARTUP_NAVIGATION_FAILED';

export class ProxyStartupNavigationError extends Error {
  constructor() {
    super('无法通过代理打开初始或恢复页面，已关闭浏览器。请检查代理和页面地址');
    this.name = 'ProxyStartupNavigationError';
    this.code = PROXY_STARTUP_NAVIGATION_FAILED;
  }
}

const isValidSavedPageUrl = url => isRestorableBrowserPageUrl(url);

const logNavigationFailure = (logger, proxyEnabled, label, error) => {
  if (proxyEnabled) {
    // 代理异常可能夹带认证信息，不记录原始异常或目标 URL。
    logger?.warn?.(`${label}失败，代理无法访问目标页面`);
    return;
  }
  logger?.warn?.(`${label}失败: ${error?.message || '未知错误'}`);
};

/**
 * 恢复浏览器启动页。
 *
 * 代理启用时，只有在本次确实需要导航、且所有目标均导航失败时才阻止启动。
 * 空白页、无初始 URL，或 Chromium 已恢复的现有页面不需要额外导航。
 * 非代理窗口继续保留现有容错语义：单页导航失败不阻止打开窗口。
 */
export const restoreStartupPages = async ({
  context,
  savedPages = [],
  initialUrl = '',
  proxyEnabled = false,
  isInternalPageUrl,
  logger,
  navigationTimeoutMs = 10000,
  beforeNavigate,
}) => {
  if (!context || typeof context.pages !== 'function' || typeof context.newPage !== 'function') {
    throw new Error('浏览器上下文不可用');
  }

  const isInternal =
    typeof isInternalPageUrl === 'function'
      ? isInternalPageUrl
      : url =>
          !url ||
          url.startsWith('chrome://') ||
          url.startsWith('chrome-extension://') ||
          url.startsWith('devtools://');

  const allPages = context.pages();
  const existingPages = allPages.filter(page => {
    if (page.isClosed()) return false;
    return !isInternal(page.url());
  });
  const targetInitialUrl = initialUrl || 'about:blank';
  const result = {
    attemptedNavigationCount: 0,
    successfulNavigationCount: 0,
    failedNavigationCount: 0,
    mode: 'existing',
  };

  logger?.info?.(`有效页面数量: ${existingPages.length} (总数: ${allPages.length})`);

  const navigate = async (page, url, label, index = 0) => {
    // 恢复失败必须向调用方传播，避免打开缺少sessionStorage的部分会话。
    let afterNavigation;
    try {
      afterNavigation =
        typeof beforeNavigate === 'function' ? await beforeNavigate(page, url, index) : null;
    } catch (error) {
      error.code = 'BROWSER_SESSION_STORAGE_RESTORE_FAILED';
      throw error;
    }
    result.attemptedNavigationCount++;
    try {
      await page.goto(url, { timeout: navigationTimeoutMs });
      result.successfulNavigationCount++;
      return true;
    } catch (error) {
      result.failedNavigationCount++;
      logNavigationFailure(logger, proxyEnabled, label, error);
      return false;
    } finally {
      if (typeof afterNavigation === 'function') await afterNavigation();
    }
  };

  const assertProxyTargetReached = () => {
    if (
      proxyEnabled &&
      result.attemptedNavigationCount > 0 &&
      result.successfulNavigationCount === 0
    ) {
      throw new ProxyStartupNavigationError();
    }
  };

  const validSavedPages = Array.isArray(savedPages)
    ? savedPages.filter(page => isValidSavedPageUrl(page?.url))
    : [];

  if (validSavedPages.length > 0) {
    result.mode = 'saved';
    logger?.info?.(`恢复 ${validSavedPages.length} 个保存的页面`);

    const keepPages = new Set();
    const firstPage = existingPages.length > 0 ? existingPages[0] : await context.newPage();
    keepPages.add(firstPage);
    await navigate(firstPage, validSavedPages[0].url, '恢复页面');

    for (let i = 1; i < validSavedPages.length; i++) {
      try {
        const page = await context.newPage();
        keepPages.add(page);
        await navigate(page, validSavedPages[i].url, '恢复页面', i);
      } catch (error) {
        if (error.code === 'BROWSER_SESSION_STORAGE_RESTORE_FAILED') throw error;
        result.attemptedNavigationCount++;
        result.failedNavigationCount++;
        logNavigationFailure(logger, proxyEnabled, '创建恢复页面', error);
      }
    }

    const currentPages = context.pages().filter(page => !page.isClosed());
    for (const page of currentPages) {
      if (!keepPages.has(page)) {
        try {
          await page.close();
        } catch {}
      }
    }

    assertProxyTargetReached();
    return result;
  }

  if (existingPages.length === 0) {
    result.mode = targetInitialUrl === 'about:blank' ? 'blank' : 'initial';
    const page = await context.newPage();
    if (targetInitialUrl !== 'about:blank') {
      await navigate(page, targetInitialUrl, '导航到初始 URL');
    }
    logger?.info?.('已创建初始页面');
    assertProxyTargetReached();
    return result;
  }

  const firstPage = existingPages[0];
  const firstPageUrl = firstPage.url();
  if (
    targetInitialUrl &&
    targetInitialUrl !== 'about:blank' &&
    (firstPageUrl === 'about:blank' || firstPageUrl === '')
  ) {
    result.mode = 'initial';
    const navigated = await navigate(firstPage, targetInitialUrl, '导航到初始 URL');
    if (navigated) logger?.info?.('已导航到初始 URL');
  }

  assertProxyTargetReached();
  return result;
};
