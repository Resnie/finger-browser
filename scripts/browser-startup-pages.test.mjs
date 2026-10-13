import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROXY_STARTUP_NAVIGATION_FAILED,
  restoreStartupPages,
} from '../electron/main/models/startupPageRestore.mjs';

class FakePage {
  constructor(url = 'about:blank', outcomes = []) {
    this.currentUrl = url;
    this.outcomes = [...outcomes];
    this.gotoCalls = [];
    this.closed = false;
  }

  isClosed() {
    return this.closed;
  }

  url() {
    return this.currentUrl;
  }

  async goto(url, options) {
    this.gotoCalls.push({ url, options });
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    this.currentUrl = url;
    return outcome ?? { ok: true };
  }

  async close() {
    this.closed = true;
  }
}

const createContext = ({ pages = [], newPageOutcomes = [] } = {}) => {
  const allPages = [...pages];
  let nextPage = 0;
  return {
    pages: () => allPages,
    newPage: async () => {
      const page = new FakePage('about:blank', newPageOutcomes[nextPage] || []);
      nextPage++;
      allPages.push(page);
      return page;
    },
  };
};

const isInternalPageUrl = url =>
  !url ||
  url.startsWith('chrome://') ||
  url.startsWith('chrome-extension://') ||
  url.startsWith('devtools://');

const restore = options =>
  restoreStartupPages({
    context: options.context,
    savedPages: options.savedPages,
    initialUrl: options.initialUrl,
    proxyEnabled: options.proxyEnabled,
    isInternalPageUrl,
    logger: options.logger,
    navigationTimeoutMs: 1234,
  });

test('代理初始页导航失败时阻止启动且不泄露原始异常', async () => {
  const secret = 'test-private-proxy-password';
  const page = new FakePage('about:blank', [new Error(`ERR_TUNNEL_CONNECTION_FAILED ${secret}`)]);
  const context = createContext({ pages: [page] });
  const warnings = [];

  await assert.rejects(
    restore({
      context,
      initialUrl: 'https://initial.example/private-path',
      proxyEnabled: true,
      logger: { warn: message => warnings.push(message) },
    }),
    error => {
      assert.equal(error.code, PROXY_STARTUP_NAVIGATION_FAILED);
      assert.match(error.message, /已关闭浏览器/);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('initial.example'), false);
      return true;
    }
  );
  assert.deepEqual(page.gotoCalls, [
    { url: 'https://initial.example/private-path', options: { timeout: 1234 } },
  ]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes(secret), false);
  assert.equal(warnings[0].includes('initial.example'), false);
});

test('代理多页恢复只要一页成功即可启动', async () => {
  const first = new FakePage('about:blank', [new Error('ERR_TUNNEL_CONNECTION_FAILED')]);
  const extra = new FakePage('https://stale.example');
  const context = createContext({ pages: [first, extra], newPageOutcomes: [[{ ok: true }]] });

  const result = await restore({
    context,
    savedPages: [{ url: 'https://failed.example' }, { url: 'https://working.example' }],
    proxyEnabled: true,
  });

  assert.deepEqual(result, {
    attemptedNavigationCount: 2,
    successfulNavigationCount: 1,
    failedNavigationCount: 1,
    mode: 'saved',
  });
  assert.equal(extra.closed, true);
  assert.equal(context.pages().at(-1).url(), 'https://working.example');
});

test('代理多页恢复全部失败时阻止启动', async () => {
  const first = new FakePage('about:blank', [new Error('test-first-failure')]);
  const context = createContext({
    pages: [first],
    newPageOutcomes: [[new Error('test-second-failure')]],
  });

  await assert.rejects(
    restore({
      context,
      savedPages: [{ url: 'https://first.example' }, { url: 'https://second.example' }],
      proxyEnabled: true,
    }),
    error => error.code === PROXY_STARTUP_NAVIGATION_FAILED
  );
});

test('非代理单页导航失败保留现有容错语义', async () => {
  const page = new FakePage('about:blank', [new Error('test-site-temporarily-unavailable')]);
  const result = await restore({
    context: createContext({ pages: [page] }),
    initialUrl: 'https://ordinary.example',
    proxyEnabled: false,
  });

  assert.deepEqual(result, {
    attemptedNavigationCount: 1,
    successfulNavigationCount: 0,
    failedNavigationCount: 1,
    mode: 'initial',
  });
});

test('代理窗口无初始 URL 时保留空白页并允许启动', async () => {
  const context = createContext();
  const result = await restore({ context, initialUrl: '', proxyEnabled: true });

  assert.deepEqual(result, {
    attemptedNavigationCount: 0,
    successfulNavigationCount: 0,
    failedNavigationCount: 0,
    mode: 'blank',
  });
  assert.equal(context.pages().length, 1);
  assert.equal(context.pages()[0].url(), 'about:blank');
});

test('服务端 pages 为空时首次打开使用编辑后的初始 URL', async () => {
  const page = new FakePage('about:blank');
  const context = createContext({ pages: [page] });
  const result = await restore({
    context,
    savedPages: [],
    initialUrl: 'https://edited.example/landing',
    proxyEnabled: false,
  });

  assert.deepEqual(result, {
    attemptedNavigationCount: 1,
    successfulNavigationCount: 1,
    failedNavigationCount: 0,
    mode: 'initial',
  });
  assert.equal(page.url(), 'https://edited.example/landing');
});

test('about:blank 与 Chromium 已恢复的现有页面无需额外导航', async () => {
  const blank = new FakePage('about:blank');
  const blankResult = await restore({
    context: createContext({ pages: [blank] }),
    initialUrl: 'about:blank',
    proxyEnabled: true,
  });
  assert.equal(blankResult.attemptedNavigationCount, 0);

  const restored = new FakePage('https://restored.example/session');
  const existingResult = await restore({
    context: createContext({ pages: [restored] }),
    initialUrl: 'https://configured.example',
    proxyEnabled: true,
  });
  assert.equal(existingResult.mode, 'existing');
  assert.equal(existingResult.attemptedNavigationCount, 0);
  assert.equal(restored.gotoCalls.length, 0);
});

test('无效的保存页不影响有效初始 URL 导航', async () => {
  const page = new FakePage('about:blank');
  const result = await restore({
    context: createContext({ pages: [page] }),
    savedPages: [
      null,
      {},
      { url: 'about:blank' },
      { url: 'data:text/html,test-runtime-page' },
      { url: 'blob:https://example.com/test-runtime-id' },
      { url: 'javascript:alert(1)' },
    ],
    initialUrl: 'https://initial.example',
    proxyEnabled: true,
  });

  assert.equal(result.mode, 'initial');
  assert.equal(result.successfulNavigationCount, 1);
  assert.equal(page.url(), 'https://initial.example');
});
