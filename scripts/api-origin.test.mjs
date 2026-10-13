import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveApiOrigin } from './api-origin.mjs';

test('从 API 路径中提取包含端口的 origin', () => {
  assert.equal(resolveApiOrigin('http://localhost:18888/api/v1'), 'http://localhost:18888');
});

test('规范化 HTTPS 与 IPv6 地址', () => {
  assert.equal(resolveApiOrigin('https://example.com/api/v1/'), 'https://example.com');
  assert.equal(resolveApiOrigin('http://[::1]:8888/api/v1'), 'http://[::1]:8888');
});

test('拒绝缺失、非法和非 HTTP API 地址', () => {
  assert.throws(() => resolveApiOrigin(''), /缺少/);
  assert.throws(() => resolveApiOrigin('not-a-url'), /有效 URL/);
  assert.throws(() => resolveApiOrigin('file:///tmp/api'), /仅支持 HTTP 或 HTTPS/);
});

test('生产环境拒绝远程 HTTP，但允许本机回环地址', () => {
  assert.throws(
    () => resolveApiOrigin('http://api.example.com/api/v1', { production: true }),
    /必须使用 HTTPS/
  );
  assert.equal(
    resolveApiOrigin('http://127.0.0.1:8888/api/v1', { production: true }),
    'http://127.0.0.1:8888'
  );
});
