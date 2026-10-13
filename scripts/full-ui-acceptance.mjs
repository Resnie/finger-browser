#!/usr/bin/env node
// Run after build:local, with the documented isolated acceptance API/MySQL running.
// Native file selections and mail responses are controlled only inside the test process.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import ExcelJS from 'exceljs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const apiBase = 'http://127.0.0.1:8889/api/v1';
const run = Date.now().toString(36);
const username = process.env.FINGER_TEST_USERNAME || `test-full-ui-${run}`;
assert.match(username, /^test-full-ui-[A-Za-z0-9_-]+$/);
const testExecutable = process.env.FINGER_TEST_EXECUTABLE;
const password = 'test-Acceptance-20261012';
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'test-finger-full-ui-'));
const appData = path.join(evidence, 'appdata');
const results = [];
const rendererErrors = [];
const unexpectedOrigins = new Set();
let app, page, token, originalClipboard;
await fs.mkdir(appData, { mode: 0o700 });
assert.ok(
  (await fs.readFile(path.join(root, 'dist-electron/main/index.js'), 'utf8')).includes(apiBase)
);
assert.equal(
  (await fetch('http://127.0.0.1:8889/health').then(r => r.json())).commit,
  'local-acceptance'
);

// Clone only the fixed, documented fixture's password hash into a new test user.
const sql = `INSERT INTO t_user (name,user,password,isGoAuthCloud,isEmailCloud,emailSyncType,created_at,updated_at)
SELECT '${username}','${username}',password,1,1,0,NOW(),NOW() FROM t_user WHERE user='test-acceptance-20261012' LIMIT 1;`;
const seeded = process.env.FINGER_TEST_USERNAME
  ? { status: 0 }
  : spawnSync(
      'docker',
      [
        'exec',
        '-e',
        'MYSQL_PWD=test-local-mysql-20261012',
        'test-finger-mysql-20261012',
        'mysql',
        '-uroot',
        'test_finger_acceptance_20261012',
        '-e',
        sql,
      ],
      { encoding: 'utf8' }
    );
assert.equal(seeded.status, 0, 'Could not seed the isolated test user');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(
    `<!doctype html><title>test-full-ui ${req.url}</title><h1>本地验收</h1><form><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>登录</button></form>`
  );
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const site = `http://127.0.0.1:${server.address().port}/`;

async function start() {
  app = await electron.launch({
    executablePath: testExecutable || require('electron'),
    args: [...(testExecutable ? [] : [root]), `--user-data-dir=${path.join(evidence, 'electron')}`],
    env: { ...process.env, PROJECT_MAC_BASE_PATH: appData, PROJECT_WIN_BASE_PATH: appData },
    timeout: 30000,
  });
  page = await app.firstWindow();
  originalClipboard ??= await app.evaluate(({ clipboard }) => clipboard.readText());
  page.setDefaultTimeout(9000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (
      ['file:', 'data:', 'blob:'].includes(url.protocol) ||
      ['127.0.0.1', 'localhost'].includes(url.hostname)
    )
      return route.continue();
    unexpectedOrigins.add(url.origin);
    return route.abort();
  });
  await page.waitForLoadState('networkidle');
}
const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
const dialog = name => page.getByRole('dialog', { name, exact: true });
const row = text => page.locator('.el-table__body tr').filter({ hasText: text });
const formLabel = name =>
  new RegExp(`^(?:\\*\\s*)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
async function seen(text, scope = page, timeout = 9000) {
  await scope.getByText(text, { exact: false }).first().waitFor({ timeout });
}
async function absent(locator) {
  await locator.first().waitFor({ state: 'hidden' });
}
async function nav(name) {
  await page.getByRole('menuitem', { name, exact: true }).click();
  await page.waitForLoadState('networkidle');
}
async function select(scope, name, value) {
  const combo = scope.getByRole('combobox', { name: formLabel(name) });
  await combo.press('Enter');
  const controls = await combo.getAttribute('aria-controls');
  await page
    .locator(`[id="${controls}"]`)
    .getByRole('option', { name: value, exact: true })
    .click();
}
async function confirm(name) {
  const box = page.locator('.el-message-box');
  await box.waitFor();
  await button(name, box).click();
  await absent(box);
}
async function closeDialogs() {
  if (await page.locator('.el-select__popper:visible').count()) await page.keyboard.press('Escape');
  const box = page.locator('.el-message-box');
  if (await box.isVisible()) {
    const cancel = button('取消', box);
    if (await cancel.count()) await cancel.click();
    else await page.keyboard.press('Escape');
  }
  for (let i = 0; i < 4; i++) {
    const d = page.locator('.el-dialog:visible').last();
    if (!(await d.count()) || !(await d.isVisible())) break;
    const cancel = button('取消', d),
      close = button('关闭', d);
    if (await cancel.count()) await cancel.click();
    else if (await close.count()) await close.click();
    else await d.locator('.el-dialog__headerbtn').click();
    await absent(d);
  }
}
async function test(name, fn, kind = 'real-ui-api') {
  const started = Date.now();
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0]?.focus();
  });
  token = await page.evaluate(() => localStorage.getItem('token')).catch(() => token);
  await page.mouse.move(8, 600);
  await page
    .waitForFunction(() => !document.querySelector('.el-message'), null, { timeout: 10000 })
    .catch(() => {});
  try {
    const details = await fn();
    results.push({
      name,
      kind,
      status: 'passed',
      ms: Date.now() - started,
      ...(details ? { details } : {}),
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, kind, status: 'failed', error: error.message, ms: Date.now() - started });
    console.log(`FAIL ${name}: ${error.message.split('\n')[0]}`);
    await page
      .screenshot({ path: path.join(evidence, `failure-${results.length}.png`), fullPage: true })
      .catch(() => {});
    await fs
      .writeFile(
        path.join(evidence, `failure-${results.length}.txt`),
        await page.locator('body').innerText()
      )
      .catch(() => {});
    await fs
      .writeFile(
        path.join(evidence, `failure-${results.length}.aria.txt`),
        await page.locator('body').ariaSnapshot()
      )
      .catch(() => {});
    await closeDialogs().catch(() => {});
  }
  await fs.writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify(
      { username, site, results, rendererErrors, unexpectedOrigins: [...unexpectedOrigins] },
      null,
      2
    )
  );
}
async function api(endpoint, data, options = {}) {
  const response = await fetch(apiBase + endpoint, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: options.token ?? token },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const payload = await response.json();
  if (!options.allowFailure) assert.equal(payload.code, 0, `${endpoint}: ${payload.message}`);
  return options.allowFailure ? { httpStatus: response.status, ...payload } : payload.data;
}
async function login() {
  await page.getByPlaceholder('请输入用户名').fill(username);
  await page.getByPlaceholder('请输入密码').fill(password);
  await button('登录').click();
  await button('创建新窗口').waitFor({ timeout: 20000 });
  token = await page.evaluate(() => localStorage.getItem('token'));
}
const names = {
  browserGroup: `test-窗口组-${run}`,
  accountGroup: `test-账号组-${run}`,
  account: `test-账号-${run}`,
  browser: `test-窗口-${run}`,
};
let account, browser;

try {
  await start();
  if (process.argv.includes('--edge')) {
    await login();
    await test('失败提示：隐藏技术细节、跨入口去重、统一样式与关闭重试', async () => {
      await page.evaluate(() => {
        const message = document.querySelector('#app').__vue_app__.config.globalProperties.$message;
        for (let i = 0; i < 8; i++) message.error(new Error('Error invoking remote method \'restore-instance\': Error: ENOENT C:\\Users\\test\\private.json\n at launch (index.js:4)'));
      });
      const toast = page.locator('.el-message--error');
      await toast.waitFor();
      assert.equal(await toast.count(), 1);
      assert.equal(await toast.locator('.el-message__content').innerText(), '操作失败，请稍后重试');
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('update-error', { message: '后台更新失败：https://example.invalid/private' });
      });
      assert.equal(await toast.count(), 1, '后台检查不能再弹出或替换当前错误');
      assert.equal(await toast.locator('.el-message__content').innerText(), '操作失败，请稍后重试');
      assert.match(await toast.getAttribute('class'), /app-error-message/);
      assert.equal(await toast.evaluate(node => getComputedStyle(node).pointerEvents), 'none');
      await page.screenshot({ path: path.join(evidence, 'error-feedback.png') });
      await toast.locator('.el-message__closeBtn').click();
      await absent(toast);
      await page.evaluate(() => {
        const message = document.querySelector('#app').__vue_app__.config.globalProperties.$message;
        message({ type: 'error', message: 'Network Error', dangerouslyUseHTMLString: true });
        message.error(new Error('ECONNRESET'));
      });
      await toast.waitFor();
      assert.equal(await toast.count(), 1);
      assert.equal(await toast.locator('.el-message__content').innerText(), '连接失败，请检查网络后重试');
      await toast.locator('.el-message__closeBtn').click();
      await absent(toast);
    }, 'real-packaged-renderer; controlled-errors');
    await test('邮箱注册：未配置服务时禁用入口', async () => {
      await nav('账号');
      assert.equal(await button('注册邮箱').isDisabled(), true);
    });
    await test(
      '邮箱注册：单独/批量、数量边界、复制结果、部分未保存、错误重试',
      async () => {
        const configRoute = async route => {
          const response = await route.fetch();
          const payload = await response.json();
          payload.data.mailDomain = 'example.test';
          payload.data.isMailboxRegistrationConfigured = true;
          await route.fulfill({ response, json: payload });
        };
        await page.route('**/users/system_config', configRoute);
        await page.reload();
        await nav('账号');
        let submitted,
          fail = false;
        const registrationRoute = route => {
          submitted = route.request().postDataJSON();
          const data = submitted.count
            ? [
                { email: 'test-batch-1@example.test', password: 'test-pass', saved: true },
                {
                  email: 'test-batch-2@example.test',
                  password: 'test-pass-2',
                  saved: false,
                  message: 'test-保存失败',
                },
              ]
            : [{ email: 'test-single@example.test', password: 'test-pass', saved: true }];
          return route.fulfill({
            json: fail ? { code: 500, message: 'test-注册服务失败' } : { code: 0, data },
          });
        };
        await page.route('**/emails/create_mailbox', registrationRoute);
        await button('注册邮箱').click();
        const d = dialog('注册邮箱');
        await button('注册', d).click();
        await seen('请输入邮箱前缀');
        await d.getByPlaceholder('请输入邮箱前缀').fill('test-single');
        await button('注册', d).click();
        await absent(d);
        const result = dialog('邮箱注册结果');
        await result.waitFor();
        assert.equal(submitted.localPart, 'test-single');
        await button('复制全部', result).click();
        await seen('已复制到剪贴板');
        assert.equal(
          await app.evaluate(({ clipboard }) => clipboard.readText()),
          'test-single@example.test----test-pass'
        );
        await button('关闭', result).click();
        await absent(result);
        await button('注册邮箱').click();
        await d.getByText('批量注册', { exact: true }).click();
        const quantity = d.getByRole('spinbutton');
        await quantity.fill('0');
        await quantity.blur();
        assert.equal(await quantity.inputValue(), '1');
        await quantity.fill('11');
        await quantity.blur();
        assert.equal(await quantity.inputValue(), '10');
        await quantity.fill('2');
        await quantity.blur();
        await button('注册', d).click();
        await absent(d);
        await result.waitFor();
        assert.equal(submitted.count, 2);
        await seen('部分邮箱未保存到账号列表', result);
        await seen('待手动添加', result);
        await button('关闭', result).click();
        await absent(result);
        fail = true;
        await button('注册邮箱').click();
        await quantity.fill('2');
        await quantity.blur();
        await button('注册', d).click();
        await seen('test-注册服务失败');
        assert.equal(await d.isVisible(), true);
        fail = false;
        await button('注册', d).click();
        await result.waitFor();
        await button('关闭', result).click();
        await absent(result);
        await page.unroute('**/emails/create_mailbox', registrationRoute);
        await page.unroute('**/users/system_config', configRoute);
        await page.reload();
      },
      'controlled-registration-api; no-external-mailbox-created'
    );
    await test('额度：10个免费账号、批量超额拒绝、删除不返还、重复更新不扣次数', async () => {
      await nav('账号');
      await button('快速添加').click();
      const d = dialog('快速添加账号');
      const content = Array.from(
        { length: 10 },
        (_, i) => `test-quota-${run}-${i}@example.test----test-pass`
      );
      await d.getByRole('textbox', { name: '账号列表', exact: true }).fill(content.join('\n'));
      await button('确定', d).click();
      await absent(d);
      assert.equal((await api('/emails/search', { current: 1, pageSize: 200 })).count, 10);
      await button('快速添加').click();
      await d
        .getByRole('textbox', { name: '账号列表', exact: true })
        .fill(`test-excess-${run}@example.test----test-pass`);
      await button('确定', d).click();
      await seen('计费');
      assert.equal(await d.isVisible(), true);
      await button('取消', d).click();
      await absent(d);
      await button('添加账号').click();
      const add = dialog('添加账号');
      await add.waitFor();
      assert.equal(await button('确定', add).isDisabled(), true);
      await button('取消', add).click();
      await absent(add);
      await button('快速添加').click();
      await d.getByRole('textbox', { name: '账号列表', exact: true }).fill(content[0]);
      await button('确定', d).click();
      await absent(d);
      assert.equal((await api('/emails/search', { current: 1, pageSize: 200 })).count, 10);
      await button('删除', row(`test-quota-${run}-0@`)).click();
      await confirm('确定');
      await absent(row(`test-quota-${run}-0@`));
      await button('添加账号').click();
      await add.waitFor();
      assert.equal(await button('确定', add).isDisabled(), true);
      await button('取消', add).click();
      await absent(add);
    });
    await test(
      '分页：数量切换、翻页、跳页、最后一页删除回退',
      async () => {
        // Seed harmless list-only rows to exercise >10 records without changing global prices.
        const values = Array.from(
          { length: 12 },
          (_, i) =>
            `('${run}-page-${i}', 'test-page-${i}', 'test-page-${run}-${i}@example.test', @owner, UNIX_TIMESTAMP(), 0)`
        ).join(',');
        const query = `SET @owner=(SELECT id FROM t_user WHERE user='${username}'); INSERT INTO t_apikey(uuid,api_name,email,uid,creatTime,del) VALUES ${values};`;
        const seeded = process.env.FINGER_TEST_FIXTURE_SERVICE
          ? {
              status: (
                await fetch(process.env.FINGER_TEST_FIXTURE_SERVICE + '/seed-pagination', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ username, run }),
                }).then(r => r.json())
              ).success
                ? 0
                : 1,
            }
          : spawnSync(
              'docker',
              [
                'exec',
                '-e',
                'MYSQL_PWD=test-local-mysql-20261012',
                'test-finger-mysql-20261012',
                'mysql',
                '-uroot',
                'test_finger_acceptance_20261012',
                '-e',
                query,
              ],
              { encoding: 'utf8' }
            );
        assert.equal(seeded.status, 0);
        await button('搜索').click();
        await seen('共 21 条');
        await page.locator('.el-pagination__sizes').getByRole('combobox').press('Enter');
        await page.getByRole('option', { name: '10条/页', exact: true }).click();
        await page.waitForFunction(
          () => document.querySelectorAll('.el-table__body tr').length === 10
        );
        await button('下一页').click();
        await page.locator('.el-pager .is-active').filter({ hasText: '2' }).waitFor();
        const jump = page.getByRole('spinbutton', { name: '页', exact: true });
        await jump.fill('3');
        await jump.press('Enter');
        await page.locator('.el-pager .is-active').filter({ hasText: '3' }).waitFor();
        await page.waitForFunction(
          () => document.querySelectorAll('.el-table__body tr').length === 1
        );
        await page.locator('.el-table__body tr .el-checkbox').click();
        await button('批量删除').click();
        await confirm('确定');
        await page.locator('.el-pager .is-active').filter({ hasText: '2' }).waitFor();
        await button('上一页').click();
        await page.locator('.el-pager .is-active').filter({ hasText: '1' }).waitFor();
      },
      'real-ui-api; list-fixtures-directly-seeded'
    );
    await test(
      '自动更新：发现版本、进度边界、下载完成、安装失败、错误与监听清理',
      async () => {
        await nav('设置');
        await button('检查更新').waitFor();
        const push = (channel, payload) =>
          app.evaluate(
            ({ BrowserWindow }, { channel, payload }) =>
              BrowserWindow.getAllWindows()[0].webContents.send(channel, payload),
            { channel, payload }
          );
        await push('update-available', { version: '0.2.1' });
        await seen('发现新版本 0.2.1');
        assert.equal(await button('检查更新').isDisabled(), true);
        await push('download-progress', { percent: 145 });
        await seen('100%');
        await push('update-downloaded', { version: '0.2.1' });
        await seen('已下载，可以重启安装');
        await confirm('稍后再说');
        await app.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler('install-update');
          ipcMain.handle('install-update', async () => {
            throw new Error('test-安装失败');
          });
        });
        await button('立即重启并安装更新').click();
        await seen('安装失败');
        await push('update-error', { message: 'test-下载中断' });
        await seen('test-下载中断');
        assert.equal(await button('检查更新').isDisabled(), false);
        await nav('浏览器');
        await nav('设置');
        await push('update-not-available', { version: '0.2.0' });
        await seen('当前已是最新版本');
        assert.equal(await page.getByText('当前已是最新版本', { exact: true }).count(), 1);
      },
      'controlled-update-ipc; no-real-update-installation'
    );
    await test(
      '全局更新提示：安装失败应被捕获并向用户说明',
      async () => {
        await app.evaluate(({ ipcMain, BrowserWindow }) => {
          ipcMain.removeHandler('install-update');
          ipcMain.handle('install-update', async () => {
            throw new Error('test-global-install-failed');
          });
          BrowserWindow.getAllWindows()[0].webContents.send('update-downloaded', {
            version: '0.2.1',
          });
        });
        const rejected = page.waitForEvent('pageerror', { timeout: 5000 }).catch(() => null);
        await confirm('重启安装');
        await seen('安装更新失败，请稍后重试');
        const error = await rejected;
        assert.equal(error, null, `全局安装入口出现未捕获错误: ${error?.message}`);
      },
      'controlled-install-failure; no-real-update-installation'
    );
    await test('补充操作没有未捕获渲染异常', async () => assert.deepEqual(rendererErrors, []));
  } else {
    if (process.argv.includes('--browser')) {
      await page.locator('.remember-checkbox').click();
      await login();
      await api('/groups/create', { name: names.browserGroup });
      await api('/email_groups/create', { name: names.accountGroup });
      const group = (await api('/email_groups/search', {})).find(
        item => item.name === names.accountGroup
      );
      const prepared = await page.evaluate(
        async data =>
          window.ipcRenderer.prepareEmailForImport(data, {
            isGoAuthCloud: true,
            cloudRecoveryVersion: 1,
            cloudRecoveryCapabilityKnown: true,
          }),
        {
          apiName: names.account,
          email: `test-${run}@example.test`,
          mailPassword: 'test-mail-pass',
          bianPassword: 'test-account-pass',
          googleAuth: 'JBSWY3DPEHPK3PXP',
          groupId: group.id,
        }
      );
      await api('/emails/create', prepared);
      account = (await api('/emails/search', { current: 1, pageSize: 200 })).apikeyList[0];
    } else {
      await test('未登录访问业务路由会回到登录页', async () => {
        await page.evaluate(() => {
          location.hash = '#/billing';
        });
        await page.waitForURL(url => url.hash.startsWith('#/login'));
        await button('登录').waitFor();
      });
      await test('登录空表单与长度边界', async () => {
        await button('登录').click();
        await seen('请输入用户名');
        await seen('请输入密码');
        await page.getByPlaceholder('请输入用户名').fill('ab');
        await page.getByPlaceholder('请输入密码').fill('123');
        await button('登录').click();
        await seen('用户名长度在 3 到 100 个字符');
        await seen('密码长度在 6 到 50 个字符');
      });
      await test('错误密码保持登录页且可重试', async () => {
        await page.getByPlaceholder('请输入用户名').fill(username);
        await page.getByPlaceholder('请输入密码').fill('wrong-password');
        await button('登录').click();
        await page.locator('.el-message--error').waitFor();
        await button('登录').waitFor({ state: 'visible' });
        assert.ok(page.url().includes('/login'));
      });
      await test('记住密码、回车登录与长用户名', async () => {
        await page.locator('.remember-checkbox').click();
        await page.getByPlaceholder('请输入密码').fill(password);
        await page.getByPlaceholder('请输入密码').press('Enter');
        await page
          .getByRole('menuitem', { name: '浏览器', exact: true })
          .waitFor({ timeout: 20000 });
        assert.ok(page.url().includes('/billing'), 'login should honor the saved redirect');
        await nav('浏览器');
        token = await page.evaluate(() => localStorage.getItem('token'));
        assert.ok(token);
        assert.ok(username.length > 20);
        assert.equal(await page.evaluate(() => localStorage.getItem('password')), null);
      });

      for (const [tab, type, key] of [
        ['浏览器分组', '浏览器', 'browserGroup'],
        ['账号分组', '账号', 'accountGroup'],
      ]) {
        await test(`${tab}：空名称拒绝、创建、搜索、编辑、取消删除、详情跳转`, async () => {
          await nav('分组');
          await page.getByRole('tab', { name: tab, exact: true }).click();
          await button('新建').click();
          const d = dialog(`新建${type}分组`);
          await button('创建', d).click();
          await seen('请输入分组名称');
          await d.getByRole('textbox').fill(names[key]);
          await button('创建', d).click();
          await absent(d);
          await row(names[key]).waitFor();
          await row(names[key]).getByRole('button', { name: '编辑', exact: true }).click();
          const edit = dialog(`编辑${type}分组`);
          await edit.getByRole('textbox').fill(names[key] + '-改');
          await button('保存', edit).click();
          await absent(edit);
          names[key] += '-改';
          await row(names[key]).waitFor();
          await page.getByPlaceholder('搜索关键字').fill('no-such-group');
          await button('搜索').click();
          await absent(row(names[key]));
          await page.getByPlaceholder('搜索关键字').fill(names[key]);
          await page.getByPlaceholder('搜索关键字').press('Enter');
          await row(names[key]).waitFor();
          await button('删除', row(names[key])).click();
          await confirm('取消');
          await row(names[key]).waitFor();
          await button('详情', row(names[key])).click();
          await (key === 'browserGroup' ? button('创建新窗口') : button('添加账号')).waitFor();
          assert.match(page.url(), /group_id=\d+/);
        });
      }

      await nav('浏览器');
      await nav('账号');
      await test('账号：空/非法邮箱、缺密码拒绝、取消与重开表单', async () => {
        await button('添加账号').click();
        const d = dialog('添加账号');
        await button('确定', d).click();
        await seen('请输入有效的邮箱地址');
        await d.getByRole('textbox', { name: '邮箱地址', exact: true }).fill('bad-address');
        await button('确定', d).click();
        await seen('请输入有效的邮箱地址');
        await d
          .getByRole('textbox', { name: '邮箱地址', exact: true })
          .fill(`test-${run}@example.test`);
        await button('确定', d).click();
        await seen('请输入邮箱密码或授权码');
        await button('取消', d).click();
        await absent(d);
        await button('添加账号').click();
        assert.equal(
          await d.getByRole('textbox', { name: '邮箱地址', exact: true }).inputValue(),
          ''
        );
        await button('取消', d).click();
        await absent(d);
      });
      await test('账号：创建全部资料和云端谷歌密钥，列表不暴露密码', async () => {
        await button('添加账号').click();
        const d = dialog('添加账号');
        for (const [name, value] of [
          ['账号名称', names.account],
          ['邮箱地址', `test-${run}@example.test`],
          ['邮箱密码', 'test-mail-pass'],
          ['账号密码', 'test-account-pass'],
          ['谷歌验证密钥', 'JBSWY3DPEHPK3PXP'],
        ])
          await d.getByRole('textbox', { name, exact: true }).fill(value);
        await select(d, '分组', names.accountGroup);
        await button('确定', d).click();
        await absent(d);
        await row(names.account).waitFor();
        account = (await api('/emails/search', { current: 1, pageSize: 200 })).apikeyList.find(
          x => x.apiName === names.account
        );
        assert.ok(account?.uuid);
        assert.equal(account.mailPassword, undefined);
        const text = await row(names.account).innerText();
        assert.ok(!text.includes('test-mail-pass'));
        assert.ok(text.includes('2FA'));
      });
      await test('账号：编辑全部字段、保留谷歌密钥、备注双击保存', async () => {
        await button('编辑', row(names.account)).click();
        const d = dialog('编辑账号');
        assert.equal(await d.getByPlaceholder('邮箱密码或授权码').inputValue(), 'test-mail-pass');
        await d.getByRole('textbox', { name: '备注', exact: true }).fill('test-编辑备注');
        await button('保存', d).click();
        await absent(d);
        await seen('test-编辑备注', row(names.account));
        await row(names.account).locator('[title="双击编辑备注"]').dblclick();
        await row(names.account).getByRole('textbox').fill('test-双击备注');
        const remarkSaved = page.waitForResponse(
          r => r.url().endsWith('/emails/update_field') && r.request().method() === 'POST'
        );
        await row(names.account).getByRole('textbox').press('Enter');
        await remarkSaved;
        await seen('test-双击备注', row(names.account));
        const detail = await api('/emails/detail', { uuid: account.uuid });
        assert.equal(detail.beizhu, 'test-双击备注');
        assert.equal(
          (await api('/emails/google_auth_migration_status', { uuid: account.uuid }))
            .googleAuthStatus,
          'ready'
        );
      });
      await test('账号：谷歌码显示、刷新、复制、关闭', async () => {
        await button('谷歌码', row(names.account)).click();
        const d = page.getByRole('dialog');
        await d.locator('.code-result__value').waitFor();
        assert.match(await d.locator('.code-result__value').innerText(), /^\d{6}$/);
        await button('刷新', d).click();
        await d.locator('.code-result__value').waitFor();
        await button('复制验证码', d).click();
        await seen('验证码已复制到剪贴板');
        assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /^\d{6}$/);
        await button('关闭', d).click();
        await absent(d);
      });
      await test('账号：名称/邮箱搜索与空结果恢复', async () => {
        const search = page.getByPlaceholder('账号名称或邮箱地址');
        await search.fill('no-such-account');
        await button('搜索').click();
        await absent(row(names.account));
        await search.fill(account.email);
        await search.press('Enter');
        await row(names.account).waitFor();
        await search.fill('');
        await button('搜索').click();
        await row(names.account).waitFor();
      });
      await test('快速添加：空、坏行、重复去重、已有账号更新', async () => {
        await button('快速添加').click();
        const d = dialog('快速添加账号');
        const input = d.getByRole('textbox', { name: '账号列表', exact: true });
        await button('确定', d).click();
        await seen('请输入账号列表');
        await input.fill('bad-email----pass');
        await button('确定', d).click();
        await seen('第 1 行');
        const line = `test-fast-${run}@example.test----test-pass--------test-account----test-fast-${run}`;
        await input.fill(line + '\n' + line);
        await button('确定', d).click();
        await absent(d);
        await row(`test-fast-${run}`).waitFor();
        const list = await api('/emails/search', { current: 1, pageSize: 200 });
        assert.equal(
          list.apikeyList.filter(x => x.email === `test-fast-${run}@example.test`).length,
          1
        );
        await button('快速添加').click();
        await input.fill(line);
        await button('确定', d).click();
        await absent(d);
        assert.equal((await api('/emails/search', { current: 1, pageSize: 200 })).count, 2);
      });
      await test(
        '导入导出：真实模板文件、有效/重复/坏文件、取消文件选择',
        async () => {
          const template = path.join(evidence, 'test-template.xlsx');
          await app.evaluate(({ dialog }, filePath) => {
            dialog.showSaveDialog = async () => ({ canceled: false, filePath });
          }, template);
          await button('模板下载').click();
          await seen('模板下载成功');
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.readFile(template);
          assert.equal(workbook.worksheets.length, 2);
          assert.equal(workbook.getWorksheet(1).getCell('C1').text, '邮箱地址');
          workbook
            .getWorksheet(1)
            .addRow([
              1,
              names.accountGroup,
              `test-import-${run}@example.test`,
              'test-import-pass',
              'test-site-pass',
              `test-import-${run}`,
              '',
              '',
              0,
              0,
              'JBSWY3DPEHPK3PXP',
            ]);
          const file = path.join(evidence, 'test-import.xlsx');
          await workbook.xlsx.writeFile(file);
          await app.evaluate(({ dialog }, file) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
          }, file);
          await button('导入').click();
          await row(`test-import-${run}`).waitFor();
          await button('导入').click();
          await seen('更新 1 条');
          assert.equal((await api('/emails/search', { current: 1, pageSize: 200 })).count, 3);
          const bad = path.join(evidence, 'test-bad.xlsx');
          await fs.writeFile(bad, 'bad workbook');
          await app.evaluate(({ dialog }, file) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
          }, bad);
          await button('导入').click();
          await page.locator('.el-message--error').waitFor();
          await app.evaluate(({ dialog }) => {
            dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
            dialog.showSaveDialog = async () => ({ canceled: true });
          });
          await page.mouse.move(8, 600);
          await page.waitForFunction(() => !document.querySelector('.el-message'));
          await button('导入').click();
          await button('模板下载').click();
          await row(names.account).waitFor();
        },
        'real-ui-api-files; native-dialog-selection-controlled'
      );

      await test(
        '账号：邮件展示/刷新、HTML隔离、验证码、实名状态与失败重试',
        async () => {
          await app.evaluate(({ ipcMain }) => {
            const replace = (channel, fn) => {
              ipcMain.removeHandler(channel);
              ipcMain.handle(channel, fn);
            };
            const mail = [
              {
                subject: 'test-Binance验证码',
                boxName: 'INBOX',
                emailTime: new Date().toISOString(),
                bodyPath: 'test-mail.data',
              },
            ];
            replace('email:fetch-imap', async () => mail);
            replace('email:list-local-cache', async () => mail);
            replace(
              'email:read-local-body',
              async () =>
                '<p>test-邮件正文 验证码 021019</p><script>parent.__mailScriptRan=true</script>'
            );
            replace('email:extract-code', async () => ({
              success: true,
              code: '021019',
              subject: 'test-Binance验证码',
              emailTime: new Date().toISOString(),
            }));
            replace('email:scan-auth-status', async () => ({ authState: 1 }));
          });
          await button('查看邮件', row(names.account)).click();
          const d = dialog('邮件详情');
          await d.locator('.email-item').first().waitFor();
          await d.locator('.email-item').first().click();
          await fs.writeFile(
            path.join(evidence, 'mail-layout.json'),
            JSON.stringify(
              await d.locator('iframe').evaluate(el => ({
                iframe: el.getBoundingClientRect().toJSON(),
                style: getComputedStyle(el).cssText,
                parent: el.parentElement.getBoundingClientRect().toJSON(),
              })),
              null,
              2
            )
          );
          await d.frameLocator('iframe').getByText('test-邮件正文 验证码 021019').waitFor();
          assert.equal(await d.locator('iframe').getAttribute('sandbox'), '');
          assert.equal(await page.evaluate(() => globalThis.__mailScriptRan), undefined);
          await button('加载外部图片', d).click();
          await seen('已允许外部图片', d);
          await button('刷新', d).click();
          await d.locator('.el-dialog__headerbtn').click();
          await absent(d);
          await button('验证码', row(names.account)).click();
          const code = page.getByRole('dialog');
          await code.locator('.code-result__value').waitFor();
          assert.equal(await code.locator('.code-result__value').innerText(), '021019');
          await button('关闭', code).click();
          await absent(code);
          await button('实名', row(names.account)).click();
          await page.locator('.el-message').last().waitFor();
          await app.evaluate(({ ipcMain }) => {
            ipcMain.removeHandler('email:extract-code');
            ipcMain.handle('email:extract-code', async () => {
              throw new Error('test-邮件网络失败');
            });
          });
          await button('验证码', row(names.account)).click();
          await seen('test-邮件网络失败');
          await closeDialogs();
        },
        'ui-with-controlled-mail-ipc; protocol-tested-separately'
      );

      await test('账号：单条修改分组、取消不保存、移回未分组', async () => {
        await button(names.accountGroup, row(names.account)).click();
        const d = dialog('选择分组');
        const clearGroup = async () => {
          await d.locator('.el-select').hover();
          await d.locator('.el-select__clear').click();
        };
        await clearGroup();
        await button('取消', d).click();
        await absent(d);
        await button(names.accountGroup, row(names.account)).click();
        await clearGroup();
        const updated = page.waitForResponse(r => r.url().endsWith('/emails/update_group'));
        await button('确定', d).click();
        assert.equal(
          (await (await updated).json()).code,
          0,
          'Clearing group must submit groupId=0'
        );
        await absent(d);
        await button('未分组', row(names.account)).waitFor();
        await button('未分组', row(names.account)).click();
        await select(d, '', names.accountGroup);
        await button('确定', d).click();
        await absent(d);
        await button(names.accountGroup, row(names.account)).waitFor();
      });
      await test('谷歌密钥：缺失提示、旧本机密钥迁移取消/确认及云端保护', async () => {
        const r = row(`test-fast-${run}`);
        const fast = (await api('/emails/search', { current: 1, pageSize: 200 })).apikeyList.find(
          x => x.email === `test-fast-${run}@example.test`
        );
        await button('谷歌码', r).click();
        const code = dialog('谷歌验证码');
        await seen('该账号未设置谷歌验证密钥', code);
        await button('关闭', code).click();
        await absent(code);
        await page.evaluate(
          a => window.ipcRenderer.commitLocalAuthSecret({ ...a, secret: 'JBSWY3DPEHPK3PXP' }),
          { uuid: fast.uuid, email: fast.email }
        );
        await button('编辑', r).click();
        const edit = dialog('编辑账号');
        await button('迁移旧密钥或重新录入', edit).click();
        const d = dialog('恢复谷歌验证密钥');
        await button('取消', d).click();
        await absent(d);
        assert.equal(
          (await api('/emails/google_auth_migration_status', { uuid: fast.uuid })).googleAuthStatus,
          'not_configured'
        );
        await button('迁移旧密钥或重新录入', edit).click();
        await button('确认保存并验证', d).click();
        await absent(d);
        assert.equal(
          (await api('/emails/google_auth_migration_status', { uuid: fast.uuid })).googleAuthStatus,
          'ready'
        );
        assert.match((await api('/emails/google_auth_code', { uuid: fast.uuid })).code, /^\d{6}$/);
        await button('取消', edit).click();
        await absent(edit);
      });

      await test('账号：删除取消、单条删除、未选择批删、批删确认', async () => {
        await button('删除', row(`test-fast-${run}`)).click();
        await confirm('取消');
        await row(`test-fast-${run}`).waitFor();
        await button('删除', row(`test-fast-${run}`)).click();
        await confirm('确定');
        await absent(row(`test-fast-${run}`));
        await button('批量删除').click();
        await seen('请选择至少一个账号');
        await row(`test-import-${run}`).locator('.el-checkbox').click();
        await button('批量删除').click();
        await confirm('取消');
        await button('批量删除').click();
        await confirm('确定');
        await absent(row(`test-import-${run}`));
        assert.equal((await api('/emails/search', { current: 1, pageSize: 200 })).count, 1);
      });
    }
    await nav('浏览器');
    await test('浏览器：未选择批量分组/删除、空表单、取消', async () => {
      await button('批量分组').click();
      await seen('请选择至少一个窗口进行编辑');
      await button('批量删除').click();
      await seen('请选择至少一个窗口进行删除');
      await button('创建新窗口').click();
      const d = dialog('创建新窗口');
      await button('创建窗口', d).click();
      await seen('请输入窗口名称', d);
      assert.match(
        await d
          .getByRole('combobox', { name: formLabel('浏览器版本') })
          .evaluate(el => el.closest('.el-select').innerText),
        /144\.0\.7500/
      );
      await button('取消', d).click();
      await absent(d);
    });
    await test('浏览器：非法URL、Cookie JSON、代理格式阻止提交', async () => {
      await button('创建新窗口').click();
      const d = dialog('创建新窗口');
      await d.getByRole('textbox', { name: /名称/ }).fill(names.browser);
      await select(d, '浏览器版本', '140.0.7259');
      await d.getByRole('textbox', { name: '初始 URL', exact: true }).fill('javascript:alert(1)');
      await d.getByRole('textbox', { name: 'Cookie', exact: true }).fill('{}');
      await button('创建窗口', d).click();
      await seen('仅支持 HTTP 或 HTTPS 地址', d);
      await seen('Cookie 必须是 JSON 数组', d);
      await d.getByRole('textbox', { name: 'Cookie', exact: true }).fill('[');
      await button('创建窗口', d).click();
      await seen('Cookie JSON 格式不正确', d);
      await d.getByRole('textbox', { name: '初始 URL', exact: true }).fill(site);
      await d.getByRole('textbox', { name: 'Cookie', exact: true }).fill('[]');
      await d.getByRole('button', { name: /代理设置/ }).click();
      await d
        .locator('.el-form-item')
        .filter({ hasText: '代理状态' })
        .locator('.el-switch')
        .click();
      await d.getByRole('textbox', { name: '代理信息', exact: true }).fill('localhost:99999');
      await button('创建窗口', d).click();
      await seen('格式填写有效代理', d);
      await select(d, '代理配置方式', '通过URL获取');
      await d.getByRole('textbox', { name: 'API 链接', exact: true }).fill('ftp://invalid');
      await button('创建窗口', d).click();
      await seen('仅支持 HTTP 或 HTTPS 地址', d);
      await button('取消', d).click();
      await absent(d);
    });
    await test('浏览器：创建、关联账号、分组、初始Cookie、全部指纹表单', async () => {
      await button('创建新窗口').click();
      const d = dialog('创建新窗口');
      await d.getByRole('textbox', { name: /名称/ }).fill(names.browser);
      await select(d, '浏览器版本', '140.0.7259');
      await d.getByRole('combobox', { name: '关联账号', exact: true }).press('Enter');
      await page.getByRole('option').filter({ hasText: names.account }).click();
      await select(d, '分组', names.browserGroup);
      await d.getByRole('textbox', { name: '初始 URL', exact: true }).fill(site);
      await d
        .getByRole('textbox', { name: 'Cookie', exact: true })
        .fill(JSON.stringify([{ name: 'test-initial-cookie', value: 'test-value', url: site }]));
      await d.getByRole('textbox', { name: '备注', exact: true }).fill('test-窗口备注');
      await button('重新生成 User-Agent', d).click();
      assert.ok(
        (await d.getByRole('textbox', { name: formLabel('User-Agent') }).inputValue()).includes(
          'Chrome/140'
        )
      );
      await d.getByRole('button', { name: /高级指纹设置/ }).click();
      await d
        .locator('.el-form-item')
        .filter({ hasText: '自动指纹' })
        .locator('.el-switch')
        .click();
      const choices = [
        ['时区', '新加坡'],
        ['语言', '英语 (美国)'],
        ['屏幕分辨率', '1366×768'],
        ['CPU核心数', '4 核'],
        ['设备内存', '8 GB'],
      ];
      // Use the actual option text, whose labels can be localized independently of values.
      for (const [name] of choices) {
        const combo = d.getByRole('combobox', { name, exact: true });
        await combo.press('Enter');
        const options = page
          .locator(`[id="${await combo.getAttribute('aria-controls')}"]`)
          .getByRole('option');
        const match = {
          时区: /Singapore|新加坡/,
          语言: /en-US|美国/,
          屏幕分辨率: /1366.*768/,
          CPU核心数: /^4/,
          设备内存: /^8/,
        }[name];
        await options.filter({ hasText: match }).last().click();
      }
      for (const name of ['WebRTC', '字体指纹', '插件指纹', 'Battery API', '媒体设备']) {
        const combo = d.getByRole('combobox', { name, exact: true });
        await combo.press('Enter');
        await page
          .locator(`[id="${await combo.getAttribute('aria-controls')}"]`)
          .getByRole('option')
          .first()
          .click();
      }
      await d.getByRole('textbox', { name: 'WebGL Vendor', exact: true }).fill('test-vendor');
      await d.getByRole('textbox', { name: 'WebGL Renderer', exact: true }).fill('test-renderer');
      await button('创建窗口', d).click();
      await absent(d);
      await row(names.browser).waitFor();
      browser = (await api('/browsers/search', { page: 1, size: 200 })).list.find(
        x => x.name === names.browser
      );
      assert.ok(browser?.browser_id);
      const config = JSON.parse(browser.config);
      assert.equal(config.finger.hardwareConcurrency, 4);
      assert.equal(config.finger.deviceMemory, 8);
      assert.equal(config.finger.autoFingerprint, false);
      assert.equal(browser.email_uuid, account.uuid);
    });
    await test('浏览器：编辑、备注双击、克隆取消、克隆创建', async () => {
      await row(names.browser).getByText('test-窗口备注', { exact: true }).dblclick();
      const edit = dialog('编辑窗口');
      await edit.getByRole('textbox', { name: '备注', exact: true }).fill('test-编辑后的窗口备注');
      await button('保存修改', edit).click();
      await absent(edit);
      await seen('test-编辑后的窗口备注', row(names.browser));
      await button('克隆', row(names.browser)).click();
      const clone = dialog('克隆窗口');
      await button('取消', clone).click();
      await absent(clone);
      await button('克隆', row(names.browser)).click();
      await clone.getByRole('textbox', { name: /名称/ }).fill(names.browser + '-副本');
      await button('创建副本', clone).click();
      await absent(clone);
      await row(names.browser + '-副本').waitFor();
      assert.equal((await api('/browsers/search', { page: 1, size: 200 })).total, 2);
    });
    await test('浏览器：名称搜索、批量分组、单条移回未分组', async () => {
      await page.getByPlaceholder('窗口名称').fill('no-such-browser');
      await button('搜索').click();
      await absent(row(names.browser));
      await page.getByPlaceholder('窗口名称').fill('');
      await page.getByPlaceholder('窗口名称').press('Enter');
      await row(names.browser).first().waitFor();
      await page.locator('.el-table__header .el-checkbox').click();
      await button('批量分组').click();
      const d = dialog('选择分组');
      await select(d, '', '未分组');
      await button('确定', d).click();
      await absent(d);
      assert.ok(
        (await api('/browsers/search', { page: 1, size: 200 })).list.every(
          x => Number(x.group_id) === 0
        )
      );
      await button('未分组', row(names.browser).filter({ hasNotText: '副本' })).click();
      await select(dialog('选择分组'), '', names.browserGroup);
      await button('确定', dialog('选择分组')).click();
      await absent(dialog('选择分组'));
    });

    await test(
      '真实内核：打开、重复点击、指纹和Cookie、重开、关闭恢复',
      async () => {
        assert.ok(browser, 'create workflow must pass before runtime');
        await fs.mkdir(path.join(appData, 'browser'), { recursive: true });
        await fs.cp(
          path.join(
            process.env.FINGER_TEST_KERNEL_ROOT ||
              path.join(os.homedir(), 'Library/Application Support/finger-browser/browser'),
            '140.0.7259'
          ),
          path.join(appData, 'browser/140.0.7259'),
          { recursive: true }
        );
        await app.evaluate(({ app }) => {
          const load = process
            .getBuiltinModule('module')
            .createRequire(app.getAppPath() + '/package.json');
          const { chromium } = load('playwright');
          const original = chromium.launchPersistentContext.bind(chromium);
          globalThis.__testContexts = new Map();
          chromium.launchPersistentContext = async (dir, options) => {
            const context = await original(dir, {
              ...options,
              headless: true,
              args: [...(options.args || []), '--disable-background-networking'],
            });
            await context.route('**/*', route => {
              const url = new URL(route.request().url());
              return ['127.0.0.1', 'localhost'].includes(url.hostname)
                ? route.continue()
                : route.abort();
            });
            globalThis.__testContexts.set(dir, context);
            return context;
          };
        });
        const r = row(names.browser).filter({ hasNotText: '副本' });
        await button('打开', r).dblclick();
        await seen('运行中', r, 30000);
        const values = await app.evaluate(async (_, id) => {
          const context = [...globalThis.__testContexts].findLast(([dir]) => dir.endsWith(id))[1];
          const p = context.pages().find(p => p.url().startsWith('http:'));
          await p.waitForLoadState('networkidle');
          await p.evaluate(() => {
            localStorage.setItem('test-full', 'persisted');
            sessionStorage.setItem('test-session', 'persisted');
          });
          return {
            cookies: await context.cookies(),
            fingerprint: await p.evaluate(() => ({
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              language: navigator.language,
              cpu: navigator.hardwareConcurrency,
              memory: navigator.deviceMemory,
              width: screen.width,
            })),
          };
        }, browser.browser_id);
        assert.ok(values.cookies.some(x => x.name === 'test-initial-cookie'));
        assert.equal(values.fingerprint.cpu, 4);
        assert.equal(values.fingerprint.memory, 8);
        assert.equal(values.fingerprint.width, 1366);
        await button('重开', r).click();
        await seen('运行中', r, 30000);
        await page.waitForFunction(
          name => {
            const row = [...document.querySelectorAll('.el-table__body tr')].find(
              r => r.innerText.includes(name) && !r.innerText.includes('副本')
            );
            return (
              row &&
              [...row.querySelectorAll('button')].some(
                b => b.innerText.trim() === '重开' && !b.disabled
              )
            );
          },
          names.browser,
          { timeout: 30000 }
        );
        await page.evaluate(id => window.ipcRenderer.removeInstance(id), browser.browser_id);
        await seen('已关闭', r);
        await page.waitForFunction(
          name => {
            const row = [...document.querySelectorAll('.el-table__body tr')].find(
              r => r.innerText.includes(name) && !r.innerText.includes('副本')
            );
            return (
              row &&
              [...row.querySelectorAll('button')].some(
                b => b.innerText.trim() === '打开' && !b.disabled
              )
            );
          },
          names.browser,
          { timeout: 30000 }
        );
        await button('打开', r).click();
        await seen('运行中', r, 30000);
        const restored = await app.evaluate(async (_, id) => {
          const c = [...globalThis.__testContexts].findLast(([dir]) => dir.endsWith(id))[1];
          const p = c.pages().find(p => p.url().startsWith('http:'));
          return p.evaluate(() => localStorage.getItem('test-full'));
        }, browser.browser_id);
        assert.equal(restored, 'persisted');
      },
      'real-ui-api-chromium-headless'
    );
    await test('浏览器：历史显示/搜索/清空取消与确认、凭据增改/删除', async () => {
      const r = row(names.browser).filter({ hasNotText: '副本' });
      const more = async name => {
        await button('更多', r).hover();
        await page.getByRole('menuitem', { name, exact: true }).click();
      };
      await more('浏览历史');
      const h = dialog('浏览历史');
      await h.getByText(site, { exact: true }).waitFor();
      await h.getByPlaceholder('搜索标题或 URL').fill('no-such-history');
      await seen('没有匹配的历史记录', h);
      await h.getByPlaceholder('搜索标题或 URL').fill('');
      await h.getByText(site, { exact: true }).waitFor();
      await button('清除全部历史', h).click();
      await confirm('取消');
      await h.getByText(site, { exact: true }).waitFor();
      await button('清除全部历史', h).click();
      await confirm('确定清除');
      await seen('暂无', h);
      await button('关闭', h).click();
      await absent(h);
      await page.evaluate(
        id => window.ipcRenderer.saveCredential(id, '127.0.0.1', 'test-web-user', 'test-web-pass'),
        browser.browser_id
      );
      await page.evaluate(
        id =>
          window.ipcRenderer.saveCredential(id, '127.0.0.1', 'test-web-user', 'test-updated-pass'),
        browser.browser_id
      );
      const saved = await page.evaluate(
        id => window.ipcRenderer.getSavedCredentials(id),
        browser.browser_id
      );
      assert.equal(saved.length, 1);
      await more('密码管理');
      const d = dialog('密码管理');
      await seen('test-web-user', d);
      assert.ok(!(await d.innerText()).includes('test-updated-pass'));
      await button('删除', d).click();
      await confirm('取消');
      await seen('test-web-user', d);
      await button('删除', d).click();
      await confirm('确定删除');
      await seen('暂无已保存的密码', d);
      await button('关闭', d).click();
      await absent(d);
    });
    await test(
      '浏览器：关联账号谷歌码与邮箱验证码快捷入口',
      async () => {
        const r = row(names.browser).filter({ hasNotText: '副本' });
        await button('更多', r).hover();
        await page.getByRole('menuitem', { name: '获取谷歌验证码', exact: true }).click();
        const d = page.getByRole('dialog');
        await d.locator('.code-dialog__code').waitFor();
        assert.match(await d.locator('.code-dialog__code').innerText(), /^\d{6}$/);
        await button('复制验证码', d).click();
        await button('关闭', d).click();
        await absent(d);
        await app.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler('email:extract-code');
          ipcMain.handle('email:extract-code', async () => ({
            success: true,
            code: '021019',
            subject: 'test-code',
          }));
        });
        await button('更多', r).hover();
        await page.getByRole('menuitem', { name: '读取邮箱验证码', exact: true }).click();
        await confirm('仅查看缓存');
        await d.locator('.code-dialog__code').waitFor();
        assert.equal(await d.locator('.code-dialog__code').innerText(), '021019');
        await button('关闭', d).click();
        await absent(d);
      },
      'real-cloud-totp; controlled-mail-ipc'
    );
    await test(
      '代理：真实失效HTTP代理和坏API返回阻止启动，修正后恢复',
      async () => {
        const r = row(names.browser).filter({ hasNotText: '副本' });
        await page.evaluate(id => window.ipcRenderer.removeInstance(id), browser.browser_id);
        await seen('已关闭', r);
        const editProxy = async (method, text, enabled = true) => {
          await button('编辑', r).click();
          const d = dialog('编辑窗口');
          await d.getByRole('button', { name: /代理设置/ }).click();
          const proxySwitch = d
            .locator('.el-form-item')
            .filter({ hasText: '代理状态' })
            .getByRole('switch');
          const enabledNow = await proxySwitch.getAttribute('aria-checked');
          if ((enabledNow === 'true') !== enabled)
            await d
              .locator('.el-form-item')
              .filter({ hasText: '代理状态' })
              .locator('.el-switch')
              .click();
          if (enabled) {
            await select(d, '代理配置方式', method);
            await d
              .getByRole('textbox', {
                name: method === '直接配置' ? '代理信息' : 'API 链接',
                exact: true,
              })
              .fill(text);
          }
          await button('保存修改', d).click();
          await absent(d);
        };
        await editProxy('直接配置', '127.0.0.1:9');
        await button('打开', r).click();
        await seen('代理连接失败');
        await seen('已关闭', r);
        assert.deepEqual(await page.evaluate(() => window.ipcRenderer.getAllInstances()), []);
        await editProxy('通过URL获取', site + 'test-proxy-api');
        await button('打开', r).click();
        await seen('代理连接失败');
        await seen('已关闭', r);
        assert.deepEqual(await page.evaluate(() => window.ipcRenderer.getAllInstances()), []);
        await editProxy('直接配置', '', false);
        await button('打开', r).click();
        await seen('运行中', r, 30000);
      },
      'real-ui-api-chromium; local-unreachable-proxy-and-local-bad-api'
    );

    await test('内核：本地列表、空间、刷新、依赖保护、在线搜索与刷新', async () => {
      await nav('内核');
      await row('140.0.7259').waitFor();
      assert.ok((await row('140.0.7259').innerText()).includes('使用中'));
      assert.equal(await button('使用中', row('140.0.7259')).isDisabled(), true);
      await button('刷新列表').click();
      await row('140.0.7259').waitFor();
      await button('添加内核').click();
      const d = dialog('可用内核版本');
      await d.getByText('144.0.7500', { exact: true }).waitFor();
      await d.getByPlaceholder('搜索版本号').fill('no-such-version');
      await seen('暂无可用内核版本', d);
      await d.getByPlaceholder('搜索版本号').fill('144');
      await d.getByText('144.0.7500', { exact: true }).waitFor();
      await button('刷新版本', d).click();
      await d.getByText('144.0.7500', { exact: true }).waitFor();
      await d.locator('.el-dialog__headerbtn').click();
      await absent(d);
    });
    await test(
      '内核：真实下载启动、取消与中间文件清理',
      async () => {
        await button('添加内核').click();
        const d = dialog('可用内核版本');
        const r = d.locator('.el-table__body tr').filter({ hasText: '144.0.7500' });
        await button('下载', r).click();
        await button('取消', r).waitFor({ timeout: 20000 });
        await button('取消', r).click();
        await confirm('确定');
        await button('下载', r).waitFor({ timeout: 20000 });
        assert.equal(await button('下载', r).isDisabled(), false);
        await d.locator('.el-dialog__headerbtn').click();
        await absent(d);
        const versions = await page.evaluate(() => window.ipcRenderer.getLocalBrowserVersions());
        assert.ok(!versions.some(x => x.version === '144.0.7500'));
      },
      'real-ui-public-kernel-download'
    );
    await test(
      testExecutable
        ? '设置：打包版真实更新检查结果、失败提示与重试'
        : '设置：检查更新开发环境提示与重复检查',
      async () => {
        await nav('设置');
        const observations = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          await button('检查更新').click();
          // Record an actual network failure separately from a successful feed
          // check. Both must settle and permit another check through the UI.
          const result = page
            .getByText(testExecutable ? /当前已是最新版本|检查更新失败|自动更新暂时不可用|连接超时|连接失败|发现新版本/ : /开发模式/)
            .first();
          await result.waitFor({ timeout: testExecutable ? 90000 : 9000 });
          await button('检查更新').waitFor({ timeout: 9000 });
          assert.equal(await button('检查更新').isEnabled(), true);
          observations.push(await result.innerText());
        }
        return { observations };
      }
    );
    await test('余额账单：真实余额/免费次数、刷新、无充值入口', async () => {
      await nav('余额与账单');
      await seen('USDT 链充值暂未开放');
      await seen('账单明细');
      const summary = await api('/billing/summary');
      assert.ok(summary);
      await button('刷新').click();
      await button('刷新账单').click();
      await seen('暂无账单');
      await page.screenshot({ path: path.join(evidence, 'billing.png'), fullPage: true });
    });
    await test(
      '余额账单：接口失败提示、按钮恢复、重试成功',
      async () => {
        const fail = route =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 500, message: 'test-服务暂不可用' }),
          });
        await page.route('**/billing/summary', fail);
        await page.route('**/billing/bills/search', fail);
        await button('刷新').click();
        await seen('余额与计费状态加载失败');
        await seen('账单加载失败');
        await page.unroute('**/billing/summary', fail);
        await page.unroute('**/billing/bills/search', fail);
        await button('刷新').click();
        await absent(page.getByText('余额与计费状态加载失败', { exact: true }));
        await absent(page.getByText('账单加载失败', { exact: true }));
      },
      'real-ui; injected-http-failure'
    );
    await test('最小桌面尺寸与全部页面导航/刷新', async () => {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1100, 700)
      );
      for (const name of ['浏览器', '分组', '内核', '账号', '余额与账单', '设置']) {
        await nav(name);
        await page.screenshot({ path: path.join(evidence, `layout-${name}.png`), fullPage: true });
        const mainOverflow = await page
          .locator('body')
          .evaluate(el => el.scrollWidth > innerWidth + 2);
        assert.equal(mainOverflow, false, `${name} overflows body`);
      }
      await page.reload();
      await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
    });
    await test('退出登录关闭运行窗口并撤销旧会话，密码安全回填', async () => {
      const oldToken = token;
      await button('退出登录').click();
      await button('登录').waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('token')), null);
      assert.equal(await page.getByPlaceholder('请输入用户名').inputValue(), username);
      assert.equal(await page.getByRole('checkbox', { name: '记住账号和密码' }).isChecked(), true);
      assert.notEqual(
        (await api('/users/current', undefined, { token: oldToken, allowFailure: true })).code,
        0
      );
      await button('登录').click();
      await button('创建新窗口').waitFor();
      token = await page.evaluate(() => localStorage.getItem('token'));
      assert.deepEqual(await page.evaluate(() => window.ipcRenderer.getAllInstances()), []);
    });
    await test('客户端重启保持登录与浏览器云端资料', async () => {
      await app.close();
      await start();
      await button('创建新窗口').waitFor();
      await row(names.browser).first().waitFor();
      token = await page.evaluate(() => localStorage.getItem('token'));
    });
    await test('浏览器：单条删除取消、批量删除与本地档案清理', async () => {
      await nav('浏览器');
      const r = row(names.browser).filter({ hasNotText: '副本' });
      await button('删除', r).click();
      await confirm('取消');
      await r.waitFor();
      await page.locator('.el-table__header .el-checkbox').click();
      await button('批量删除').click();
      await confirm('确定');
      await absent(row(names.browser));
      assert.equal((await api('/browsers/search', { page: 1, size: 200 })).total, 0);
    });
    await test('内核：无依赖内核删除、取消与实际移除', async () => {
      await nav('内核');
      await button('删除', row('140.0.7259')).click();
      await confirm('取消');
      await row('140.0.7259').waitFor();
      await button('删除', row('140.0.7259')).click();
      await confirm('删除');
      await absent(row('140.0.7259'));
      assert.equal(
        (await page.evaluate(() => window.ipcRenderer.getLocalBrowserVersions())).length,
        0
      );
    });
    await test('分组：删除账号组只解除关联，删除空窗口组', async () => {
      await nav('分组');
      await page.getByRole('tab', { name: '账号分组', exact: true }).click();
      await button('删除', row(names.accountGroup)).click();
      await confirm('确定');
      await absent(row(names.accountGroup));
      assert.equal((await api('/emails/search', { current: 1, pageSize: 200 })).count, 1);
      await page.getByRole('tab', { name: '浏览器分组', exact: true }).click();
      await button('删除', row(names.browserGroup)).click();
      await confirm('确定');
      await absent(row(names.browserGroup));
    });
    await test('取消记住密码立即清除，下次重启不回填', async () => {
      await button('退出登录').click();
      await button('登录').waitFor();
      await page.locator('.remember-checkbox').click();
      await app.close();
      await start();
      await button('登录').waitFor();
      assert.equal(await page.getByPlaceholder('请输入用户名').inputValue(), '');
      assert.equal(await page.getByPlaceholder('请输入密码').inputValue(), '');
      await login();
    });
    await test(
      '登录失效：401清除会话并导航到登录页',
      async () => {
        await page.route('**/billing/summary', route =>
          route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: '{"code":401,"message":"test-expired"}',
          })
        );
        await nav('余额与账单');
        await confirm('去登录');
        await button('登录').waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('token')), null);
      },
      'real-ui; injected-http-401'
    );
    await test(
      '登录失效：HTTP 200 的业务 401 同样清除静默请求会话',
      async () => {
        await page.unroute('**/billing/summary');
        await login();
        await page.route('**/billing/summary', route =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{"code":401,"message":"test-business-expired"}',
          })
        );
        await nav('余额与账单');
        await confirm('去登录');
        await button('登录').waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('token')), null);
      },
      'real-ui; injected-business-401'
    );
    await test('整个操作链没有未捕获渲染异常或业务外部请求', async () => {
      assert.deepEqual(rendererErrors, []);
      assert.deepEqual([...unexpectedOrigins], []);
    });
  }
} finally {
  if (originalClipboard !== undefined)
    await app
      ?.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard)
      .catch(() => {});
  await app?.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  const summary = {
    evidence,
    username,
    passed: results.filter(x => x.status === 'passed').length,
    failed: results.filter(x => x.status === 'failed').length,
    results,
    rendererErrors,
    unexpectedOrigins: [...unexpectedOrigins],
  };
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({ evidence, username, passed: summary.passed, failed: summary.failed })
  );
  if (summary.failed) process.exitCode = 1;
}
