import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';
assert.equal(process.platform, 'win32');
assert.ok(process.env.FINGER_TEST_EXECUTABLE);
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'test-legacy-runtime-'));
const app = await electron.launch({
  executablePath: process.env.FINGER_TEST_EXECUTABLE,
  args: [`--user-data-dir=${path.join(evidence, 'electron')}`],
  env: { ...process.env, PROJECT_WIN_BASE_PATH: path.join(evidence, 'data') },
});
const report = { platform: process.platform, evidence, passed: false };
try {
  const page = await app.firstWindow();
  await page.getByPlaceholder('请输入用户名').fill('test-sync-20261013-0747');
  await page.getByPlaceholder('请输入密码').fill('test-Acceptance-20261012');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor();
  await app.evaluate(({ app }) => {
    const { chromium } = process
      .getBuiltinModule('module')
      .createRequire(app.getAppPath() + '/package.json')('playwright');
    const original = chromium.launchPersistentContext;
    globalThis.__legacyKernelLaunches = 0;
    chromium.launchPersistentContext = function (...args) {
      globalThis.__legacyKernelLaunches++;
      return original.apply(this, args);
    };
  });
  const failure = await page.evaluate(async () => {
    const token = localStorage.getItem('token');
    const response = await fetch('http://127.0.0.1:8889/api/v1/browsers/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ page: 1, size: 100, includeRecovery: false }),
    }).then(r => r.json());
    if (response.code !== 0) throw Error('Fixture read failed');
    const r = response.data.list[0];
    try {
      await window.ipcRenderer.restoreInstance({
        id: r.browser_id,
        config: JSON.parse(r.config),
        cloudRecoveryVersion: 1,
      });
      return '';
    } catch (error) {
      return error.message;
    }
  });
  Object.assign(report, {
    message: failure,
    nativeLaunchCount: await app.evaluate(() => globalThis.__legacyKernelLaunches),
  });
  assert.match(failure, /升级客户端|互锁|恢复/);
  assert.equal(await app.evaluate(() => globalThis.__legacyKernelLaunches), 0);
  Object.assign(report, { passed: true, startupRejectedBeforeKernel: true, message: failure });
} finally {
  await fs.writeFile(path.join(evidence, 'legacy-proof.json'), JSON.stringify(report, null, 2));
  await fetch('http://192.168.50.221:19092/result/legacy-win32', {
    method: 'POST',
    body: JSON.stringify(report),
  }).then(r => assert.equal(r.status, 201));
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await app.close();
  console.log(JSON.stringify(report));
}
