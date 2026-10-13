import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  capturePortableProfile,
  canRestorePortableKernelVersion,
  extensionIdForPublicKey,
  isPortableProfilePath,
  normalizePortableProfile,
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
import { normalizeBrowserStorageState } from '../electron/main/models/browserStorageState.mjs';

const version = '140.0.7259';
const stopped = async () => true;
const fixtureFile = (relative, content) => {
  const bytes = Buffer.from(content);
  return {
    path: relative,
    bytes: bytes.length,
    data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};
const fixtureProfile = () => ({
  version: 1,
  kernelVersion: version,
  capturedAt: 1,
  permissions: {
    defaults: { notifications: 2 },
    exceptions: {
      geolocation: { 'https://example.test:443,*': { setting: 1 } },
    },
  },
  extensions: [],
  files: [fixtureFile('Default/Bookmarks', '{"roots":{}}')],
});
const createRoot = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-finger-portable-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
};
const put = async (root, relative, data) => {
  const target = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
};
const windowsReservedPaths = () => {
  const devices = [
    'CON',
    'prn',
    'aUx',
    'NUL',
    ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
    ...['¹', '²', '³'].flatMap(digit => [`COM${digit}`, `LPT${digit}`]),
  ];
  return [
    ...devices.flatMap(name =>
      ['', '.txt', '.tar.gz', ' .log'].flatMap(suffix => [
        `Default/Storage/${name}${suffix}`,
        `Default/Storage/${name}${suffix}/000001.log`,
      ])
    ),
    ...['<', '>', '"', '|', '?', '*'].flatMap(char => [
      `Default/Storage/test${char}file`,
      `Default/Storage/test${char}dir/000001.log`,
    ]),
    `Default/Extensions/${'a'.repeat(32)}/1.0/aux.js`,
  ];
};

test('白名单拒绝设备密钥、原生密码库、锁、穿越、反斜杠与扩展原生组件', () => {
  for (const relative of [
    'Local State',
    'Default/Cookies',
    'Default/Network/Cookies',
    'Default/Login Data',
    'Default/Secure Preferences',
    'Default/Cache/cache',
    'Default/Storage/../Login Data',
    '/Default/Bookmarks',
    'Default/Storage/a\\b',
    'Default/Storage/LOCK',
    'Default/Storage/a:stream',
    `Default/Extensions/${'a'.repeat(32)}/1.0/helper.dll`,
  ]) {
    assert.equal(isPortableProfilePath(relative), false, relative);
  }
  assert.equal(isPortableProfilePath('Default/Storage/ext/000001.log'), true);
  assert.equal(isPortableProfilePath('Default/Service Worker/CacheStorage/test/cache'), true);
});

test('所有平台统一拒绝Win32设备名和非法字符，普通Chrome档案名称仍兼容', () => {
  for (const relative of windowsReservedPaths()) {
    assert.equal(isPortableProfilePath(relative), false, relative);
  }
  for (const name of [
    'COM0',
    'COM10',
    'LPT0',
    'LPT10',
    'conifer',
    'auxiliary.js',
    '.hidden',
    'con-1',
    'COM²a',
  ]) {
    assert.equal(isPortableProfilePath(`Default/Storage/${name}`), true, name);
  }
  assert.equal(isPortableProfilePath(`Default/Extensions/${'a'.repeat(32)}/1.0/worker.js`), true);
});

test('恢复前拒绝Win32路径及大小写覆盖冲突，原书签、存储与设置均未删除', async t => {
  const root = await createRoot(t);
  const originals = new Map([
    ['Default/Bookmarks', 'test-original-bookmarks'],
    ['Default/Storage/test-retained/000001.log', 'test-original-storage'],
    ['Default/Preferences', '{"testOriginal":true}'],
  ]);
  for (const [relative, content] of originals) await put(root, relative, content);
  const invalidFiles = windowsReservedPaths().map(relative => [
    fixtureFile(relative, 'test-invalid'),
  ]);
  for (const pair of [
    ['Default/Storage/test/Entry', 'Default/Storage/test/entry'],
    ['Default/Storage/Test/entry', 'Default/Storage/test/ENTRY'],
    ['Default/Storage/Test', 'Default/Storage/test/child'],
    ['Default/Storage/test/child', 'Default/Storage/Test'],
  ]) {
    invalidFiles.push(pair.map(relative => fixtureFile(relative, 'test-collision')));
  }
  for (const files of invalidFiles) {
    const snapshot = fixtureProfile();
    snapshot.files.push(...files);
    assert.equal(normalizePortableProfile(snapshot), null, files[0].path);
    let stoppedChecks = 0;
    await assert.rejects(
      restorePortableProfile({
        profileDir: root,
        kernelVersion: version,
        snapshot,
        assertStopped: async () => {
          stoppedChecks++;
          return true;
        },
      }),
      { code: 'PORTABLE_PROFILE_INVALID' }
    );
    assert.equal(stoppedChecks, 0, '无效信封应在任何磁盘恢复前拒绝');
    for (const [relative, content] of originals) {
      assert.equal(
        await fs.readFile(path.join(root, ...relative.split('/')), 'utf8'),
        content,
        relative
      );
    }
  }
});

test('校验完整信封、SHA256、大小、重复和版本，旧state可兼容', () => {
  const snapshot = fixtureProfile();
  assert.deepEqual(normalizePortableProfile(snapshot), snapshot);
  const badHash = structuredClone(snapshot);
  badHash.files[0].sha256 = '0'.repeat(64);
  assert.equal(normalizePortableProfile(badHash), null);
  const duplicate = structuredClone(snapshot);
  duplicate.files.push(duplicate.files[0]);
  assert.equal(normalizePortableProfile(duplicate), null);
  assert.equal(normalizePortableProfile({ ...snapshot, version: 2 }), null);
  assert.equal(normalizePortableProfile({ ...snapshot, kernelVersion: '../../test' }), null);
  assert.deepEqual(normalizeBrowserStorageState({ cookies: [], origins: [] }), {
    cookies: [],
    origins: [],
  });
  const envelope = { cookies: [], origins: [], portableProfile: snapshot, sessionStorage: [] };
  assert.deepEqual(normalizeBrowserStorageState(envelope), envelope);
});

test('停止后采集并在新电脑精确恢复书签、OPFS、缓存和权限，敏感本机文件未上传', async t => {
  const root = await createRoot(t);
  const deviceA = path.join(root, 'test-device-a');
  const deviceB = path.join(root, 'test-device-b');
  await fs.mkdir(deviceB);
  await put(deviceA, 'Default/Bookmarks', '{"roots":{"bookmark_bar":{"children":[]}}}');
  await put(deviceA, 'Default/File System/000/p/00000000', 'test-opfs-data');
  await put(deviceA, 'Default/Storage/ext/000001.log', 'test-bucket-data');
  await put(deviceA, 'Default/Service Worker/CacheStorage/test/000001', 'test-cache-data');
  await put(deviceA, 'Default/File System/LOCK', 'test-local-lock');
  await put(deviceA, 'Local State', 'test-never-export-os-key');
  await put(deviceA, 'Default/Login Data', 'test-never-export-passwords');
  await put(
    deviceA,
    'Default/Preferences',
    JSON.stringify({
      profile: {
        default_content_setting_values: { notifications: 2 },
        content_settings: {
          exceptions: {
            geolocation: {
              'https://example.test:443,*': { setting: 1, last_modified: 'test-device-timestamp' },
            },
          },
        },
      },
    })
  );
  await put(deviceB, 'Default/File System/stale', 'test-stale');
  const snapshot = await capturePortableProfile({
    profileDir: deviceA,
    kernelVersion: version,
    assertStopped: stopped,
  });
  assert.equal(snapshot.files.length, 4);
  assert.equal(JSON.stringify(snapshot).includes('never-export'), false);
  assert.equal(JSON.stringify(snapshot).includes('test-device-timestamp'), false);
  await restorePortableProfile({
    profileDir: deviceB,
    kernelVersion: version,
    snapshot,
    assertStopped: stopped,
  });
  assert.equal(
    await fs.readFile(path.join(deviceB, 'Default/File System/000/p/00000000'), 'utf8'),
    'test-opfs-data'
  );
  await assert.rejects(fs.stat(path.join(deviceB, 'Default/File System/stale')), {
    code: 'ENOENT',
  });
  const preferences = JSON.parse(
    await fs.readFile(path.join(deviceB, 'Default/Preferences'), 'utf8')
  );
  assert.deepEqual(preferences.profile.content_settings.exceptions.geolocation, {
    'https://example.test:443,*': { setting: 1 },
  });
});

test('内核允许向前升级，拒绝降级；进程仍运行明确阻止采集', async t => {
  const root = await createRoot(t);
  await assert.rejects(
    capturePortableProfile({
      profileDir: root,
      kernelVersion: version,
      assertStopped: async () => false,
    }),
    /尚未完全退出/
  );
  await assert.rejects(
    restorePortableProfile({
      profileDir: root,
      kernelVersion: '139.0.0',
      snapshot: fixtureProfile(),
      assertStopped: stopped,
    }),
    /同版本或更高版本/
  );
  assert.equal(canRestorePortableKernelVersion('140.0.7259', '144.0.7500'), true);
  assert.equal(canRestorePortableKernelVersion('144.0.7500', '140.0.7259'), false);
  assert.equal(canRestorePortableKernelVersion('140.0.7259.10', '140.0.7259.20'), true);
  assert.equal(canRestorePortableKernelVersion('140.0.7259.20', '140.0.7259.10'), false);
});

test('恢复预检查拒绝符号链接且不修改原始文件', async t => {
  const root = await createRoot(t);
  const device = path.join(root, 'test-device');
  const external = path.join(root, 'test-external');
  await put(device, 'Default/Bookmarks', 'test-original-bookmark');
  await fs.mkdir(external);
  await fs.symlink(external, path.join(device, 'Default/Storage'));
  await assert.rejects(
    restorePortableProfile({
      profileDir: device,
      kernelVersion: version,
      snapshot: fixtureProfile(),
      assertStopped: stopped,
    }),
    /符号链接/
  );
  assert.equal(
    await fs.readFile(path.join(device, 'Default/Bookmarks'), 'utf8'),
    'test-original-bookmark'
  );
});

test('含公开key的纯JS扩展维持原ID，加载目录位于新profile', async t => {
  const root = await createRoot(t);
  const deviceA = path.join(root, 'test-device-a');
  const deviceB = path.join(root, 'test-device-b');
  const publicKey = Buffer.from('test-public-extension-key').toString('base64');
  const id = extensionIdForPublicKey(publicKey);
  await put(
    deviceA,
    `Default/Extensions/${id}/1.0_0/manifest.json`,
    JSON.stringify({ name: 'test-extension', version: '1.0', manifest_version: 3, key: publicKey })
  );
  await put(
    deviceA,
    `Default/Extensions/${id}/1.0_0/worker.js`,
    'globalThis.testExtension = true;'
  );
  await put(deviceA, `Default/Local Extension Settings/${id}/000001.log`, 'test-extension-state');
  await put(
    deviceA,
    'Default/Preferences',
    JSON.stringify({ extensions: { settings: { [id]: { state: 1, disable_reasons: [] } } } })
  );
  const snapshot = await capturePortableProfile({
    profileDir: deviceA,
    kernelVersion: version,
    assertStopped: stopped,
  });
  const extensionDirs = await restorePortableProfile({
    profileDir: deviceB,
    kernelVersion: version,
    snapshot,
    assertStopped: stopped,
  });
  assert.deepEqual(extensionDirs, [path.join(deviceB, 'Default', 'Extensions', id, '1.0_0')]);
  const manifest = JSON.parse(
    await fs.readFile(path.join(extensionDirs[0], 'manifest.json'), 'utf8')
  );
  assert.equal(extensionIdForPublicKey(manifest.key), id);
});

test('缺少稳定key的扩展会明确报告，避免换机时悄悄丢数据', async t => {
  const root = await createRoot(t);
  await put(
    root,
    `Default/Extensions/${'a'.repeat(32)}/1.0_0/manifest.json`,
    JSON.stringify({ name: 'test-extension', version: '1.0', manifest_version: 3 })
  );
  await assert.rejects(
    capturePortableProfile({ profileDir: root, kernelVersion: version, assertStopped: stopped }),
    /稳定公开标识/
  );
});

test('同源同地址的多个标签分别采集sessionStorage，不互相覆盖', async () => {
  const page = token => ({
    isClosed: () => false,
    url: () => 'https://example.test/',
    frames: () => [
      {
        evaluate: async () => ({
          origin: 'https://example.test',
          entries: [{ name: 'test-token', value: token }],
        }),
      },
    ],
  });
  const captured = await captureSessionStorage([page('test-a'), page('test-b')]);
  assert.equal(
    selectSessionStorageForTab(captured, 'https://example.test/', 0).origins[0].entries[0].value,
    'test-a'
  );
  assert.equal(
    selectSessionStorageForTab(captured, 'https://example.test/', 1).origins[0].entries[0].value,
    'test-b'
  );
  assert.equal(selectSessionStorageForTab(captured, 'https://other.test/', 0), null);
  assert.equal(normalizeSessionStorage([captured[0], captured[0]]), null);
});

test('关闭同URL首标签后即时重排，最后关闭保存的是剩余标签', async () => {
  const page = () => ({ url: () => 'https://example.test/' });
  const first = page();
  const second = page();
  const indices = new WeakMap([
    [first, 0],
    [second, 1],
  ]);
  const tab = (index, token) => ({
    index,
    url: first.url(),
    origins: [{ origin: 'https://example.test', entries: [{ name: 'test-token', value: token }] }],
  });
  const byPage = new WeakMap([
    [first, tab(0, 'test-first')],
    [second, tab(1, 'test-second')],
  ]);
  const remaining = reindexSessionStorageTabs({ pages: [second], byPage, indices });
  assert.equal(remaining[0].index, 0);
  assert.equal(remaining[0].origins[0].entries[0].value, 'test-second');
  const closed = reindexSessionStorageTabs({
    pages: [],
    byPage,
    indices,
    previousTabs: remaining,
    closedTabs: [{ page: second, url: second.url() }],
  });
  assert.equal(
    selectSessionStorageForTab(closed, second.url(), 0).origins[0].entries[0].value,
    'test-second'
  );
});

test('跨源iframe不能伪造顶层绑定检查点，主frameURL也必须匹配', () => {
  const main = { url: () => 'https://example.test/' };
  const frame = { url: () => 'https://attacker.test/' };
  const page = { mainFrame: () => main, url: main.url };
  const checkpoint = { url: main.url(), origin: 'https://example.test', entries: [] };
  assert.equal(isTrustedSessionStorageCheckpoint({ page, frame }, checkpoint), false);
  assert.equal(isTrustedSessionStorageCheckpoint({ page, frame: main }, checkpoint), true);
  assert.equal(
    isTrustedSessionStorageCheckpoint(
      { page, frame: main },
      { ...checkpoint, url: 'https://other.test/' }
    ),
    false
  );
});

test('禁用扩展快照不返回加载路径，并保留禁用状态而不是复活', async t => {
  const root = await createRoot(t);
  const deviceA = path.join(root, 'test-device-a');
  const deviceB = path.join(root, 'test-device-b');
  const publicKey = Buffer.from('test-disabled-extension-key').toString('base64');
  const id = extensionIdForPublicKey(publicKey);
  await put(
    deviceA,
    `Default/Extensions/${id}/1.0_0/manifest.json`,
    JSON.stringify({
      manifest_version: 3,
      key: publicKey,
      name: 'test-disabled',
      version: '1.0',
    })
  );
  await put(
    deviceA,
    'Default/Secure Preferences',
    JSON.stringify({
      extensions: {
        settings: {
          [id]: { state: 0, disable_reasons: [1], manifest: { key: publicKey } },
        },
      },
    })
  );
  const snapshot = await capturePortableProfile({
    profileDir: deviceA,
    kernelVersion: version,
    assertStopped: stopped,
  });
  assert.equal(snapshot.extensions[0].enabled, false);
  assert.deepEqual(
    await restorePortableProfile({
      profileDir: deviceB,
      kernelVersion: version,
      snapshot,
      assertStopped: stopped,
    }),
    []
  );
  const recovered = await capturePortableProfile({
    profileDir: deviceB,
    kernelVersion: version,
    assertStopped: stopped,
  });
  assert.equal(recovered.extensions[0].enabled, false);
});

test('sessionStorage恢复脚本在首次导航后移除，不覆盖用户后来清理的数据', async () => {
  const listeners = new Map();
  const calls = [];
  const page = {
    isClosed: () => false,
    waitForFunction: async () => {},
    evaluate: async () => {},
    once: (name, callback) => listeners.set(name, callback),
    off: (name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
  };
  const cdp = {
    send: async (method, payload) => {
      calls.push({ method, payload });
      return { identifier: 'test-script-id' };
    },
    detach: async () => calls.push({ method: 'detach' }),
  };
  const cleanup = await installSessionStorageForNavigation(
    { newCDPSession: async () => cdp },
    page,
    {
      origins: [
        { origin: 'https://example.test', entries: [{ name: 'test-key', value: 'test-value' }] },
      ],
    }
  );
  await cleanup();
  assert.equal(calls[0].method, 'Page.enable');
  assert.equal(calls[1].method, 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(calls[2].method, 'Page.removeScriptToEvaluateOnNewDocument');
  assert.equal(listeners.size, 0);
});

test('navigation restore keeps the init script until the destination acknowledges execution', async () => {
  const calls = [];
  let acknowledge;
  const ready = new Promise(resolve => {
    acknowledge = resolve;
  });
  const page = {
    isClosed: () => false,
    once() {},
    off() {},
    waitForFunction: () => ready,
    evaluate: async () => {},
    frames: () => [page, { evaluate: async () => { calls.push('child-frame-cleaned'); } }],
  };
  const cdp = {
    send: async method => {
      calls.push(method);
      return { identifier: 'test-id' };
    },
    detach: async () => {
      calls.push('detach');
    },
  };
  const finish = await installSessionStorageForNavigation(
    { newCDPSession: async () => cdp },
    page,
    { origins: [{ origin: 'https://example.test', entries: [{ name: 'tab', value: 'test-tab' }] }] }
  );
  const pending = finish();
  await Promise.resolve();
  assert.ok(!calls.includes('Page.removeScriptToEvaluateOnNewDocument'));
  acknowledge();
  await pending;
  assert.ok(calls.includes('child-frame-cleaned'));
  assert.ok(calls.includes('Page.removeScriptToEvaluateOnNewDocument'));
});

test('missing restore acknowledgement rejects partial startup and still cleans its CDP script', async () => {
  const calls = [];
  const page = {
    isClosed: () => false,
    once() {},
    off() {},
    waitForFunction: async () => {
      throw new Error('test-timeout');
    },
  };
  const cdp = {
    send: async method => {
      calls.push(method);
      return { identifier: 'test-id' };
    },
    detach: async () => {
      calls.push('detach');
    },
  };
  const finish = await installSessionStorageForNavigation(
    { newCDPSession: async () => cdp },
    page,
    { origins: [{ origin: 'https://example.test', entries: [] }] }
  );
  await assert.rejects(finish(), { code: 'BROWSER_SESSION_STORAGE_RESTORE_FAILED' });
  assert.ok(calls.includes('Page.removeScriptToEvaluateOnNewDocument'));
  assert.ok(calls.includes('detach'));
});
