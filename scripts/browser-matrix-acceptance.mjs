import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const user = process.env.FINGER_TEST_USERNAME;
assert.match(user || '', /^test-matrix-[A-Za-z0-9_-]+$/);
const site = process.env.FINGER_TEST_SITE || 'http://192.168.50.221:19090';
const run = process.env.FINGER_TEST_RUN || `matrix-${os.platform()}-${Date.now()}`;
const executable = process.env.FINGER_TEST_EXECUTABLE || require('electron');
const sourceKernels =
  process.env.FINGER_TEST_KERNEL_ROOT ||
  path.join(os.homedir(), 'Library/Application Support/finger-browser/browser');
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'test-finger-matrix-'));
const appData = path.join(evidence, 'appdata');
await fs.mkdir(path.join(appData, 'browser'), { recursive: true });
for (const version of ['140.0.7259', '144.0.7500']) {
  await fs.symlink(
    path.join(sourceKernels, version),
    path.join(appData, 'browser', version),
    os.platform() === 'win32' ? 'junction' : 'dir'
  );
}
assert.equal(
  (await fetch('http://127.0.0.1:8889/health').then(r => r.json())).commit,
  'local-acceptance'
);
const results = [];
let app, page, token;
async function start() {
  app = await electron.launch({
    executablePath: executable,
    args: [
      ...(process.env.FINGER_TEST_EXECUTABLE ? [] : [root]),
      `--user-data-dir=${path.join(evidence, 'electron')}`,
    ],
    env: { ...process.env, PROJECT_MAC_BASE_PATH: appData, PROJECT_WIN_BASE_PATH: appData },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page
    .context()
    .route('**/*', route =>
      ['file:', 'data:'].includes(new URL(route.request().url()).protocol) ||
      ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
        ? route.continue()
        : route.abort()
    );
  await Promise.race([
    page.getByPlaceholder('请输入用户名').waitFor(),
    page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor(),
  ]);
  if (await page.getByPlaceholder('请输入用户名').isVisible()) {
    await page.getByPlaceholder('请输入用户名').fill(user);
    await page.getByPlaceholder('请输入密码').fill('test-Acceptance-20261012');
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor();
  token = await page.evaluate(() => localStorage.getItem('token'));
  await app.evaluate(({ app }, spki) => {
    const { chromium } = process
      .getBuiltinModule('module')
      .createRequire(app.getAppPath() + '/package.json')('playwright');
    const original = chromium.launchPersistentContext.bind(chromium);
    globalThis.__matrixContexts = new Map();
    chromium.launchPersistentContext = async (dir, options) => {
      if (spki)
        options = {
          ...options,
          args: [...(options.args || []), `--ignore-certificate-errors-spki-list=${spki}`],
        };
      const context = await original(dir, options);
      if (!dir.includes('finger-proxy-probe-')) globalThis.__matrixContexts.set(dir, context);
      return context;
    };
  }, process.env.FINGER_TEST_HTTPS_PROXY_SPKI || '');
}
async function api(endpoint, data) {
  const value = await fetch(`http://127.0.0.1:8889/api/v1${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify(data),
  }).then(r => r.json());
  assert.equal(value.code, 0, value.message);
  return value.data;
}
async function test(name, fn) {
  try {
    const data = await fn();
    results.push({ name, status: 'passed', data });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack });
    console.log(`FAIL ${name}: ${error.message}`);
  }
  await fs.writeFile(
    path.join(evidence, 'matrix.json'),
    JSON.stringify({ run, platform: os.platform(), results }, null, 2)
  );
}
async function open(id) {
  const record = configs.find(record => record.browser_id === id);
  await page.evaluate(
    record =>
      window.ipcRenderer.restoreInstance({
        id: record.browser_id,
        config: JSON.parse(record.config),
        cloudRecoveryVersion: 1,
      }),
    record
  );
}
async function sample(id, phase, extraTab = false) {
  return app.evaluate(
    async (_, { id, phase, extraTab, site, run }) => {
      const context = [...globalThis.__matrixContexts].findLast(([dir]) => dir.endsWith(id))?.[1];
      if (!context) throw new Error('Missing live browser context');
      let target = context.pages().find(p => p.url().startsWith(site));
      if (extraTab || !target) target = await context.newPage();
      await target.goto(
        `${site}/?run=${encodeURIComponent(run)}&label=${encodeURIComponent(id)}&phase=${encodeURIComponent(phase)}&auto=1`
      );
      await target.waitForFunction(
        () => globalThis.lastFingerprintObservation || globalThis.fingerprintError,
        null,
        { timeout: 15000 }
      );
      return target.evaluate(() => {
        if (globalThis.fingerprintError) throw new Error(globalThis.fingerprintError);
        return globalThis.lastFingerprintObservation;
      });
    },
    { id, phase, extraTab, site, run }
  );
}
async function close(id) {
  await app.evaluate(async (_, id) => {
    const context = [...globalThis.__matrixContexts].findLast(([dir]) => dir.endsWith(id))[1];
    // Closing the final tab exercises the native headed lifecycle on Windows.
    for (const p of context.pages()) await p.close().catch(() => {});
  }, id);
  await page.waitForFunction(
    async id => !(await window.ipcRenderer.getAllInstances()).includes(id),
    id
  );
  const deadline = Date.now() + 60000;
  for (;;) {
    const list = await api('/browsers/search', { page: 1, size: 200, includeRecovery: false });
    if (!list.list.find(record => record.browser_id === id)?.runtimeLocked) break;
    if (Date.now() > deadline)
      throw new Error('Native close did not finish its acknowledged save and unlock');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
const configs = [];
const observations = new Map();
const resumeProxies = process.env.FINGER_TEST_MATRIX_RESUME === '1';
const baseConfig = (version, name, proxy = { enabled: false }) => ({
  base: {
    name,
    browserVersion: version,
    operatingSystem: ['Windows NT 10.0'],
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.2 Safari/537.36`,
    url: `${site}/?run=${run}&label=${name}&auto=1`,
    cookies: '',
  },
  finger: {
    autoFingerprint: true,
    canvas: false,
    webgl: false,
    audioFingerprint: false,
    clientRects: false,
    language: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'Asia/Singapore',
    platform: 'Win32',
    screenResolution: '1366x768',
    hardwareConcurrency: 4,
    deviceMemory: 8,
    webRTC: 'proxy_only',
  },
  proxy,
  groupId: 0,
});
try {
  await start();
  if (resumeProxies) {
    const list = await api('/browsers/search', { page: 1, size: 200 });
    configs.push(...list.list.filter(record => record.name.startsWith(`test-${run}-`)));
    assert.equal(configs.length, 9);
    for (const record of configs.filter(
      record => JSON.parse(record.config).proxy?.type !== 'https'
    ))
      await open(record.browser_id);
  }
  if (!resumeProxies) {
    for (const [version, suffix] of [
      ['140.0.7259', 'a'],
      ['140.0.7259', 'b'],
      ['144.0.7500', 'c'],
    ]) {
      const config = baseConfig(version, `test-${run}-${suffix}`);
      let saved;
      if (suffix === 'a') {
        await test('通过实际界面开启自动指纹并保存', async () => {
          await page.getByRole('button', { name: '创建新窗口', exact: true }).click();
          const d = page.getByRole('dialog', { name: '创建新窗口', exact: true });
          const setting = d.locator('.el-form-item').filter({ hasText: '自动指纹' });
          assert.equal(await setting.getByRole('switch').getAttribute('aria-checked'), 'true');
          await setting.locator('.el-switch').click();
          assert.equal(await setting.getByRole('switch').getAttribute('aria-checked'), 'false');
          await setting.locator('.el-switch').click();
          await d.getByRole('textbox', { name: /名称/ }).fill(config.base.name);
          const combo = d.getByRole('combobox', { name: /浏览器版本/ });
          await combo.press('Enter');
          await page
            .locator(`[id="${await combo.getAttribute('aria-controls')}"]`)
            .getByRole('option', { name: version, exact: true })
            .click();
          await d.getByRole('textbox', { name: '初始 URL', exact: true }).fill(config.base.url);
          await d.getByRole('button', { name: '创建窗口', exact: true }).click();
          await d.waitFor({ state: 'hidden' });
        });
        saved = 'created-through-ui';
      } else saved = await api('/browsers/create', { config, group_id: 0 });
      const list = await api('/browsers/search', { page: 1, size: 200 });
      const record = list.list.find(item => item.name === config.base.name);
      assert.ok(record, JSON.stringify(saved));
      assert.equal(JSON.parse(record.config).finger.autoFingerprint, true);
      configs.push(record);
    }
    await test('不同内核及同版本多窗口同时启动（有窗口模式）', async () => {
      await Promise.all(configs.map(record => open(record.browser_id)));
      for (const record of configs)
        observations.set(record.browser_id, await sample(record.browser_id, 'initial'));
      assert.equal(new Set([...observations.values()].map(x => x.fingerprintId)).size, 3);
      assert.equal(new Set([...observations.values()].map(x => x.componentHashes.canvas)).size, 3);
      return [...observations.values()].map(x => ({
        label: x.label,
        fingerprintId: x.fingerprintId,
        canvas: x.componentHashes.canvas,
        audio: x.componentHashes.audio,
        identity: x.identity,
        checks: x.checks,
      }));
    });
    await test('同窗口多标签指纹一致，窗口间 Cookie/localStorage 隔离', async () => {
      for (const record of configs) {
        for (let i = 0; i < 2; i++)
          assert.equal(
            (await sample(record.browser_id, `tab-${i + 2}`, true)).fingerprintId,
            observations.get(record.browser_id).fingerprintId
          );
      }
      return app.evaluate(
        async (_, ids) => {
          const values = [];
          for (const id of ids) {
            const context = [...globalThis.__matrixContexts].findLast(([dir]) =>
              dir.endsWith(id)
            )[1];
            const pages = context.pages().filter(p => p.url().startsWith('http:'));
            await pages[0].evaluate(id => {
              localStorage.setItem('test-matrix-owner', id);
              document.cookie = `test-matrix-owner=${id};path=/`;
            }, id);
            const value = await pages.at(-1).evaluate(() => ({
              owner: localStorage.getItem('test-matrix-owner'),
              cookies: document.cookie,
            }));
            if (value.owner !== id || !value.cookies.includes(id))
              throw new Error('Window storage leaked');
            for (const [index, tab] of pages.entries())
              await tab.evaluate(
                ({ id, index }) => sessionStorage.setItem('test-matrix-tab', `${id}:${index}`),
                { id, index }
              );
            values.push({ id, tabs: pages.length, ...value });
          }
          return values;
        },
        configs.map(x => x.browser_id)
      );
    });
    await test('关闭最后标签后重开：多标签、存储和指纹恢复稳定', async () => {
      for (const record of configs) {
        await close(record.browser_id);
        await open(record.browser_id);
        const value = await sample(record.browser_id, 'reopen');
        assert.equal(value.fingerprintId, observations.get(record.browser_id).fingerprintId);
        const storage = await app.evaluate(async (_, id) => {
          const context = [...globalThis.__matrixContexts].findLast(([dir]) => dir.endsWith(id))[1];
          const pages = context.pages().filter(p => p.url().startsWith('http:'));
          return {
            tabs: pages.length,
            owner: await pages[0].evaluate(() => localStorage.getItem('test-matrix-owner')),
            tabMarkers: await Promise.all(
              pages.map(p => p.evaluate(() => sessionStorage.getItem('test-matrix-tab')))
            ),
          };
        }, record.browser_id);
        assert.equal(storage.owner, record.browser_id);
        assert.ok(storage.tabs >= 3);
        assert.deepEqual(
          new Set(storage.tabMarkers.filter(Boolean)),
          new Set([0, 1, 2].map(index => `${record.browser_id}:${index}`))
        );
      }
    });
    await test('自动指纹主页面 / iframe / Worker 的身份一致', async () => {
      for (const value of observations.values()) {
        assert.equal(value.checks.canvasRepeatStable, true);
        assert.equal(value.checks.iframeCanvasMatches, true);
        for (const key of ['userAgent', 'platform', 'language', 'hardwareConcurrency']) {
          assert.equal(value.checks.iframeIdentity[key], value.identity[key], `iframe ${key}`);
          assert.equal(value.checks.worker[key], value.identity[key], `Worker ${key}`);
          assert.equal(value.checks.moduleWorker[key], value.identity[key], `Module Worker ${key}`);
        }
      }
    });
  }
  for (const [type, port, name, auth] of [
    ['http', 19501, 'http', false],
    ['http', 19502, 'http-auth', true],
    ['socks5', 19503, 'socks5', false],
    ['socks5', 19504, 'socks5-auth', true],
    ...(process.env.FINGER_TEST_HTTPS_PROXY_SPKI
      ? [
          ['https', 19505, 'https', false],
          ['https', 19506, 'https-auth', true],
        ]
      : []),
  ]) {
    if (resumeProxies && type !== 'https') continue;
    await test(`真实 ${name} 代理：HTTPS 出口探测、验证网站和多标签`, async () => {
      const config = baseConfig('144.0.7500', `test-${run}-${name}`, {
        enabled: true,
        method: 'manual',
        type,
        delimiter: ':',
        text: `192.168.50.221:${port}${auth ? ':test-proxy:test-proxy-pass' : ''}`,
      });
      if (!resumeProxies) await api('/browsers/create', { config });
      const list = await api('/browsers/search', { page: 1, size: 200 });
      const record = list.list.find(item => item.name === config.base.name);
      assert.ok(record);
      if (!configs.some(item => item.browser_id === record.browser_id)) configs.push(record);
      await open(record.browser_id);
      const first = await sample(record.browser_id, 'proxy');
      const second = await sample(record.browser_id, 'proxy-tab', true);
      assert.equal(first.fingerprintId, second.fingerprintId);
      assert.equal(first.request.proxy, name);
      if (auth) {
        await close(record.browser_id);
        config.proxy.text = `192.168.50.221:${port}:test-proxy:wrong-test-password`;
        await api('/browsers/update', { id: record.browser_id, config });
        record.config = JSON.stringify(config);
        await assert.rejects(open(record.browser_id), /代理.*已阻止启动/);
        assert.ok(
          !(await page.evaluate(() => window.ipcRenderer.getAllInstances())).includes(
            record.browser_id
          )
        );
        config.proxy.text = `192.168.50.221:${port}:test-proxy:test-proxy-pass`;
        await api('/browsers/update', { id: record.browser_id, config });
        record.config = JSON.stringify(config);
        await open(record.browser_id);
        assert.equal(
          (await sample(record.browser_id, 'proxy-recovered')).fingerprintId,
          first.fingerprintId
        );
      }
      if (type === 'https' && auth)
        assert.equal((await page.evaluate(() => window.ipcRenderer.getAllInstances())).length, 9);
      return { fingerprintId: first.fingerprintId, routing: first.request.proxy, tabsStable: true };
    });
  }
  await test('通过代理 API 获取有效认证代理并保持同一窗口指纹', async () => {
    const record = configs.find(item => item.name.endsWith('-http-auth'));
    assert.ok(record);
    const before = await sample(record.browser_id, 'before-proxy-api');
    await close(record.browser_id);
    const config = JSON.parse(record.config);
    config.proxy = {
      enabled: true,
      method: 'api',
      type: 'http',
      delimiter: ':',
      text: `${process.env.FINGER_TEST_FIXTURE_SERVICE || site}/api/test-proxy`,
    };
    await api('/browsers/update', { id: record.browser_id, config });
    record.config = JSON.stringify(config);
    await open(record.browser_id);
    const after = await sample(record.browser_id, 'proxy-api');
    assert.equal(after.request.proxy, 'http-auth');
    assert.equal(after.fingerprintId, before.fingerprintId);
    return { api: true, routing: after.request.proxy, fingerprintStable: true };
  });
} finally {
  if (app) await app.close().catch(() => {});
  const summary = {
    run,
    platform: os.platform(),
    evidence,
    results,
    passed: results.filter(x => x.status === 'passed').length,
    failed: results.filter(x => x.status === 'failed').length,
  };
  await fs.writeFile(path.join(evidence, 'matrix.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ evidence, run, passed: summary.passed, failed: summary.failed }));
  if (summary.failed) process.exitCode = 1;
}
