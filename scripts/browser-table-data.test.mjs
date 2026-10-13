import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBrowserTableData } from '../src/utils/json.js';

test('浏览器列表只保留非恢复元数据，敏感字段不进入 Vue', () => {
  const [row] = parseBrowserTableData([
    {
      browser_id: 'test-browser',
      config: '{"base":{"name":"test-browser"}}',
      pages: '[{"url":"https://example.com"}]',
      state: '{"cookies":[],"origins":[]}',
      history:
        '[{"url":"https://example.com","title":"test","favicon":"","visitCount":1,"lastVisitTime":1}]',
      credentials:
        '[{"domain":"example.com","username":"test-user","password":"test-password","lastUsedTime":1}]',
      recovery_revision: '12',
    },
  ]);

  assert.equal(row.config.base.name, 'test-browser');
  for (const field of ['pages', 'state', 'history', 'credentials', 'recoveryRevision']) {
    assert.equal(Object.hasOwn(row, field), false, field);
  }
});

test('列表不解析或保留损坏的恢复字段', () => {
  const [row] = parseBrowserTableData([
    {
      config: '{}',
      pages: '{}',
      state: null,
      history: 'test-invalid-json',
      credentials: '{"password":"must-not-be-used"}',
      recoveryRevision: '-1',
    },
  ]);

  assert.deepEqual(row.config, {});
  assert.equal(Object.hasOwn(row, 'pages'), false);
  assert.equal(Object.hasOwn(row, 'history'), false);
  assert.equal(Object.hasOwn(row, 'credentials'), false);
});

test('旧后端缺少恢复字段时同样只返回元数据', () => {
  const [row] = parseBrowserTableData([{ config: '{}', pages: '[]', state: null }]);
  assert.deepEqual(row.config, {});
  assert.equal(Object.hasOwn(row, 'pages'), false);
});
