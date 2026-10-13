import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseBrowserRecoveryResponse,
  parseLegacyBrowserSearchRecovery,
} from '../electron/main/models/browserRecoveryResponse.mjs';

const validResponse = () => ({
  pages: JSON.stringify([{ url: 'https://example.com' }]),
  state: JSON.stringify({ cookies: [], origins: [] }),
  history: JSON.stringify([
    {
      url: 'https://example.com',
      title: 'test',
      favicon: '',
      visitCount: 1,
      lastVisitTime: 1,
    },
  ]),
  credentials: JSON.stringify([
    {
      domain: 'example.com',
      username: 'test-user',
      password: 'test-password',
      lastUsedTime: 1,
    },
  ]),
  recoveryRevision: 7,
});

test('主进程严格解析恢复详情 JSON 字符串与 revision', () => {
  const parsed = parseBrowserRecoveryResponse(validResponse());
  assert.deepEqual(parsed.pages, [{ url: 'https://example.com' }]);
  assert.deepEqual(parsed.state, { cookies: [], origins: [] });
  assert.equal(parsed.history.length, 1);
  assert.equal(parsed.credentials[0].password, 'test-password');
  assert.equal(parsed.recoveryRevision, 7);
});

test('恢复详情缺失、JSON 损坏或字段越界时整体失败', () => {
  const missing = validResponse();
  delete missing.credentials;
  assert.throws(() => parseBrowserRecoveryResponse(missing), /缺少字段/);

  const invalidJson = validResponse();
  invalidJson.history = 'test-invalid-json';
  assert.throws(() => parseBrowserRecoveryResponse(invalidJson), /格式无效/);

  const invalidCredential = validResponse();
  invalidCredential.credentials = JSON.stringify([{ domain: '', username: 'u', password: 'p' }]);
  assert.throws(() => parseBrowserRecoveryResponse(invalidCredential), /校验失败/);
});

test('state=null 作为旧记录空权威快照保留', () => {
  const response = validResponse();
  response.state = 'null';
  assert.equal(parseBrowserRecoveryResponse(response).state, null);
});

test('新建窗口的空 state 字符串归一为权威空快照', () => {
  const response = validResponse();
  response.state = '';
  assert.equal(parseBrowserRecoveryResponse(response).state, null);
});

test('旧版遗留的内部页、data 与 blob 瞬态页归一为空页列表', () => {
  const recovery = parseBrowserRecoveryResponse({
    ...validResponse(),
    pages: JSON.stringify([
      { url: 'about:blank' },
      { url: 'chrome://newtab/' },
      { url: 'chrome-error://chromewebdata/' },
      { url: 'data:text/html,<title>fingerprint</title>' },
      { url: 'blob:https://example.com/test-runtime-id' },
    ]),
  });
  assert.deepEqual(recovery.pages, []);

  const legacy = parseLegacyBrowserSearchRecovery({
    pages: JSON.stringify([{ url: 'about:blank' }]),
    state: '',
  });
  assert.deepEqual(legacy.pages, []);
});

test('恢复响应不会用“瞬态页过滤”隐藏损坏的 HTTP(S) 数据', () => {
  for (const url of ['https://', 'http:// bad.example', 'javascript:alert(1)']) {
    const response = validResponse();
    response.pages = JSON.stringify([{ url }]);
    assert.throws(() => parseBrowserRecoveryResponse(response), /校验失败/, url);
  }
});

test('跨设备恢复保留经过校验的页面标题', () => {
  const response = validResponse();
  response.pages = JSON.stringify([{ url: 'https://example.com', title: '交易页' }]);
  assert.deepEqual(parseBrowserRecoveryResponse(response).pages, [
    { url: 'https://example.com', title: '交易页' },
  ]);

  response.pages = JSON.stringify([{ url: 'https://example.com', title: 'bad\0title' }]);
  assert.throws(() => parseBrowserRecoveryResponse(response), /校验失败/);
});

test('旧后端 search 恢复只返回经校验的 pages/state，不导入列表凭据', () => {
  const parsed = parseLegacyBrowserSearchRecovery({
    pages: '[{"url":"https://example.com","title":"legacy"}]',
    state: '',
    credentials: '[{"password":"must-not-flow"}]',
  });
  assert.deepEqual(parsed, {
    pages: [{ url: 'https://example.com', title: 'legacy' }],
    state: null,
    recoveryRevision: 0,
  });
  assert.equal(Object.hasOwn(parsed, 'credentials'), false);
});
