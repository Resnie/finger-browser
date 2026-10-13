import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  DEFAULT_PROXY_PROBE_TIMEOUT_MS,
  probeProxyConnectivity,
} from '../electron/main/models/proxyProbe.mjs';

const proxy = {
  server: 'http://proxy.example:8080',
  username: 'private-user',
  password: 'private-password',
};

const contextOptions = {
  executablePath: '/managed/chrome',
  args: ['--disable-background-networking'],
  userAgent: 'test-browser-agent',
  locale: 'zh-CN',
  // 业务会话数据绝不得被带入临时探测 profile。
  storageState: {
    cookies: [{ name: 'secret', value: 'must-not-leak', domain: '.example.com', path: '/' }],
    origins: [],
  },
};

const jsonTarget = [
  {
    name: 'mock-json',
    url: 'https://probe.example/ip',
    responseType: 'json',
  },
];

const createMockChromium = handler => {
  const calls = [];
  const removedProfiles = [];
  let contextClosed = false;
  let pageCloseCount = 0;

  const launchPersistentContext = async (profilePath, options) => {
    const context = new EventEmitter();
    context.newPage = async () => ({
      goto: async (url, requestOptions) => {
        calls.push({ profilePath, options, url, requestOptions });
        return handler(url, requestOptions);
      },
      close: async () => {
        pageCloseCount += 1;
      },
    });
    context.close = async () => {
      contextClosed = true;
    };
    context.browser = () => null;
    return context;
  };

  return {
    launchPersistentContext,
    createProfile: async () => '/tmp/mock-proxy-profile',
    removeProfile: async profilePath => removedProfiles.push(profilePath),
    calls,
    wasContextClosed: () => contextClosed,
    pageCloseCount: () => pageCloseCount,
    removedProfiles,
  };
};

const runProbe = (mock, overrides = {}) =>
  probeProxyConnectivity(proxy, {
    launchPersistentContext: mock.launchPersistentContext,
    contextOptions,
    createProfile: mock.createProfile,
    removeProfile: mock.removeProfile,
    targets: jsonTarget,
    ...overrides,
  });

test('探测必须使用真实 Chromium 内核和持久化上下文路径', async () => {
  const mock = createMockChromium(async () => ({
    status: () => 200,
    text: async () => JSON.stringify({ ip: '8.8.8.8' }),
  }));

  const result = await runProbe(mock);

  assert.deepEqual(result, { ok: true, target: 'mock-json' });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].profilePath, '/tmp/mock-proxy-profile');
  assert.equal(mock.calls[0].url.startsWith('https://'), true);
  assert.equal(mock.calls[0].requestOptions.timeout, DEFAULT_PROXY_PROBE_TIMEOUT_MS);
  assert.equal(mock.calls[0].requestOptions.waitUntil, 'domcontentloaded');
  assert.deepEqual(mock.calls[0].options.proxy, proxy);
  assert.equal(mock.calls[0].options.executablePath, contextOptions.executablePath);
  assert.deepEqual(mock.calls[0].options.args, contextOptions.args);
  assert.equal(mock.calls[0].options.userAgent, contextOptions.userAgent);
  assert.equal(mock.calls[0].options.locale, contextOptions.locale);
  assert.equal(mock.calls[0].options.headless, true);
  assert.equal(mock.calls[0].options.ignoreHTTPSErrors, false);
  assert.equal('storageState' in mock.calls[0].options, false);
  assert.equal(mock.wasContextClosed(), true);
  assert.equal(mock.pageCloseCount(), 1);
  assert.deepEqual(mock.removedProfiles, ['/tmp/mock-proxy-profile']);
});

test('支持无路径的 SOCKS5 代理地址', async () => {
  const mock = createMockChromium(async () => ({
    status: () => 200,
    text: async () => JSON.stringify({ ip: '1.1.1.1' }),
  }));
  const socksProxy = { server: 'socks5://proxy.example:1080' };

  await probeProxyConnectivity(socksProxy, {
    launchPersistentContext: mock.launchPersistentContext,
    contextOptions,
    createProfile: mock.createProfile,
    removeProfile: mock.removeProfile,
    targets: jsonTarget,
  });

  assert.deepEqual(mock.calls[0].options.proxy, socksProxy);
});

test('HTTP 407 阻止启动且错误不包含凭据', async () => {
  const mock = createMockChromium(async () => ({
    status: () => 407,
    text: async () => '',
  }));

  await assert.rejects(runProbe(mock), error => {
    assert.equal(error.code, 'PROXY_AUTH_REQUIRED');
    assert.match(error.message, /407/);
    assert.equal(error.message.includes(proxy.username), false);
    assert.equal(error.message.includes(proxy.password), false);
    return true;
  });
  assert.equal(mock.wasContextClosed(), true);
  assert.deepEqual(mock.removedProfiles, ['/tmp/mock-proxy-profile']);
});

test('Chromium 返回 ERR_EMPTY_RESPONSE 时阻止启动且不直连回退', async () => {
  const mock = createMockChromium(async () => {
    throw new Error(`page.goto: net::ERR_EMPTY_RESPONSE ${proxy.username}:${proxy.password}`);
  });

  await assert.rejects(runProbe(mock), error => {
    assert.equal(error.code, 'PROXY_UNREACHABLE');
    assert.equal(error.message.includes(proxy.username), false);
    assert.equal(error.message.includes(proxy.password), false);
    return true;
  });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0].options.proxy, proxy);
});

test('探测站返回无效内容时按无有效出口处理', async () => {
  const mock = createMockChromium(async () => ({
    status: () => 200,
    text: async () => '<html>captive portal</html>',
  }));

  await assert.rejects(runProbe(mock), error => error.code === 'PROXY_EXIT_INVALID');
});

test('探测站返回内网 IP 时不视为有效出口', async () => {
  const mock = createMockChromium(async () => ({
    status: () => 200,
    text: async () => JSON.stringify({ ip: '192.168.1.10' }),
  }));

  await assert.rejects(runProbe(mock), error => error.code === 'PROXY_EXIT_INVALID');
});

test('探测点串行尝试，一个失败后可由下一个确认出口', async () => {
  const mock = createMockChromium(async url => ({
    status: () => (url.includes('failed') ? 503 : 200),
    text: async () => 'ip=2606:4700:4700::1111\n',
  }));

  const result = await runProbe(mock, {
    targets: [
      { name: 'failed', url: 'https://failed.example/ip', responseType: 'plain' },
      { name: 'working', url: 'https://working.example/trace', responseType: 'trace' },
    ],
  });

  assert.deepEqual(result, { ok: true, target: 'working' });
  assert.deepEqual(
    mock.calls.map(call => call.url),
    ['https://failed.example/ip', 'https://working.example/trace']
  );
  assert.equal(mock.pageCloseCount(), 2);
});

test('临时 Chromium 内核启动失败时清理 profile 并失败关闭', async () => {
  const removedProfiles = [];

  await assert.rejects(
    probeProxyConnectivity(proxy, {
      launchPersistentContext: async () => {
        throw new Error(`failed with ${proxy.username}:${proxy.password}`);
      },
      contextOptions,
      targets: jsonTarget,
      createProfile: async () => '/tmp/mock-failed-profile',
      removeProfile: async profilePath => removedProfiles.push(profilePath),
    }),
    error => {
      assert.equal(error.code, 'PROXY_PROBE_UNAVAILABLE');
      assert.equal(error.message.includes(proxy.username), false);
      assert.equal(error.message.includes(proxy.password), false);
      return true;
    }
  );

  assert.deepEqual(removedProfiles, ['/tmp/mock-failed-profile']);
});

test('context.close 卡死时有界等待并改用 Browser.close 收口', async () => {
  const removedProfiles = [];
  let browserCloseCalled = 0;
  const context = new EventEmitter();
  context.newPage = async () => ({
    goto: async () => ({
      status: () => 200,
      text: async () => JSON.stringify({ ip: '8.8.8.8' }),
    }),
    close: async () => {},
  });
  context.close = () => new Promise(() => {});
  context.browser = () => ({
    close: async () => {
      browserCloseCalled += 1;
    },
  });

  const result = await probeProxyConnectivity(proxy, {
    launchPersistentContext: async () => context,
    contextOptions,
    targets: jsonTarget,
    closeTimeoutMs: 10,
    createProfile: async () => '/tmp/mock-hanging-context',
    removeProfile: async profilePath => removedProfiles.push(profilePath),
  });

  assert.deepEqual(result, { ok: true, target: 'mock-json' });
  assert.equal(browserCloseCalled, 1);
  assert.deepEqual(removedProfiles, ['/tmp/mock-hanging-context']);
});

test('探测页关闭卡死时仍会进入有界的 context 收口', async () => {
  const removedProfiles = [];
  let contextCloseCalled = 0;
  const context = new EventEmitter();
  context.newPage = async () => ({
    goto: async () => ({
      status: () => 200,
      text: async () => JSON.stringify({ ip: '8.8.8.8' }),
    }),
    close: () => new Promise(() => {}),
  });
  context.close = async () => {
    contextCloseCalled += 1;
  };
  context.browser = () => null;

  const result = await probeProxyConnectivity(proxy, {
    launchPersistentContext: async () => context,
    contextOptions,
    targets: jsonTarget,
    closeTimeoutMs: 10,
    createProfile: async () => '/tmp/mock-hanging-page',
    removeProfile: async profilePath => removedProfiles.push(profilePath),
  });

  assert.deepEqual(result, { ok: true, target: 'mock-json' });
  assert.equal(contextCloseCalled, 1);
  assert.deepEqual(removedProfiles, ['/tmp/mock-hanging-page']);
});

test('上下文和内核都无法关闭时阻止正式窗口启动', async () => {
  const removedProfiles = [];
  const context = new EventEmitter();
  context.newPage = async () => ({
    goto: async () => ({
      status: () => 200,
      text: async () => JSON.stringify({ ip: '8.8.8.8' }),
    }),
    close: async () => {},
  });
  context.close = () => new Promise(() => {});
  context.browser = () => ({ close: () => new Promise(() => {}) });

  await assert.rejects(
    probeProxyConnectivity(proxy, {
      launchPersistentContext: async () => context,
      contextOptions,
      targets: jsonTarget,
      closeTimeoutMs: 10,
      createProfile: async () => '/tmp/mock-hanging-browser',
      removeProfile: async profilePath => removedProfiles.push(profilePath),
    }),
    error => error.code === 'PROXY_PROBE_CLEANUP_FAILED'
  );

  assert.deepEqual(removedProfiles, ['/tmp/mock-hanging-browser']);
});

test('临时 profile 无法清理时不得将代理判为可启动', async () => {
  const mock = createMockChromium(async () => ({
    status: () => 200,
    text: async () => JSON.stringify({ ip: '8.8.8.8' }),
  }));

  await assert.rejects(
    runProbe(mock, {
      closeTimeoutMs: 10,
      removeProfile: async () => {
        throw new Error('cleanup failed');
      },
    }),
    error => error.code === 'PROXY_PROBE_CLEANUP_FAILED'
  );
});

test('缺少实际内核路径时禁止用其他网络客户端代替探测', async () => {
  const mock = createMockChromium(async () => ({
    status: () => 200,
    text: async () => JSON.stringify({ ip: '8.8.8.8' }),
  }));

  await assert.rejects(
    probeProxyConnectivity(proxy, {
      launchPersistentContext: mock.launchPersistentContext,
      contextOptions: {},
      createProfile: mock.createProfile,
      removeProfile: mock.removeProfile,
      targets: jsonTarget,
    }),
    error => error.code === 'PROXY_PROBE_UNAVAILABLE'
  );
  assert.equal(mock.calls.length, 0);
});

test('非 HTTPS 探测点在启动内核前被拒绝', async () => {
  const mock = createMockChromium(async () => ({
    status: () => 200,
    text: async () => '8.8.8.8',
  }));

  await assert.rejects(
    runProbe(mock, {
      targets: [{ name: 'unsafe', url: 'http://probe.example/ip', responseType: 'plain' }],
    }),
    error => error.code === 'PROXY_PROBE_UNAVAILABLE'
  );
  assert.equal(mock.calls.length, 0);
});
