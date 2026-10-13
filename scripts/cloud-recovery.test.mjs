import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_RECOVERY_LIMITS,
  buildBrowserSessionPayload,
  importCloudRecoveryCaches,
  normalizeRecoveryCredentials,
} from '../electron/main/models/browserRecovery.mjs';
import {
  applyAuthoritativeNameValueSnapshot,
  awaitPendingStorageCapture,
  buildAuthoritativeCookiePlan,
  buildAuthoritativeOriginUnion,
  buildAuthoritativeOriginStoragePlan,
  shouldApplyInitialCookies,
  withStorageOperationTimeout,
} from '../electron/main/models/authoritativeStorage.mjs';
import {
  buildGoogleAuthCloudValue,
  normalizeGoogleAuthPreparationOptions,
  normalizeGoogleAuthSecret,
} from '../electron/utils/googleAuthProtocol.mjs';
import { shouldCollectRecoveryPageUrl } from '../electron/main/models/browserPageUrl.mjs';

const snapshot = {
  id: 'test-cloud-recovery',
  pages: [{ url: 'https://example.com' }],
  state: { cookies: [], origins: [] },
  history: [
    {
      url: 'https://example.com',
      title: 'test-title',
      favicon: '',
      visitCount: 1,
      lastVisitTime: 1,
    },
  ],
  credentials: [
    {
      domain: 'EXAMPLE.COM',
      username: 'test-user',
      password: 'test-password',
      lastUsedTime: 1,
    },
  ],
  recoveryRevision: 7,
};

test('旧后端 payload 不包含恢复字段，新后端携带 CAS revision', () => {
  const legacy = buildBrowserSessionPayload(snapshot, 0);
  assert.deepEqual(Object.keys(legacy).sort(), ['id', 'pages', 'state']);

  const current = buildBrowserSessionPayload(snapshot, 1);
  assert.equal(current.cloudRecoveryVersion, 1);
  assert.equal(current.recoveryRevision, 7);
  assert.equal(current.credentials[0].domain, 'example.com');
  assert.equal(current.credentials[0].password, 'test-password');
  assert.equal(current.history[0].url, 'https://example.com');
});

test('空初始 URL 与不可跨设备的瞬态页不进入云端 pages', () => {
  const snapshot = {
    id: 'test-browser',
    pages: [{ url: 'about:blank' }],
    state: null,
    history: [],
    credentials: [],
    recoveryRevision: 0,
  };
  assert.deepEqual(buildBrowserSessionPayload(snapshot, 0).pages, []);
  assert.deepEqual(buildBrowserSessionPayload(snapshot, 1).pages, []);
  assert.deepEqual(
    buildBrowserSessionPayload(
      { ...snapshot, pages: [{ url: 'chrome-error://chromewebdata/' }] },
      1
    ).pages,
    []
  );
  for (const url of [
    'data:text/html,<title>fingerprint</title>',
    'blob:https://example.com/test-runtime-id',
    'about:srcdoc',
    'chrome://version/',
    'chrome-extension://test-extension/page.html',
    'devtools://devtools/bundled/inspector.html',
  ]) {
    assert.deepEqual(
      buildBrowserSessionPayload({ ...snapshot, pages: [{ url }] }, 1).pages,
      [],
      url
    );
  }
});

test('瞬态页可过滤，但损坏的 HTTP(S) 与其他非法协议仍失败关闭', () => {
  const snapshot = {
    id: 'test-browser',
    pages: [],
    state: null,
    history: [],
    credentials: [],
    recoveryRevision: 0,
  };
  for (const url of ['https://', 'http:// bad.example', 'javascript:alert(1)']) {
    assert.throws(
      () => buildBrowserSessionPayload({ ...snapshot, pages: [{ url }] }, 1),
      /恢复数据格式无效/,
      url
    );
  }
});

test('BrowserInstance 采集规则只忽略已知瞬态页，其他异常值交给上传层失败关闭', () => {
  for (const url of [
    'about:blank',
    'data:text/html,test',
    'blob:https://example.com/test-runtime-id',
    'chrome-error://chromewebdata/',
    'chrome://newtab/',
    'devtools://devtools/bundled/inspector.html',
  ]) {
    assert.equal(shouldCollectRecoveryPageUrl(url), false, url);
  }
  assert.equal(shouldCollectRecoveryPageUrl('https://example.com'), true);
  assert.equal(shouldCollectRecoveryPageUrl('https://'), true);
  assert.equal(shouldCollectRecoveryPageUrl('javascript:alert(1)'), true);
});

test('凭据恢复整体校验重复键、数量与长度', () => {
  assert.equal(normalizeRecoveryCredentials({}), null);
  assert.equal(
    normalizeRecoveryCredentials([
      { domain: 'example.com', username: 'u', password: 'p' },
      { domain: 'EXAMPLE.COM', username: 'u', password: 'p2' },
    ]),
    null
  );
  assert.equal(
    normalizeRecoveryCredentials(
      new Array(BROWSER_RECOVERY_LIMITS.credentials + 1).fill({
        domain: 'example.com',
        username: 'u',
        password: 'p',
      })
    ),
    null
  );
  assert.equal(
    normalizeRecoveryCredentials([
      {
        domain: 'example.com',
        username: 'u',
        password: 'x'.repeat(BROWSER_RECOVERY_LIMITS.credentialPasswordLength + 1),
      },
    ]),
    null
  );
});

test('服务端快照精确覆盖落后本地存储，不合并旧值', () => {
  const stale = [
    { name: 'test-stale', value: 'old' },
    { name: 'test-session', value: 'old-session' },
  ];
  const authoritative = [{ name: 'test-session', value: 'server-session' }];
  assert.deepEqual(applyAuthoritativeNameValueSnapshot(stale, authoritative), authoritative);

  const originPlan = buildAuthoritativeOriginStoragePlan({
    origin: 'https://example.com',
    localStorage: authoritative,
    indexedDB: [],
  });
  assert.equal(originPlan.localStorageMode, 'replace');
  assert.equal(originPlan.indexedDBMode, 'replace');
  assert.deepEqual(originPlan.localStorage, authoritative);

  const cookiePlan = buildAuthoritativeCookiePlan([{ name: 'test', value: 'server' }]);
  assert.equal(cookiePlan.clearExisting, true);
  assert.deepEqual(cookiePlan.cookies, [{ name: 'test', value: 'server' }]);
});

test('云端快照会清空仅存在于陈旧本地 profile 的 origin', () => {
  const origins = buildAuthoritativeOriginUnion(
    [
      {
        origin: 'https://server.example',
        localStorage: [{ name: 'session', value: 'server' }],
        indexedDB: [],
      },
    ],
    [
      {
        origin: 'https://server.example',
        localStorage: [{ name: 'session', value: 'stale' }],
      },
      {
        origin: 'https://stale-only.example',
        localStorage: [{ name: 'stale', value: 'must-be-removed' }],
        indexedDB: [{ name: 'stale-db', version: 1, stores: [] }],
      },
    ]
  );

  assert.deepEqual(origins[0].localStorage, [{ name: 'session', value: 'server' }]);
  assert.deepEqual(origins[1], {
    origin: 'https://stale-only.example',
    localStorage: [],
    indexedDB: [],
  });
});

test('有效会话快照时初始 Cookie 不得再覆盖云端 Cookie', () => {
  assert.equal(shouldApplyInitialCookies(false), true);
  assert.equal(shouldApplyInitialCookies(true), false);
});

test('新协议云端缓存无效或无法安全加密时失败关闭', () => {
  const imports = {
    importHistory() {},
    importCredentials() {
      throw new Error('test-safe-storage-unavailable');
    },
  };
  assert.throws(
    () =>
      importCloudRecoveryCaches({
        recovery: { history: [], credentials: snapshot.credentials },
        cloudRecoveryVersion: 1,
        ...imports,
      }),
    /已阻止使用陈旧本地缓存/
  );
  assert.throws(
    () =>
      importCloudRecoveryCaches({
        recovery: { history: '无效值', credentials: [] },
        cloudRecoveryVersion: 1,
        importHistory() {},
        importCredentials() {},
      }),
    /已阻止使用陈旧本地缓存/
  );

  const legacy = importCloudRecoveryCaches({
    recovery: { history: [], credentials: snapshot.credentials },
    cloudRecoveryVersion: 0,
    ...imports,
  });
  assert.deepEqual(legacy, { restored: false, failed: true });
});

test('context close 持久化前会等待正在进行的最终检查点', async () => {
  let release;
  const checkpoint = new Promise(resolve => {
    release = resolve;
  });
  let settled = false;
  const waiting = awaitPendingStorageCapture(checkpoint).then(result => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  release({ captured: true, changed: true });
  assert.deepEqual(await waiting, { waited: true, captured: true });
});

test('存储采集卡死时有界退出，避免阻塞浏览器关闭', async () => {
  await assert.rejects(withStorageOperationTimeout(new Promise(() => {}), 10), /存储采集超时/);
});

test('Google Auth 新协议发送版本化 Base32 marker，旧布尔参数仍兼容', () => {
  assert.equal(normalizeGoogleAuthSecret('jbsw y3dp-ehpk3pxp===='), 'JBSWY3DPEHPK3PXP');
  assert.equal(buildGoogleAuthCloudValue('JBSWY3DPEHPK3PXP'), 'totp:v1:JBSWY3DPEHPK3PXP');
  assert.deepEqual(normalizeGoogleAuthPreparationOptions(true), {
    isGoAuthCloud: true,
    cloudRecoveryVersion: 0,
    cloudRecoveryCapabilityKnown: true,
  });
  assert.deepEqual(
    normalizeGoogleAuthPreparationOptions({ isGoAuthCloud: 0, cloudRecoveryVersion: 1 }),
    {
      isGoAuthCloud: false,
      cloudRecoveryVersion: 1,
      cloudRecoveryCapabilityKnown: true,
    }
  );
  assert.throws(() => normalizeGoogleAuthSecret('test-invalid-0189'), /Base32/);
});
