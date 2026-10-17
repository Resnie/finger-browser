import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseProxyApiResponse, normalizeProxyApiRequestError, resolveProxyApiRequestUrl, ProxyApiError } from '../electron/main/models/proxyApi.mjs';
import { getUserFacingErrorMessage } from '../src/utils/error.mjs';

const expected = '203.0.113.10:9700:test-user:test-pass';
const provider = { count: '1', status: '0', list: [{ sever: '203.0.113.10', port: 9700, user: 'test-user', pw: 'test-pass', net_type: 2 }] };

test('91HTTP 自动请求认证字段，保持协议和其他参数，并尊重显式 pw 设置', () => {
  const original = 'http://api.91http.com/v1/get-ip?trade_no=test-order&secret=test-secret&num=1&protocol=2&format=text&filter=1';
  const request = new URL(resolveProxyApiRequestUrl(original));
  assert.equal(request.searchParams.get('pw'), '1');
  for (const [key, value] of new URL(original).searchParams) assert.equal(request.searchParams.get(key), value);
  assert.equal(resolveProxyApiRequestUrl(original + '&pw=0'), original + '&pw=0');
  assert.equal(resolveProxyApiRequestUrl('https://proxy.example/api?num=1'), 'https://proxy.example/api?num=1');
  assert.equal(new URL(original).searchParams.has('pw'), false);
  for (const url of ['broken-secret-url', 'ftp://proxy.example']) {
    assert.throws(() => resolveProxyApiRequestUrl(url), error => error.code === 'PROXY_API_URL' && !error.message.includes('secret'));
  }
});

test('花生代理的 list/sever/pw 响应保留地址与认证，不再误报返回空', () => {
  assert.equal(parseProxyApiResponse(provider), expected);
  assert.equal(parseProxyApiResponse(JSON.stringify(provider)), expected);
});

test('兼容已有 JSON、字符串 data、自定义分隔符及多行文本格式', () => {
  for (const data of [
    { data: [{ ip: '203.0.113.10', port: 9700, username: 'test-user', password: 'test-pass' }] },
    { ip: '203.0.113.10', port: 9700, user: 'test-user', pass: 'test-pass' },
    [{ host: '203.0.113.10', proxy_port: 9700, user: 'test-user', password: 'test-pass' }],
    { code: 200, data: expected },
    '\r\n' + expected + '\r\n203.0.113.11:9700',
    '203.0.113.10:9700@test-user:test-pass',
    'test-user:test-pass@203.0.113.10:9700',
  ]) assert.equal(parseProxyApiResponse(data), expected);
  assert.equal(parseProxyApiResponse(provider, { delimiter: '|' }), expected.replaceAll(':', '|'));
});

test('服务商白名单拒绝不能被当作有效代理或掩盖成空响应', () => {
  assert.throws(() => parseProxyApiResponse({ ...provider, status: 22, detail: '未添加白名单 token=private-session password=private-password' }), error => {
    assert.ok(error instanceof ProxyApiError);
    assert.equal(error.code, 'PROXY_API_PROVIDER_REJECTED');
    assert.match(error.message, /白名单/);
    assert.match(error.message, /22/);
    assert.doesNotMatch(error.message, /private|token=|password=/);
    assert.match(getUserFacingErrorMessage(error), /白名单/);
    return true;
  });
});

test('服务商认证失败显示可处理原因，UI 保留该原因', () => {
  assert.throws(() => parseProxyApiResponse({ code: 401, message: 'session invalid private-api-secret' }), error => {
    assert.match(error.message, /认证失败/);
    assert.doesNotMatch(error.message, /private-api-secret/);
    assert.match(getUserFacingErrorMessage(error), /认证失败/);
    return true;
  });
});

test('空内容、损坏 JSON、错误状态、无效地址和半套认证均阻止启动', () => {
  for (const data of ['', '  ', '{broken', '<html>error</html>', { status: '0', list: [] },
    { status: 500, data: expected }, { ip: '203.0.113.10', port: 0 },
    { ip: '203.0.113.10', port: 65536 }, { ip: 'https://proxy.example', port: 9700 },
    { ip: '203.0.113.10', port: 9700, username: 'private-user' },
    { data: { data: { data: { data: { data: { data: provider } } } } } },
  ]) assert.throws(() => parseProxyApiResponse(data), ProxyApiError);
});

test('请求异常不泄漏完整提取链接、session 或密码', () => {
  const original = Object.assign(new Error('https://proxy.example/?session=private-session&password=private-password'), { response: { status: 403 } });
  const error = normalizeProxyApiRequestError(original);
  assert.match(error.message, /HTTP 403/);
  assert.doesNotMatch(error.message, /https:|private|session=|password=/);
  assert.match(normalizeProxyApiRequestError({ code: 'ETIMEDOUT' }).message, /超时/);
});

test('启动链传递服务商原因且不降级为无代理运行', async () => {
  const source = fs.readFileSync(new URL('../electron/main/models/BrowserInstance.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async fetchProxyFromApi(apiUrl) {');
  const end = source.indexOf('\n  /**', start + 5);
  const instance = new Function('axios', 'parseProxyApiResponse', 'normalizeProxyApiRequestError', 'resolveProxyApiRequestUrl', 'ProxyApiError', `return new (class { ${source.slice(start,end)} })();`)(
    { get: async () => ({ data: { status: 22, detail: '未添加白名单' } }) }, parseProxyApiResponse, normalizeProxyApiRequestError, resolveProxyApiRequestUrl, ProxyApiError
  );
  instance.config = { proxy: { delimiter: ':' } };
  instance.logger = { error() {} };
  await assert.rejects(instance.fetchProxyFromApi('https://proxy.example/api'), error => error.code === 'PROXY_API_PROVIDER_REJECTED');
  const buildStart = source.indexOf('  async buildProxyConfig() {');
  const buildEnd = source.indexOf('\n  /**', buildStart + 5);
  const build = new Function('ProxyApiError', `return (class { ${source.slice(buildStart,buildEnd)} }).prototype.buildProxyConfig;`)(ProxyApiError);
  instance.config.proxy.method = 'api';
  instance.config.proxy.text = 'https://proxy.example/api';
  await assert.rejects(build.call(instance), /白名单/);
});
