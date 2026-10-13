#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import http from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const apiBase = 'http://127.0.0.1:8889/api/v1';
const username = 'test-acceptance-20261012';
const password = 'test-Acceptance-20261012';
const mode = process.argv[2] || 'inspect';
const packagedIndex = process.argv.indexOf('--packaged-executable');
const packagedExecutable =
  packagedIndex >= 0 ? process.argv[packagedIndex + 1] : process.env.FINGER_TEST_EXECUTABLE;
const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'test-finger-ui-1012-'));
const appData = path.join(evidenceRoot, 'appdata');
await fs.mkdir(appData, { mode: 0o700, recursive: true });

// Both process bundles must already have passed build:local. Never rebuild here.
const mainCode = await fs.readFile(path.join(root, 'dist-electron/main/index.js'), 'utf8');
assert.ok(mainCode.includes(apiBase), 'Build is not fixed to the isolated local API');
const health = await fetch('http://127.0.0.1:8889/health').then(r => r.json());
assert.equal(health.commit, 'local-acceptance', 'Refuse a non-acceptance backend');
const app = await electron.launch({
  executablePath: packagedExecutable || require('electron'),
  args: [
    ...(packagedExecutable ? [] : [root]),
    `--user-data-dir=${path.join(evidenceRoot, 'electron')}`,
  ],
  env: {
    ...process.env,
    PROJECT_MAC_BASE_PATH: appData,
    PROJECT_WIN_BASE_PATH: appData,
    ...(process.env.FINGER_TEST_BROWSER_DEBUG === '1' ? { DEBUG: 'pw:browser' } : {}),
  },
  timeout: 30_000,
});
if (process.env.FINGER_TEST_BROWSER_DEBUG === '1') {
  app
    .process()
    .stderr.on('data', bytes => fs.appendFile(path.join(evidenceRoot, 'browser-debug.txt'), bytes));
}
try {
  const page = await app.firstWindow();
  const rendererErrors = [];
  page.on('pageerror', error => rendererErrors.push(error.message));
  if (packagedExecutable)
    assert.equal(
      await app.evaluate(({ app }) => app.isPackaged),
      true,
      'The test is not running an installed application bundle'
    );
  const unexpected = [];
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (
      ['file:', 'data:', 'blob:'].includes(url.protocol) ||
      ['127.0.0.1', 'localhost'].includes(url.hostname)
    )
      return route.continue();
    unexpected.push(url.origin);
    return route.abort();
  });
  await page.getByPlaceholder('请输入用户名').fill(username);
  await page.getByPlaceholder('请输入密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor({ timeout: 20_000 });
  console.log('PASS: desktop login with a >20-character username');
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const request = async (endpoint, data) => {
    const response = await fetch(`${apiBase}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Finger-Runtime-Protocol': '1', Authorization: token },
      body: JSON.stringify(data),
    }).then(r => r.json());
    assert.equal(response.code, 0, response.message);
    return response.data;
  };
  if (mode === 'account-inspect') {
    await page.getByRole('menuitem', { name: '账号', exact: true }).click();
    await page.getByRole('button', { name: '添加账号', exact: true }).click();
    await page.getByRole('dialog').waitFor();
  }
  if (mode === 'browser-inspect') {
    await page.getByRole('button', { name: '创建新窗口', exact: true }).click();
    await page.getByRole('dialog').waitFor();
  }
  if (mode === 'migration') {
    const email = 'test-ui-1012@example.test';
    let accounts = await request('/emails/search', { pageSize: 200, current: 1 });
    let account = accounts.apikeyList.find(item => item.email === email);
    await page.getByRole('menuitem', { name: '账号', exact: true }).click();
    if (!account) {
      await page.getByRole('button', { name: '添加账号', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '添加账号' });
      await dialog.getByRole('textbox', { name: '账号名称', exact: true }).fill('test-迁移验收');
      await dialog.getByRole('textbox', { name: '邮箱地址', exact: true }).fill(email);
      await dialog
        .getByRole('textbox', { name: '邮箱密码', exact: true })
        .fill('test-mail-password');
      await dialog
        .getByRole('textbox', { name: '账号密码', exact: true })
        .fill('test-account-password');
      await dialog.getByRole('button', { name: '确定', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      accounts = await request('/emails/search', { pageSize: 200, current: 1 });
      account = accounts.apikeyList.find(item => item.email === email);
      assert.ok(account, 'Account created through UI was not persisted');
    }
    const status = await request('/emails/google_auth_migration_status', { uuid: account.uuid });
    assert.equal(
      status.googleAuthStatus,
      'not_configured',
      'Use a fresh test fixture for migration'
    );
    await page.evaluate(
      async ({ uuid, email }) =>
        window.ipcRenderer.commitLocalAuthSecret({ uuid, email, secret: 'JBSWY3DPEHPK3PXP' }),
      account
    );
    const row = page.getByRole('row').filter({ hasText: 'test-迁移验收' });
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑账号' });
    await edit.getByRole('button', { name: '迁移旧密钥或重新录入' }).click();
    const migration = page.getByRole('dialog', { name: '恢复谷歌验证密钥' });
    await migration.waitFor();
    console.log(await migration.ariaSnapshot());
    await page.screenshot({ path: path.join(evidenceRoot, 'migration-confirm.png') });
    await migration.getByRole('button', { name: '确认保存并验证' }).click();
    await migration.waitFor({ state: 'hidden' });
    const migrated = await request('/emails/google_auth_migration_status', { uuid: account.uuid });
    assert.equal(migrated.googleAuthStatus, 'ready');
    const code = await request('/emails/google_auth_code', { uuid: account.uuid });
    assert.match(code.code, /^\d{6}$/);
    const preview = await page.evaluate(
      uuid => window.ipcRenderer.prepareGoogleAuthMigration({ uuid }),
      account.uuid
    );
    assert.equal(preview.status, 'ready');
    assert.equal(preview.ticket, undefined);
    console.log(
      'PASS: account creation, safeStorage old-secret migration, server verification, ready protection'
    );
  }
  if (mode === 'cloud-code') {
    await page.getByRole('menuitem', { name: '账号', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'test-迁移验收' });
    await row.getByRole('button', { name: '谷歌码', exact: true }).click();
    await page.locator('.code-result__value').waitFor();
    assert.match(await page.locator('.code-result__value').textContent(), /^\d{6}$/);
    await page.screenshot({ path: path.join(evidenceRoot, 'cloud-code.png') });
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    console.log('PASS: a fresh desktop device reads cloud TOTP without local secrets');
  }
  if (mode === 'navigation') {
    await page.getByRole('menuitem', { name: '分组', exact: true }).click();
    await page.getByRole('tab', { name: '浏览器分组', exact: true }).waitFor();
    await page.getByRole('tab', { name: '账号分组', exact: true }).click();
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByRole('menuitem', { name: '内核', exact: true }).click();
    await page.getByRole('button', { name: '添加内核', exact: true }).click();
    const kernels = page.getByRole('dialog', { name: '可用内核版本', exact: true });
    await kernels.getByText('140.0.7259', { exact: true }).waitFor();
    await kernels.getByText('144.0.7500', { exact: true }).waitFor();
    await kernels
      .getByRole('button', { name: /Close|关闭/ })
      .first()
      .click();
    await page.getByRole('menuitem', { name: '账号', exact: true }).click();
    await page.getByRole('button', { name: '模板下载', exact: true }).waitFor();
    const accountRow = page.getByRole('row').filter({ hasText: 'test-迁移验收' });
    await accountRow.getByRole('button', { name: '实名', exact: true }).waitFor();
    assert.match(await accountRow.textContent(), /\d{1,2}月\d{1,2}日/);
    assert.ok(
      !(await accountRow.textContent()).includes('enc:v2:'),
      'Encrypted secrets must not be displayed'
    );
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
    await page.getByRole('menuitem', { name: '余额与账单', exact: true }).click();
    await page.getByRole('heading', { name: '余额与账单', exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByText('USDT 链充值暂未开放，本页不提供充值操作。', { exact: true }).waitFor();
    await page.getByRole('heading', { name: '账单明细', exact: true }).waitFor();
    assert.ok(!(await page.locator('main').textContent()).includes('加载失败'));
    console.log(
      'PASS: packaged group/core/account/settings/billing navigation and server-backed refresh'
    );
  }
  if (['browser', 'browser-restore'].includes(mode)) {
    // Instrument the external Playwright dependency only inside this test process.
    // No debug flag or test API is compiled into the released application.
    await app.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('module');
      const load = createRequire(app.getAppPath() + '/package.json');
      const { chromium } = load('playwright');
      const launch = chromium.launchPersistentContext.bind(chromium);
      globalThis.__acceptanceContexts = new Map();
      globalThis.__acceptanceOptions = new Map();
      chromium.launchPersistentContext = async (...args) => {
        const context = await launch(...args);
        globalThis.__acceptanceContexts.set(args[0], context);
        globalThis.__acceptanceOptions.set(args[0], args[1]);
        return context;
      };
    });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>test-跨设备业务恢复</title><h1>test-跨设备业务恢复</h1>');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(19081, '127.0.0.1', resolve);
    });
    const site = 'http://127.0.0.1:19081/';
    const browserName = 'test-ui-cloud-1012';
    let browserId;
    try {
      // First device can reuse a previously verified core; the second device will download.
      if (mode === 'browser' || process.env.FINGER_TEST_KERNEL_ROOT) {
        await fs.mkdir(path.join(appData, 'browser'), { recursive: true });
        const installed = path.join(
          process.env.FINGER_TEST_KERNEL_ROOT ||
            path.join(os.homedir(), 'Library', 'Application Support', 'finger-browser', 'browser'),
          '140.0.7259'
        );
        await fs.symlink(
          installed,
          path.join(appData, 'browser', '140.0.7259'),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      }
      let browsers = await request('/browsers/search', {
        page: 1,
        size: 200,
        includeRecovery: false,
      });
      let browser = browsers.list.find(item => item.name === browserName);
      if (!browser) {
        await page.getByRole('button', { name: '创建新窗口', exact: true }).click();
        const create = page.getByRole('dialog', { name: '创建新窗口' });
        await create.getByRole('textbox', { name: /名称/ }).fill(browserName);
        await create.getByRole('combobox', { name: /浏览器版本/ }).press('Enter');
        await page.getByRole('option', { name: '140.0.7259', exact: true }).click();
        await create.getByRole('button', { name: '创建窗口', exact: true }).click();
        await create.waitFor({ state: 'hidden' });
        browsers = await request('/browsers/search', {
          page: 1,
          size: 200,
          includeRecovery: false,
        });
        browser = browsers.list.find(item => item.name === browserName);
      }
      assert.ok(browser);
      browserId = browser.browser_id;
      const row = page.getByRole('row').filter({ hasText: browserName });
      if (mode === 'browser') {
        await row.getByRole('button', { name: '编辑', exact: true }).click();
        const edit = page.getByRole('dialog', { name: '编辑窗口' });
        await edit.getByRole('textbox', { name: '初始 URL', exact: true }).fill(site);
        await edit.getByRole('button', { name: '保存修改', exact: true }).click();
        await edit.waitFor({ state: 'hidden' });
        const current = (
          await request('/browsers/search', { page: 1, size: 200, includeRecovery: false })
        ).list.find(item => item.browser_id === browserId);
        const config = JSON.parse(current.config);
        config.base.operatingSystem = ['Windows NT 10.0'];
        config.base.userAgent =
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7259 Safari/537.36';
        Object.assign(config.finger, {
          platform: 'Win32',
          language: 'en-US',
          languages: ['en-US', 'en'],
          timezone: 'Asia/Singapore',
          screenResolution: '1366x768',
          hardwareConcurrency: 4,
          deviceMemory: 8,
          doNotTrack: true,
          canvas: true,
          webgl: true,
          audioFingerprint: true,
          clientRects: true,
          webRTC: 'proxy_only',
        });
        const account = (
          await request('/emails/search', { pageSize: 200, current: 1 })
        ).apikeyList.find(item => item.email === 'test-ui-1012@example.test');
        await request('/browsers/update', {
          id: browserId,
          config,
          email_uuid: account?.uuid || '',
        });
        await page.getByRole('button', { name: '搜索', exact: true }).click();
      }
      const openedAt = Date.now();
      await row.getByRole('button', { name: '打开', exact: true }).click();
      await page.waitForFunction(() => document.body.textContent.includes('运行中'), null, {
        timeout: 180_000,
      });
      if (mode === 'browser')
        await page.evaluate(
          id =>
            window.ipcRenderer.saveCredential(
              id,
              '127.0.0.1',
              'test-site-user',
              'test-site-password'
            ),
          browserId
        );
      if (mode === 'browser-restore') {
        const result = await app.evaluate(
          async (_, { id, site }) => {
            const context = [...globalThis.__acceptanceContexts.entries()].find(([dir]) =>
              dir.endsWith(id)
            )?.[1];
            if (!context) throw new Error('Restored Chromium context unavailable');
            const business = context.pages().find(p => p.url() === site);
            if (!business) throw new Error('Restored business page unavailable');
            const values = await business.evaluate(async () => {
              const root = await navigator.storage.getDirectory();
              const file = await root.getFileHandle('test-opfs.txt');
              const response = await (await caches.open('test-cache')).match('/test-cached');
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open('test-final-idb');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              const idb = await new Promise((resolve, reject) => {
                const req = db.transaction('items').objectStore('items').get('key');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              db.close();
              return {
                opfs: await (await file.getFile()).text(),
                cache: response ? await response.text() : null,
                cacheNames: await caches.keys(),
                cacheRequests: await Promise.all(
                  (await (await caches.open('test-cache')).keys()).map(async request => request.url)
                ),
                local: localStorage.getItem('test-local'),
                session: sessionStorage.getItem('test-session'),
                idb,
                platform: navigator.platform,
                language: navigator.language,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                width: screen.width,
                height: screen.height,
                cpu: navigator.hardwareConcurrency,
                memory: navigator.deviceMemory,
                dnt: navigator.doNotTrack,
              };
            });
            values.cookie = (await context.cookies()).find(c => c.name === 'test-cookie')?.value;
            const options = [...globalThis.__acceptanceOptions].find(([dir]) =>
              dir.endsWith(id)
            )?.[1];
            values.launchPath = [...globalThis.__acceptanceOptions].find(([dir]) =>
              dir.endsWith(id)
            )?.[0];
            values.launchOptions = Object.fromEntries(
              ['args', 'ignoreDefaultArgs', 'userAgent', 'locale', 'timezoneId', 'viewport'].map(
                key => [key, options?.[key]]
              )
            );
            return values;
          },
          { id: browserId, site }
        );
        await fs.writeFile(
          path.join(evidenceRoot, 'restore-values.json'),
          JSON.stringify(result, null, 2)
        );
        for (const [key, value] of Object.entries({
          opfs: 'test-opfs-content',
          cache: 'test-cache-content',
          local: 'test-local-latest',
          session: 'test-second-tab-latest',
          idb: 'test-idb-latest',
          cookie: 'test-cookie-content',
          platform: 'Win32',
          language: 'en-US',
          timezone: 'Asia/Singapore',
          width: 1366,
          height: 768,
          cpu: 4,
          memory: 8,
          dnt: '1',
        }))
          assert.equal(result[key], value, key);
        const history = await page.evaluate(
          id => window.ipcRenderer.getBrowserHistory(id, 20),
          browserId
        );
        const credentials = await page.evaluate(
          id => window.ipcRenderer.getSavedCredentials(id),
          browserId
        );
        assert.ok(JSON.stringify(history).includes(site), 'History not restored');
        assert.ok(
          JSON.stringify(credentials).includes('test-site-user'),
          'Saved credentials not restored'
        );
        console.log(
          `PASS: fresh desktop ${process.env.FINGER_TEST_KERNEL_ROOT ? 'used the verified test core' : 'automatically downloaded core'}, restored Cookie/localStorage/IndexedDB/sessionStorage/OPFS/CacheStorage/history/credentials and explicit fingerprints`
        );
        await fs.writeFile(
          path.join(evidenceRoot, 'device-b-proof.json'),
          JSON.stringify({ browserId, result, historyRestored: true, credentialsRestored: true }),
          { mode: 0o600 }
        );
      } else {
        const fingerprint = await app.evaluate(
          async (_, { id, site }) => {
            const entry = [...globalThis.__acceptanceContexts.entries()].find(([dir]) =>
              dir.endsWith(id)
            );
            if (!entry) throw new Error('Business Chromium context not captured');
            const context = entry[1];
            const first = context.pages().find(p => p.url() === site);
            if (!first) throw new Error('Edited initial URL was not opened');
            const second = await context.newPage();
            await second.goto(site);
            await first.evaluate(() => sessionStorage.setItem('test-session', 'test-first-tab'));
            await second.evaluate(async () => {
              sessionStorage.setItem('test-session', 'test-second-tab');
              localStorage.setItem('test-local', 'test-local-content');
              const root = await navigator.storage.getDirectory();
              const file = await root.getFileHandle('test-opfs.txt', { create: true });
              const writer = await file.createWritable();
              await writer.write('test-opfs-content');
              await writer.close();
              await (
                await caches.open('test-cache')
              ).put('/test-cached', new Response('test-cache-content'));
            });
            await context.addCookies([
              { name: 'test-cookie', value: 'test-cookie-content', domain: '127.0.0.1', path: '/' },
            ]);
            const values = await second.evaluate(() => ({
              ua: navigator.userAgent,
              platform: navigator.platform,
              language: navigator.language,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              width: screen.width,
              height: screen.height,
              cpu: navigator.hardwareConcurrency,
              memory: navigator.deviceMemory,
              dnt: navigator.doNotTrack,
            }));
            await first.close();
            await new Promise(r => setTimeout(r, 300));
            await second.evaluate(async () => {
              sessionStorage.setItem('test-session', 'test-second-tab-latest');
              localStorage.setItem('test-local', 'test-local-latest');
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open('test-final-idb', 1);
                req.onupgradeneeded = () => req.result.createObjectStore('items');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              await new Promise((resolve, reject) => {
                const tx = db.transaction('items', 'readwrite');
                tx.objectStore('items').put('test-idb-latest', 'key');
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
              });
              db.close();
            });
            await second.close();
            return values;
          },
          { id: browserId, site }
        );
        assert.equal(fingerprint.platform, 'Win32');
        assert.equal(fingerprint.language, 'en-US');
        assert.equal(fingerprint.timezone, 'Asia/Singapore');
        assert.equal(fingerprint.width, 1366);
        assert.equal(fingerprint.height, 768);
        assert.equal(fingerprint.cpu, 4);
        assert.equal(fingerprint.memory, 8);
        assert.equal(fingerprint.dnt, '1');
        let recovery;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          recovery = await request('/browsers/recovery', { id: browserId });
          const state = JSON.parse(recovery.state || 'null');
          if (state?.portableProfile?.capturedAt >= openedAt) {
            break;
          }
          await new Promise(r => setTimeout(r, 300));
        }
        const state = JSON.parse(recovery.state || 'null');
        assert.ok(state?.portableProfile, 'Stopped native files were not saved to cloud');
        assert.equal(
          state.sessionStorage[0].origins[0].entries.find(e => e.name === 'test-session').value,
          'test-second-tab-latest'
        );
        assert.equal(
          state.origins
            .find(o => o.origin === 'http://127.0.0.1:19081')
            .localStorage.find(e => e.name === 'test-local').value,
          'test-local-latest'
        );
        const idb = state.origins.find(o => o.origin === 'http://127.0.0.1:19081').indexedDB;
        assert.ok(
          idb?.some(db => db.name === 'test-final-idb'),
          'Last-second IndexedDB write was lost'
        );
        console.log(
          JSON.stringify({
            passed: 'Desktop create/edit/core/close/full-cloud-save',
            browserId,
            fingerprint,
            revision: recovery.recoveryRevision,
            profileFiles: state.portableProfile.files.length,
          })
        );
        await fs.writeFile(
          path.join(evidenceRoot, 'browser-proof.json'),
          JSON.stringify({
            browserId,
            fingerprint,
            revision: recovery.recoveryRevision,
            profileFiles: state.portableProfile.files.map(f => f.path),
          }),
          { mode: 0o600 }
        );
      }
    } finally {
      if (browserId)
        await page.evaluate(id => window.ipcRenderer.removeInstance(id), browserId).catch(() => {});
      await new Promise(resolve => server.close(resolve));
    }
  }
  await page.screenshot({ path: path.join(evidenceRoot, 'desktop.png') });
  console.log(await page.locator('body').ariaSnapshot());
  console.log(`Evidence: ${evidenceRoot}`);
  assert.deepEqual(unexpected, [], 'Desktop attempted to access a remote API');
  assert.deepEqual(rendererErrors, [], 'Desktop renderer has uncaught exceptions');
  console.log(
    JSON.stringify({ passed: true, mode, platform: process.platform, evidence: evidenceRoot })
  );
  if (
    ![
      'inspect',
      'account-inspect',
      'browser-inspect',
      'migration',
      'cloud-code',
      'navigation',
      'browser',
      'browser-restore',
    ].includes(mode)
  )
    throw new Error(`Unknown acceptance mode: ${mode}`);
} catch (error) {
  console.error(`Failed acceptance evidence: ${evidenceRoot}`);
  throw error;
} finally {
  await app.close();
}
