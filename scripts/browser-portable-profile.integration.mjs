// 可重复本地内核验证，不连接项目API/数据库/外部站点。
// node scripts/browser-portable-profile.integration.mjs '<本机测试内核可执行路径>'
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { chromium } from 'playwright';
import {
  capturePortableProfile,
  extensionIdForPublicKey,
  restorePortableProfile,
} from '../electron/main/models/browserPortableProfile.mjs';
import {
  captureSessionStorage,
  installSessionStorageForNavigation,
  isTrustedSessionStorageCheckpoint,
  normalizeSessionStorage,
  reindexSessionStorageTabs,
  selectSessionStorageForTab,
} from '../electron/main/models/browserSessionStorage.mjs';
import { restoreStartupPages } from '../electron/main/models/startupPageRestore.mjs';
import { shouldCollectRecoveryPageUrl } from '../electron/main/models/browserPageUrl.mjs';

// 运行真实BrowserInstance方法，而不是另写一套恢复逻辑；依赖仅替换日志和实例外壳。
const instanceSource = await fs.readFile(
  new URL('../electron/main/models/BrowserInstance.js', import.meta.url),
  'utf8'
);
const instanceMethod = name => {
  const starts = [`\n  ${name}(`, `\n  async ${name}(`];
  const start = starts.map(marker => instanceSource.indexOf(marker)).find(index => index >= 0);
  assert.ok(start !== undefined, `Missing BrowserInstance method ${name}`);
  const end = instanceSource.indexOf('\n  }\n', start);
  assert.ok(end > start);
  return instanceSource.slice(start, end + '\n  }'.length);
};
const BootstrapInstance = new Function(
  'isTrustedSessionStorageCheckpoint',
  'normalizeSessionStorage',
  'reindexSessionStorageTabs',
  'shouldCollectRecoveryPageUrl',
  'restoreStartupPages',
  'selectSessionStorageForTab',
  'installSessionStorageForNavigation',
  `return class { ${instanceMethod('acceptSessionStorageCheckpoint')}
    ${instanceMethod('syncSessionStorageTopology')} ${instanceMethod('restorePages')} };`
)(
  isTrustedSessionStorageCheckpoint,
  normalizeSessionStorage,
  reindexSessionStorageTabs,
  shouldCollectRecoveryPageUrl,
  restoreStartupPages,
  selectSessionStorageForTab,
  installSessionStorageForNavigation
);

const executablePath = process.argv[2];
const restoreExecutablePath = process.argv[3] || executablePath;
if (!executablePath) throw new Error('请传入本机测试内核路径');
const server = http.createServer((req, res) => {
  if (req.url === '/test-sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(
      "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', event => event.waitUntil(self.clients.claim())); self.addEventListener('fetch', event => { if (new URL(event.request.url).pathname === '/test-controlled') event.respondWith(new Response('test-sw-response')); });"
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>test-跨设备恢复验收</title><h1>test-跨设备恢复验收</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-finger-portable-kernel-'));
let context;
try {
  const deviceA = path.join(root, 'test-device-a');
  const deviceB = path.join(root, 'test-device-b');
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const publicKeyBase64 = publicKey.toString('base64');
  const extensionId = extensionIdForPublicKey(publicKeyBase64);
  const extensionDirectory = path.join(deviceA, 'Default', 'Extensions', extensionId, '1.0_0');
  await fs.mkdir(extensionDirectory, { recursive: true });
  await fs.writeFile(
    path.join(extensionDirectory, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'test-portable-extension',
      version: '1.0',
      key: publicKeyBase64,
      permissions: ['storage', 'bookmarks', 'management'],
      background: { service_worker: 'worker.js' },
    })
  );
  await fs.writeFile(
    path.join(extensionDirectory, 'worker.js'),
    'globalThis.testPortableExtension = true;'
  );
  await fs.writeFile(
    path.join(extensionDirectory, 'probe.html'),
    '<!doctype html><title>test-extension-enabled</title>'
  );
  const bookmarkFolder = (id, name, children = []) => ({
    children,
    date_added: '0',
    date_modified: '0',
    id,
    name,
    type: 'folder',
  });
  await fs.writeFile(
    path.join(deviceA, 'Default', 'Bookmarks'),
    JSON.stringify({
      version: 1,
      roots: {
        bookmark_bar: bookmarkFolder('1', 'Bookmarks bar', [
          { date_added: '0', id: '4', name: 'test-bookmark', type: 'url', url },
        ]),
        other: bookmarkFolder('2', 'Other bookmarks'),
        synced: bookmarkFolder('3', 'Mobile bookmarks'),
      },
    })
  );
  await fs.writeFile(
    path.join(deviceA, 'Default', 'Preferences'),
    JSON.stringify({
      profile: {
        default_content_setting_values: { notifications: 1 },
        content_settings: {
          exceptions: {
            geolocation: {
              [`${url.slice(0, -1)},*`]: {
                setting: 1,
                last_modified: '13405300000000000',
              },
            },
          },
        },
      },
    })
  );
  const options = {
    executablePath,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--disable-background-networking',
      '--no-first-run',
      `--load-extension=${extensionDirectory}`,
    ],
  };
  context = await chromium.launchPersistentContext(deviceA, options);
  const browserVersion = context.browser().version();
  const workerA =
    context
      .serviceWorkers()
      .find(worker => worker.url().startsWith(`chrome-extension://${extensionId}/`)) ||
    (await context.waitForEvent('serviceworker', {
      predicate: worker => worker.url().startsWith(`chrome-extension://${extensionId}/`),
      timeout: 10000,
    }));
  await workerA.evaluate(() =>
    chrome.storage.local.set({ 'test-extension': 'test-extension-custom-value' })
  );
  const pageA = await context.newPage();
  const pageA2 = await context.newPage();
  await pageA.goto(url);
  await pageA.waitForLoadState('networkidle');
  await pageA2.goto(url);
  await pageA2.waitForLoadState('networkidle');
  await pageA.evaluate(async () => {
    await navigator.serviceWorker.register('/test-sw.js');
    await navigator.serviceWorker.ready;
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('test-opfs.txt', { create: true });
    const writable = await file.createWritable();
    await writable.write('test-opfs-content');
    await writable.close();
    await (await caches.open('test-cache')).put('/test-cached', new Response('test-cache-content'));
    localStorage.setItem('test-local', 'test-local-content');
    sessionStorage.setItem('test-session', 'test-tab-a');
  });
  await pageA2.evaluate(() => sessionStorage.setItem('test-session', 'test-tab-b'));
  const storageState = await context.storageState({ indexedDB: true });
  const sessions = await captureSessionStorage([pageA, pageA2]);
  await context.exposeBinding('__testSessionTrust', (source, checkpoint) =>
    isTrustedSessionStorageCheckpoint(source, checkpoint)
  );
  const attackFrame = await pageA.evaluateHandle(port => {
    const iframe = document.createElement('iframe');
    iframe.src = `http://localhost:${port}/test-iframe`;
    document.body.append(iframe);
    return iframe;
  }, server.address().port);
  const frame = await attackFrame.contentFrame();
  await frame.waitForURL(`http://localhost:${server.address().port}/test-iframe`);
  await frame.waitForLoadState('domcontentloaded');
  assert.equal(
    await frame.evaluate(
      topURL =>
        globalThis.__testSessionTrust({
          url: topURL,
          origin: new URL(topURL).origin,
          entries: [{ name: 'test-session', value: 'test-spoof' }],
        }),
      url
    ),
    false
  );
  const sourcePermissions = await pageA.evaluate(async () => ({
    geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
    notifications: (await navigator.permissions.query({ name: 'notifications' })).state,
  }));
  assert.equal(sourcePermissions.notifications, 'granted');
  const bookmarksA = await workerA.evaluate(() =>
    chrome.bookmarks.search({ title: 'test-bookmark' })
  );
  assert.equal(bookmarksA[0].url, url);
  await context.close();
  context = null;
  const profile = await capturePortableProfile({
    profileDir: deviceA,
    kernelVersion: browserVersion,
    assertStopped: async () => true,
  });
  assert.equal(profile.extensions[0].enabled, true);
  assert.equal(
    profile.files.some(file => file.path.startsWith('Default/File System/')),
    true
  );
  assert.equal(
    profile.files.some(file => file.path.startsWith('Default/Service Worker/CacheStorage/')),
    true
  );
  const versionBrowser = await chromium.launch({
    executablePath: restoreExecutablePath,
    headless: true,
  });
  const restoreKernelVersion = versionBrowser.version();
  await versionBrowser.close();
  const extensionDirectories = await restorePortableProfile({
    profileDir: deviceB,
    kernelVersion: restoreKernelVersion,
    snapshot: profile,
    assertStopped: async () => true,
  });
  context = await chromium.launchPersistentContext(deviceB, {
    ...options,
    executablePath: restoreExecutablePath,
    args: [
      '--disable-background-networking',
      '--no-first-run',
      `--load-extension=${extensionDirectories.join(',')}`,
    ],
    storageState,
  });
  const workerB =
    context
      .serviceWorkers()
      .find(worker => worker.url().startsWith(`chrome-extension://${extensionId}/`)) ||
    (await context.waitForEvent('serviceworker', {
      predicate: worker => worker.url().startsWith(`chrome-extension://${extensionId}/`),
      timeout: 10000,
    }));
  assert.equal(
    (await workerB.evaluate(() => chrome.storage.local.get('test-extension')))['test-extension'],
    'test-extension-custom-value'
  );
  const bookmarksB = await workerB.evaluate(() =>
    chrome.bookmarks.search({ title: 'test-bookmark' })
  );
  assert.equal(bookmarksB[0].url, url);
  const restoringInstance = Object.assign(new BootstrapInstance(), {
    context,
    state: { ...storageState, sessionStorage: structuredClone(sessions) },
    _startupSessionStorage: structuredClone(sessions),
    startupReady: false,
    _sessionStorageByPage: new WeakMap(),
    _sessionStoragePageIndices: new WeakMap(),
    _closingSessionStorageBatch: [],
    pages: [{ url }, { url }],
    config: { base: { url }, proxy: { enabled: false } },
    logger: { info() {}, warn() {} },
    isInternalPageUrl: address =>
      !address || /^chrome:|^chrome-extension:|^devtools:/.test(address),
    markRecoveryChanged() {},
  });
  await context.exposeBinding('__fingerBrowserSessionCheckpoint', (source, checkpoint) =>
    restoringInstance.acceptSessionStorageCheckpoint(source, checkpoint)
  );
  await context.addInitScript(() =>
    addEventListener(
      'DOMContentLoaded',
      () => {
        if (!['http:', 'https:'].includes(location.protocol)) return;
        globalThis
          .__fingerBrowserSessionCheckpoint({
            url: location.href,
            origin: location.origin,
            entries: Object.entries(sessionStorage).map(([name, value]) => ({ name, value })),
          })
          .catch(() => {});
      },
      { once: true }
    )
  );
  const bootstrapPage = await context.newPage();
  await bootstrapPage.goto(`${url}.well-known/finger-browser-recovery-test`);
  await bootstrapPage.evaluate(() =>
    globalThis.__fingerBrowserSessionCheckpoint({
      url: location.href,
      origin: location.origin,
      entries: [],
    })
  );
  assert.deepEqual(
    restoringInstance.state.sessionStorage,
    sessions,
    'bootstrap document overwrote cloud session queue'
  );
  await bootstrapPage.close();
  await restoringInstance.restorePages();
  restoringInstance.startupReady = true;
  const [pageB, pageB2] = context.pages().filter(page => page.url() === url);
  for (const [index, page] of [pageB, pageB2].entries()) {
    restoringInstance._sessionStoragePageIndices.set(page, index);
    restoringInstance._sessionStorageByPage.set(page, structuredClone(sessions[index]));
  }
  const restored = await pageB.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('test-opfs.txt');
    const cache = await caches.open('test-cache');
    const response = await cache.match('/test-cached');
    return {
      opfs: await (await file.getFile()).text(),
      cache: await response?.text(),
      session: sessionStorage.getItem('test-session'),
    };
  });
  assert.deepEqual(restored, {
    opfs: 'test-opfs-content',
    cache: 'test-cache-content',
    session: 'test-tab-a',
  });
  assert.deepEqual(
    await pageB.evaluate(async () => ({
      geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
      notifications: (await navigator.permissions.query({ name: 'notifications' })).state,
    })),
    sourcePermissions
  );
  const recoveryCDP = await context.newCDPSession(pageB);
  await recoveryCDP.send('Network.enable');
  await recoveryCDP.send('Network.setBypassServiceWorker', { bypass: true });
  await recoveryCDP.send('ServiceWorker.enable');
  await recoveryCDP.send('ServiceWorker.stopAllWorkers');
  assert.equal(
    await pageB.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
    1
  );
  await recoveryCDP.send('Network.setBypassServiceWorker', { bypass: false });
  await recoveryCDP.detach();
  assert.equal(
    await pageB.evaluate(async () => (await fetch('/test-controlled')).text()),
    'test-sw-response'
  );
  assert.equal(await pageB2.evaluate(() => sessionStorage.getItem('test-session')), 'test-tab-b');
  await pageB.evaluate(() => sessionStorage.clear());
  await pageB.reload();
  assert.equal(await pageB.evaluate(() => sessionStorage.getItem('test-session')), null);
  // 两个同URL标签关闭第一个，超过close批次250ms后再关闭最后一个。
  // 位置从1变0，必须恢复剩余标签的值。
  const topologyTabs = await captureSessionStorage([pageB, pageB2]);
  const topologyIndices = new WeakMap([
    [pageB, 0],
    [pageB2, 1],
  ]);
  const topologyByPage = new WeakMap([
    [pageB, topologyTabs[0]],
    [pageB2, topologyTabs[1]],
  ]);
  await pageB.close();
  const remainingSessions = reindexSessionStorageTabs({
    pages: [pageB2],
    byPage: topologyByPage,
    indices: topologyIndices,
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  await pageB2.close();
  const finalSessions = reindexSessionStorageTabs({
    pages: [],
    byPage: topologyByPage,
    indices: topologyIndices,
    previousTabs: remainingSessions,
    closedTabs: [{ page: pageB2, url }],
  });
  const sessionProof = await context.newPage();
  const removeSessionProof = await installSessionStorageForNavigation(
    context,
    sessionProof,
    selectSessionStorageForTab(finalSessions, url, 0)
  );
  await sessionProof.goto(url);
  await removeSessionProof();
  assert.equal(
    await sessionProof.evaluate(() => sessionStorage.getItem('test-session')),
    'test-tab-b'
  );
  const disablePage = await context.newPage();
  await disablePage.goto(`chrome-extension://${extensionId}/probe.html`);
  await disablePage
    .evaluate(id => chrome.management.setEnabled(id, false), extensionId)
    .catch(error => {
      if (!/closed|destroyed|Execution context/i.test(error.message)) throw error;
    });
  await context.close();
  context = null;
  const upgradedSnapshot = await capturePortableProfile({
    profileDir: deviceB,
    kernelVersion: restoreKernelVersion,
    assertStopped: async () => true,
  });
  assert.equal(upgradedSnapshot.extensions[0].enabled, false);
  const deviceC = path.join(root, 'test-device-c-disabled');
  const disabledExtensionPaths = await restorePortableProfile({
    profileDir: deviceC,
    kernelVersion: restoreKernelVersion,
    snapshot: upgradedSnapshot,
    assertStopped: async () => true,
  });
  assert.deepEqual(disabledExtensionPaths, []);
  context = await chromium.launchPersistentContext(deviceC, {
    executablePath: restoreExecutablePath,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--disable-background-networking', '--no-first-run'],
  });
  const disabledProof = await context.newPage();
  let extensionEnabled = false;
  try {
    await disabledProof.goto(`chrome-extension://${extensionId}/probe.html`, { timeout: 3000 });
    extensionEnabled = (await disabledProof.title()) === 'test-extension-enabled';
  } catch {}
  assert.equal(extensionEnabled, false);
  await context.close();
  context = null;
  assert.equal(
    (
      await capturePortableProfile({
        profileDir: deviceC,
        kernelVersion: restoreKernelVersion,
        assertStopped: async () => true,
      })
    ).extensions[0].enabled,
    false
  );
  if (restoreKernelVersion !== browserVersion) {
    await assert.rejects(
      restorePortableProfile({
        profileDir: path.join(root, 'test-device-downgrade'),
        kernelVersion: browserVersion,
        snapshot: upgradedSnapshot,
        assertStopped: async () => true,
      }),
      error => error.code === 'PORTABLE_PROFILE_VERSION_DOWNGRADE'
    );
  }
  console.log(
    JSON.stringify({
      passed: true,
      kernel: browserVersion,
      profileFiles: profile.files.length,
      restoreKernel: restoreKernelVersion,
      restored: [
        '原生书签',
        '站点权限',
        '稳定ID扩展与扩展数据',
        '禁用扩展不复活',
        '同URL关闭首标签后重排',
        '拒绝跨源iframe伪造',
        'ServiceWorker',
        'OPFS',
        'CacheStorage',
        '独立标签sessionStorage',
        '真实BrowserInstance bootstrap不污染恢复队列',
        '清理后不复活',
        '拒绝内核降级',
      ],
    })
  );
} finally {
  await context?.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
