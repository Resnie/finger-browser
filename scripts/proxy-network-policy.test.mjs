import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyProxyNetworkPolicy, prepareProxyNetworkProfile } from '../electron/main/models/proxyNetworkPolicy.mjs';

test('IP 代理关闭非代理 WebRTC UDP、QUIC、全部本机域名解析和隐式直连例外', () => {
  for (const server of ['http://192.0.2.1:8080', 'https://[2001:db8::1]:443', 'socks5://127.0.0.1:9000']) {
    const options = applyProxyNetworkPolicy({ args: ['--disable-background-networking'] }, {
      server, username: 'test-user', password: 'test-secret', bypass: '*.example.com',
    });
    assert.deepEqual(options.proxy, { server, username: 'test-user', password: 'test-secret', bypass: '<-loopback>' });
    assert.ok(options.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
    assert.ok(options.args.includes('--disable-quic'));
    const host = new URL(server).hostname.replace(/^\[|\]$/g, '');
    assert.ok(options.args.includes(`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}`));
    assert.ok(options.args.includes('--proxy-bypass-list=<-loopback>'));
    assert.ok(options.args.includes('--disable-background-networking'));
  }
});

test('域名代理仅允许代理端点引导解析，拒绝规则注入', () => {
  const options = applyProxyNetworkPolicy({}, { server: 'https://proxy.example:8443' });
  assert.ok(options.args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE proxy.example'));
  for (const server of ['http://proxy,example:8080', 'ftp://proxy.example:21']) {
    assert.throws(() => applyProxyNetworkPolicy({}, { server }), /代理主机格式无效/);
  }
});

test('旧启动参数不能重新打开直连通道，重复应用结果保持不变', () => {
  const options = { args: [
    '--force-webrtc-ip-handling-policy=default', '--host-resolver-rules=EXCLUDE *',
    '--enable-quic', '--proxy-bypass-list=*', '--disable-quic',
  ] };
  const proxy = { server: 'http://192.0.2.1:8080' };
  applyProxyNetworkPolicy(options, proxy);
  const first = structuredClone(options);
  applyProxyNetworkPolicy(options, proxy);
  assert.deepEqual(options, first);
  assert.equal(options.args.some(arg => arg.includes('EXCLUDE *') || arg === '--enable-quic'), false);
  assert.equal(options.args.length, 4);
});

test('原生偏好关闭 WebRTC 直连和网站例外，停用代理时恢复原配置', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-native-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Default', 'Preferences');
  const original = {
    profile: { name: 'keep me' },
    webrtc: { ip_handling_policy: 'default', ip_handling_url: [{ url: '*', handling: 'default' }], udp_port_range: '10000-11000' },
  };
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(original));
  await prepareProxyNetworkProfile(root, true);
  await prepareProxyNetworkProfile(root, true);
  let prefs = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(prefs.webrtc.ip_handling_policy, 'disable_non_proxied_udp');
  assert.deepEqual(prefs.webrtc.ip_handling_url, []);
  assert.deepEqual(prefs.profile, original.profile);
  assert.equal(prefs.webrtc.udp_port_range, original.webrtc.udp_port_range);
  await prepareProxyNetworkProfile(root, false);
  prefs = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(prefs, original);
});

test('新档案停用代理后去除临时偏好；损坏的已有偏好阻止启动', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-native-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Default', 'Preferences');
  await prepareProxyNetworkProfile(root, false);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await prepareProxyNetworkProfile(root, true);
  await prepareProxyNetworkProfile(root, false);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
  await fs.writeFile(file, '{broken');
  await assert.rejects(prepareProxyNetworkProfile(root, true));
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});
