import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBrowserEditPlan,
  hasInitialUrlChanged,
  normalizeInitialUrl,
} from '../src/utils/browserEdit.mjs';
import {
  isValidManualProxyText,
  prepareProxyConfigForStorage,
} from '../src/utils/browserProxy.mjs';
import { getUserFacingErrorMessage } from '../src/utils/error.mjs';

test('Electron IPC 错误只展示业务文案', () => {
  assert.equal(
    getUserFacingErrorMessage(
      new Error(
        "Error invoking remote method 'restore-browser-instance': Error: 代理不可达或无法访问互联网，已阻止启动"
      )
    ),
    '代理连接失败，请检查代理地址和账号密码'
  );
});

test('错误文案兼容字符串、重复包装和空值', () => {
  assert.equal(getUserFacingErrorMessage('Error: Error: 启动失败'), '启动失败，请稍后重试');
  assert.equal(getUserFacingErrorMessage({ message: '第一行\n内部堆栈' }), '第一行');
  assert.equal(getUserFacingErrorMessage(null), '操作失败，请稍后重试');
});

test('创建窗口时空初始 URL 保持为空', () => {
  assert.equal(normalizeInitialUrl(' https://example.com '), 'https://example.com/');
  assert.equal(normalizeInitialUrl(''), '');
  assert.equal(normalizeInitialUrl('   '), '');
});

test('仅格式差异不视为 URL 变化', () => {
  assert.equal(hasInitialUrlChanged('https://example.com', ' https://example.com/ '), false);
  assert.equal(hasInitialUrlChanged('https://example.com/a', 'https://example.com/b'), true);
});

test('URL 变化时生成一次性页面种子', () => {
  const config = { base: { url: 'https://new.example/path' } };
  const plan = createBrowserEditPlan({
    id: 'browser-1',
    config,
    previousUrl: 'https://old.example/',
  });

  assert.equal(plan.urlChanged, true);
  assert.deepEqual(plan.payload, {
    id: 'browser-1',
    config,
    pages: [{ url: 'https://new.example/path' }],
  });
});

test('URL 未变化时不携带 pages，保留现有会话', () => {
  const config = { base: { url: 'https://same.example/' } };
  const plan = createBrowserEditPlan({
    id: 'browser-1',
    config,
    previousUrl: 'https://same.example',
  });

  assert.equal(plan.urlChanged, false);
  assert.deepEqual(plan.payload, { id: 'browser-1', config });
  assert.equal(Object.hasOwn(plan.payload, 'pages'), false);
});

test('编辑为空 URL 时清空旧页面种子', () => {
  const config = { base: { url: '' } };
  const plan = createBrowserEditPlan({
    id: 'browser-1',
    config,
    previousUrl: 'https://old.example/',
  });

  assert.equal(plan.urlChanged, true);
  assert.deepEqual(plan.payload, { id: 'browser-1', config, pages: [] });
});

test('禁用代理时清除文本及全部运行时派生凭据', () => {
  assert.deepEqual(
    prepareProxyConfigForStorage({
      enabled: false,
      method: 'manual',
      type: 'http',
      delimiter: ':',
      text: 'proxy.example:8080:user:secret',
      host: 'proxy.example',
      port: 8080,
      username: 'user',
      password: 'secret',
    }),
    {
      enabled: false,
      method: 'manual',
      type: 'http',
      delimiter: ':',
      text: '',
      host: '',
      port: 0,
      username: '',
      password: '',
    }
  );
});

test('启用代理时只持久化用户输入，不沿用上次解析的派生凭据', () => {
  assert.deepEqual(
    prepareProxyConfigForStorage({
      enabled: true,
      method: 'api',
      text: 'https://proxy-api.example/get',
      host: 'stale.example',
      port: 9000,
      username: 'stale-user',
      password: 'stale-password',
    }),
    {
      enabled: true,
      method: 'api',
      text: 'https://proxy-api.example/get',
      host: '',
      port: 0,
      username: '',
      password: '',
    }
  );
});

test('手动代理仅接受 host+port 或完整四段认证格式', () => {
  assert.equal(isValidManualProxyText('proxy.example:8080'), true);
  assert.equal(isValidManualProxyText('proxy.example:8080:user:secret'), true);
  assert.equal(isValidManualProxyText('proxy.example|8080|user|secret', '|'), true);
  assert.equal(isValidManualProxyText('proxy.example:8080:user'), false);
  assert.equal(isValidManualProxyText('proxy.example:8080::secret'), false);
  assert.equal(isValidManualProxyText('proxy.example:70000'), false);
  assert.equal(isValidManualProxyText('https://proxy.example:8080'), false);
});
