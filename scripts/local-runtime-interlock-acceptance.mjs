import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { _electron as electron } from 'playwright';
const evidence =
  process.env.FINGER_TEST_RUNTIME_EVIDENCE ||
  (await fs.mkdtemp(path.join(os.tmpdir(), 'test-strict-runtime-')));
const appData = path.join(evidence, 'data'),
  userData = path.join(evidence, 'electron');
await fs.mkdir(path.join(appData, 'browser'), { recursive: true });
for (const version of ['140.0.7259', '144.0.7500'])
  if (!(await fs.lstat(path.join(appData, 'browser', version)).catch(() => null)))
    await fs.symlink(
      path.join(process.env.FINGER_TEST_KERNEL_ROOT, version),
      path.join(appData, 'browser', version),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
const fixture = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>test-runtime-restart</title><h1>test-runtime-restart</h1>');
});
await new Promise(resolve => fixture.listen(19093, '127.0.0.1', resolve));
let app, page, token;
const report = { platform: process.platform, evidence, passed: false };
const request = async (endpoint, body) =>
  fetch('http://127.0.0.1:8889/api/v1' + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finger-Runtime-Protocol': '1',
      Authorization: token,
    },
    body: JSON.stringify(body),
  }).then(r => r.json());
const api = async (endpoint, body) => {
  const reply = await request(endpoint, body);
  assert.equal(reply.code, 0, reply.message);
  return reply.data;
};
async function startApp() {
  app = await electron.launch({
    executablePath: process.env.FINGER_TEST_EXECUTABLE,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, PROJECT_MAC_BASE_PATH: appData, PROJECT_WIN_BASE_PATH: appData },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await Promise.race([
    page.getByPlaceholder('请输入用户名').waitFor(),
    page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor(),
  ]);
  if (await page.getByPlaceholder('请输入用户名').isVisible()) {
    await page.getByPlaceholder('请输入用户名').fill('test-sync-20261013-0747');
    await page.getByPlaceholder('请输入密码').fill('test-Acceptance-20261012');
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor();
  token = await page.evaluate(() => localStorage.getItem('token'));
  await app.evaluate(({ app }) => {
    const { chromium } = process
      .getBuiltinModule('module')
      .createRequire(app.getAppPath() + '/package.json')('playwright');
    const native = chromium.launchPersistentContext;
    globalThis.__rtContexts = new Map();
    chromium.launchPersistentContext = async function (dir, ...args) {
      const ctx = await native.call(this, dir, ...args);
      globalThis.__rtContexts.set(dir, ctx);
      return ctx;
    };
  });
}
async function open(record) {
  await page.evaluate(data => window.ipcRenderer.restoreInstance(data), {
    id: record.browser_id,
    config: JSON.parse(record.config),
    cloudRecoveryVersion: 1,
  });
}
async function storage(id, write) {
  return app.evaluate(
    async (_, { id, write }) => {
      const ctx = [...globalThis.__rtContexts].findLast(([dir]) => dir.endsWith(id))?.[1];
      if (!ctx) throw Error('Native browser missing');
      let p = ctx.pages().find(x => x.url().startsWith('http://127.0.0.1:19093'));
      if (!p) {
        p = await ctx.newPage();
        await p.goto('http://127.0.0.1:19093/restart');
      }
      return p.evaluate(write => {
        if (write) localStorage.setItem('test-strict-restart', 'from-original-device');
        return localStorage.getItem('test-strict-restart');
      }, write);
    },
    { id, write }
  );
}
try {
  await startApp();
  const records = (await api('/browsers/search', { page: 1, size: 100, includeRecovery: false }))
    .list;
  const record = records.find(x => JSON.parse(x.config).base.browserVersion === '140.0.7259');
  assert.ok(record);
  await open(record);
  assert.equal(await storage(record.browser_id, true), 'from-original-device');
  await app.evaluate(async (_, id) => {
    const ctx = [...globalThis.__rtContexts].findLast(([dir]) => dir.endsWith(id))?.[1];
    const p = ctx.pages().find(x => x.url().startsWith('http://127.0.0.1:19093'));
    await p.reload();
  }, record.browser_id);
  await page.evaluate(
    id =>
      window.ipcRenderer.saveCredential(
        id,
        '127.0.0.1',
        'test-runtime-user',
        'test-runtime-password'
      ),
    record.browser_id
  );
  let saved = false;
  for (let i = 0; i < 60 && !saved; i++) {
    saved = (await api('/browsers/recovery', { id: record.browser_id })).state.includes(
      'test-strict-restart'
    );
    if (!saved) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(
    saved,
    'The running browser must checkpoint the test storage before the deliberate crash'
  );
  const lockFile = path.join(userData, 'browser-runtime-locks.json');
  const raw = await fs.readFile(lockFile, 'utf8');
  assert.ok(raw.includes('v1:'));
  assert.ok(!/[a-f0-9]{64}/.test(raw));
  report.encryptedOwnershipSaved = true;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close();
  app = null;
  const contender = {
    id: record.browser_id,
    token: 'f'.repeat(64),
    device: process.platform === 'darwin' ? 'win32' : 'darwin',
  };
  assert.notEqual((await request('/browsers/runtime/acquire', contender)).code, 0);
  report.crashDoesNotReleaseOwnership = true;
  console.log(JSON.stringify({ stage: 'waiting-for-expiry', evidence }));
  await new Promise(resolve => setTimeout(resolve, 95000));
  const listed = (
    await api('/browsers/search', { page: 1, size: 100, includeRecovery: false })
  ).list.find(x => x.browser_id === record.browser_id);
  assert.equal(listed.runtimeLocked, true);
  assert.equal(listed.runtimeActive, false);
  assert.notEqual((await request('/browsers/runtime/acquire', contender)).code, 0);
  report.expiryDoesNotPermitOtherDevice = true;
  await startApp();
  await open(record);
  assert.equal(await storage(record.browser_id, false), 'from-original-device');
  report.restartRestoresOwnTokenAndLatestState = true;
  await app.evaluate(({ app }) => { app.quit(); app.quit(); }).catch(() => {});
  await app.close();
  app = null;
  const released = (
    await api('/browsers/search', { page: 1, size: 100, includeRecovery: false })
  ).list.find(x => x.browser_id === record.browser_id);
  assert.equal(released.runtimeLocked, false);
  report.repeatedQuitWaitsForSaveAndRelease = true;
  const acquired = await api('/browsers/runtime/acquire', contender);
  await api('/browsers/runtime/release', {
    ...contender,
    recoveryRevision: acquired.recovery.recoveryRevision,
  });
  report.handoffOnlyAfterConfirmedClose = true;
  report.passed = true;
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  await fs.writeFile(
    path.join(evidence, 'strict-runtime-proof.json'),
    JSON.stringify(report, null, 2)
  );
  if (process.env.FINGER_TEST_RESULT_URL)
    await fetch(process.env.FINGER_TEST_RESULT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'windows-runtime-strict', report }),
    }).then(r => assert.equal(r.status, 201));
  if (app) {
    await page
      ?.evaluate(async () => {
        for (const id of await window.ipcRenderer.getAllInstances())
          await window.ipcRenderer.removeInstance(id);
      })
      .catch(() => {});
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
  await new Promise(resolve => fixture.close(resolve));
  console.log(JSON.stringify(report));
}
