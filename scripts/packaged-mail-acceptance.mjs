import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';
const control = process.env.FINGER_SYNC_CONTROL || 'http://192.168.50.221:19092';
assert.ok(process.env.FINGER_TEST_EXECUTABLE);
assert.equal(
  (await fetch('http://127.0.0.1:8889/health').then(r => r.json())).commit,
  'local-acceptance'
);
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'test-packaged-mail-'));
const app = await electron.launch({
  executablePath: process.env.FINGER_TEST_EXECUTABLE,
  args: [`--user-data-dir=${path.join(evidence, 'electron')}`],
  env: {
    ...process.env,
    PROJECT_MAC_BASE_PATH: path.join(evidence, 'data'),
    PROJECT_WIN_BASE_PATH: path.join(evidence, 'data'),
  },
});
const report = { platform: process.platform, evidence, passed: false };
let page;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByPlaceholder('请输入用户名').fill('test-acceptance-20261012');
  await page.getByPlaceholder('请输入密码').fill('test-Acceptance-20261012');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor();
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  await page.getByRole('menuitem', { name: '账号', exact: true }).click();
  const row = page.locator('.el-table__body tr').filter({ hasText: 'test-mail-real-20261012' });
  await row.getByRole('button', { name: '查看邮件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '邮件详情', exact: true });
  await dialog.locator('.email-item').first().waitFor({ timeout: 45000 });
  report.imapUiLoaded = true;
  report.mailCount = await dialog.locator('.email-item').count();
  await dialog.locator('.email-item').first().click();
  await dialog.frameLocator('iframe').getByText('021019', { exact: false }).first().waitFor();
  report.messageBodyLoaded = true;
  await dialog.getByRole('button', { name: '刷新', exact: true }).click();
  await dialog.getByRole('button', { name: '刷新', exact: true }).waitFor();
  report.refreshSucceeded = true;
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem('token');
    const call = async (endpoint, body) => {
      const value = await fetch('http://127.0.0.1:8889/api/v1' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (value.code !== 0) throw Error('Test mailbox API failed');
      return value.data;
    };
    const list = await call('/emails/search', {
      current: 1,
      pageSize: 100,
      apiName: 'test-mail-real-20261012',
    });
    const record = list.apikeyList.find(x => x.email === 'test-mail-real-20261012@outlook.top');
    if (!record) throw Error('Fixed test mailbox missing');
    const detail = await call('/emails/detail', { uuid: record.uuid });
    const connection = {
      email: detail.email,
      password: detail.mailPassword,
      host: 'mail.outlook.top',
      port: 995,
      tls: true,
      verifyCertificate: false,
    };
    const pop = await window.ipcRenderer.fetchEmailsViaPop3(connection);
    const code = await window.ipcRenderer.extractVerificationCode({ email: detail.email });
    return {
      pop3Success: pop.success,
      codeMatched: code.success && code.code === '021019',
      expiredCodeRejected: !code.success && /最近\s*30\s*分钟未找到验证码/.test(code.message || ''),
    };
  });
  Object.assign(report, result);
  assert.equal(result.pop3Success, true);
  if (process.env.FINGER_TEST_MAIL_EXPECT_EXPIRED === '1') {
    assert.equal(result.expiredCodeRejected, true, '不能将超过 30 分钟的旧邮件作为新验证码');
  } else {
    assert.equal(result.codeMatched, true);
  }
  Object.assign(report, result, { certificateExceptionHost: 'mail.outlook.top', passed: true });
  await page.screenshot({ path: path.join(evidence, 'mail-ui.png'), fullPage: true });
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  await fs.writeFile(path.join(evidence, 'mail-proof.json'), JSON.stringify(report, null, 2));
  await fetch(control + '/result/mail-' + process.platform, {
    method: 'POST',
    body: JSON.stringify(report),
  }).then(r => assert.equal(r.status, 201));
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await app.close();
  console.log(JSON.stringify(report));
}
