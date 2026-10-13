export const BROWSER_LIFECYCLE_ACTIONS = Object.freeze({
  KEEP_OPEN: 'keep-open',
  CLOSE_AND_PRESERVE: 'close-and-preserve',
  CLOSE_AND_CLEAR: 'close-and-clear',
});

/**
 * 原子占用浏览器关闭流程。setInterval 的异步回调可能重叠执行，
 * 必须在第一个 await 之前立即置位，否则会并发发起多次 context.close()。
 */
export const claimBrowserLifecycleClose = instance => {
  if (!instance || typeof instance !== 'object') {
    throw new TypeError('浏览器实例无效');
  }
  if (instance.isClosing) return false;
  instance.isClosing = true;
  return true;
};

/**
 * 根据页面数量决定持久化浏览器的生命周期动作。
 * 没有任何打开页面时必须主动关闭 context；Chromium 在 macOS 上不会保证
 * 关闭最后一个窗口后自然触发 Playwright context close。
 */
export const resolveBrowserLifecycleAction = ({ openPageCount, validPageCount } = {}) => {
  if (!Number.isInteger(openPageCount) || !Number.isInteger(validPageCount)) {
    throw new TypeError('页面数量必须为整数');
  }
  if (openPageCount < 0 || validPageCount < 0 || validPageCount > openPageCount) {
    throw new RangeError('页面数量不合法');
  }
  if (validPageCount > 0) return BROWSER_LIFECYCLE_ACTIONS.KEEP_OPEN;
  if (openPageCount === 0) return BROWSER_LIFECYCLE_ACTIONS.CLOSE_AND_PRESERVE;
  return BROWSER_LIFECYCLE_ACTIONS.CLOSE_AND_CLEAR;
};

/**
 * 关闭 Playwright 上下文。macOS 上关闭最后一个标签时，close 事件可能已经到达，
 * 但 context.close() 仍迟迟不返回；任一信号确认关闭即可继续清理。
 */
export const closeContextWithTimeout = async (context, timeoutMs = 5000) => {
  if (!context || typeof context.close !== 'function' || typeof context.once !== 'function') {
    throw new TypeError('浏览器上下文不可关闭');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('关闭超时时间必须大于 0');
  }

  let timeoutId;
  let onClosed;
  const closedEvent = new Promise(resolve => {
    onClosed = resolve;
    context.once('close', onClosed);
  });

  try {
    const closeOperation = context.close();
    await Promise.race([
      closeOperation,
      closedEvent,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('context.close() 超时')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    context.removeListener?.('close', onClosed);
  }
};

/**
 * 生命周期自动关闭时，优雅关闭失败必须进入已受控路径的进程清理。
 * 不向上抛出关闭细节，由调用方根据结果记录不含敏感信息的日志。
 */
export const closeLifecycleContext = async ({ closeGracefully, forceClose } = {}) => {
  if (typeof closeGracefully !== 'function' || typeof forceClose !== 'function') {
    throw new TypeError('浏览器关闭函数无效');
  }

  try {
    if ((await closeGracefully()) === true) {
      return { closed: true, graceful: true, forced: false };
    }
  } catch {}

  try {
    const closed = (await forceClose()) === true;
    return { closed, graceful: false, forced: true };
  } catch {
    return { closed: false, graceful: false, forced: true };
  }
};
