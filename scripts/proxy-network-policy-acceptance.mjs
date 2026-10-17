import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { applyProxyNetworkPolicy, prepareProxyNetworkProfile } from '../electron/main/models/proxyNetworkPolicy.mjs';
import { probeProxyConnectivity } from '../electron/main/models/proxyProbe.mjs';
import { captureOpfs } from '../electron/main/models/browserOpfs.mjs';

const executablePath = process.env.FINGER_TEST_CHROMIUM;
assert.ok(executablePath, 'Set FINGER_TEST_CHROMIUM to the managed Chromium executable');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-proxy-policy-acceptance-'));
const requests = [];
let directRequests = 0;
let directUdpPackets = 0;
let directRtcTcpConnections = 0;
const proxyConnects = [];
const udp = dgram.createSocket('udp4');
udp.on('message', () => { directUdpPackets += 1; });
const rtcTcp = net.createServer(socket => {
  directRtcTcpConnections += 1;
  socket.destroy();
});
const direct = http.createServer((req, res) => {
  directRequests += 1;
  res.end('unexpected direct request');
});
const proxy = http.createServer((req, res) => {
  requests.push(req.url);
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><title>Proxy policy fixture</title><p>reached through proxy</p>');
});
proxy.on('connect', (req, socket) => {
  proxyConnects.push(req.url);
  socket.end('HTTP/1.1 502 Fixture refuses external tunnels\r\nContent-Length: 0\r\n\r\n');
});
await new Promise(resolve => direct.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => rtcTcp.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
const proxyConfig = { server: `http://127.0.0.1:${proxy.address().port}` };
const loopbackTarget = `http://127.0.0.1:${direct.address().port}/must-be-proxied`;
let context;
let proxyStopped = false;
const report = { kernel: path.basename(executablePath), checks: [] };
try {
  await fs.mkdir(path.join(root, 'profile', 'Default'), { recursive: true });
  await fs.writeFile(path.join(root, 'profile', 'Default', 'Preferences'), JSON.stringify({
    webrtc: { ip_handling_policy: 'default', ip_handling_url: [{ url: '*', handling: 'default' }] },
  }));
  await prepareProxyNetworkProfile(path.join(root, 'profile'), true);
  context = await chromium.launchPersistentContext(
    path.join(root, 'profile'),
    applyProxyNetworkPolicy({ executablePath, headless: process.env.FINGER_TEST_HEADED !== '1', timeout: 10000 }, proxyConfig)
  );
  report.checks.push('native persistent context starts with a literal proxy IP');
  const page = context.pages()[0];
  await page.goto('http://website-with-no-dns.invalid/', { timeout: 5000 });
  assert.ok(requests.includes('http://website-with-no-dns.invalid/'));
  assert.match(await page.textContent('body'), /reached through proxy/);
  report.checks.push('website hostname is delegated to the proxy without local DNS');

  await page.goto(loopbackTarget, { timeout: 5000 });
  assert.ok(requests.includes(loopbackTarget));
  assert.equal(directRequests, 0);
  report.checks.push('implicit localhost bypass is removed');

  const session = await context.newCDPSession(page);
  const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
  report.nativeFlags = args.filter(arg => /^--(force-webrtc-ip-handling-policy|disable-quic|host-resolver-rules|proxy-bypass-list)/.test(arg));
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(args.includes('--disable-quic'));
  assert.ok(args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'));
  await session.detach();

  // A fresh iframe supplies an untouched native constructor; no JS fingerprint
  // shim is installed in this acceptance context.
  report.rtc = await page.evaluate(async ({ udpPort, tcpPort }) => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const candidates = [];
    const pc = new iframe.contentWindow.RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:74.125.250.129:19302', `stun:127.0.0.1:${udpPort}`] },
        { urls: `turn:127.0.0.1:${tcpPort}?transport=tcp`, username: 'fixture', credential: 'fixture' },
      ],
    });
    try {
      pc.onicecandidate = e => {
        if (e.candidate) candidates.push({ address: e.candidate.address, type: e.candidate.type, protocol: e.candidate.protocol });
      };
      pc.createDataChannel('policy-check');
      await pc.setLocalDescription(await pc.createOffer());
      await Promise.race([
        new Promise(resolve => {
          if (pc.iceGatheringState === 'complete') resolve();
          else pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
        }),
        new Promise(resolve => setTimeout(resolve, 8000)),
      ]);
      return { available: true, candidates, gatheringState: pc.iceGatheringState };
    } finally { pc.close(); iframe.remove(); }
  }, { udpPort: udp.address().port, tcpPort: rtcTcp.address().port });
  assert.equal(report.rtc.candidates.length, 0);
  assert.equal(directUdpPackets, 0);
  assert.equal(directRtcTcpConnections, 0);
  assert.ok(proxyConnects.includes(`127.0.0.1:${rtcTcp.address().port}`));
  report.checks.push('native iframe WebRTC exposes no host or public candidate');
  report.checks.push('literal STUN sends no direct UDP; TURN TCP is delegated to the proxy');

  report.webTransport = await page.evaluate(async port => {
    if (!globalThis.WebTransport) return 'unavailable';
    const transport = new WebTransport(`https://127.0.0.1:${port}/transport`);
    transport.closed.catch(() => {});
    try {
      return await Promise.race([
        transport.ready.then(() => 'unexpected success', () => 'failed'),
        new Promise(resolve => setTimeout(() => resolve('timed out'), 2000)),
      ]);
    } finally { transport.close(); }
  }, udp.address().port);
  assert.equal(directUdpPackets, 0);
  assert.notEqual(report.webTransport, 'unexpected success');
  report.checks.push('WebTransport creates no direct UDP packet to a literal target');

  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
  proxyStopped = true;
  await assert.rejects(page.goto(loopbackTarget + '?after-expiry', { timeout: 4000 }), /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/);
  assert.equal(directRequests, 0);
  report.checks.push('a closed proxy fails without falling back to localhost');

  await assert.rejects(probeProxyConnectivity(proxyConfig, {
    launchPersistentContext: (...args) => chromium.launchPersistentContext(...args),
    contextOptions: { executablePath },
    targets: [{ name: 'fixture', url: 'https://probe-with-no-dns.invalid/ip', responseType: 'json' }],
    timeoutMs: 5000,
  }), error => error.code === 'PROXY_UNREACHABLE');
  report.checks.push('dead proxy startup probe fails and cleans its native context');
  await context.close();
  context = null;
  await prepareProxyNetworkProfile(path.join(root, 'profile'), false);
  const restoredPrefs = JSON.parse(await fs.readFile(path.join(root, 'profile', 'Default', 'Preferences'), 'utf8'));
  assert.equal(restoredPrefs.webrtc.ip_handling_policy, 'default');
  assert.deepEqual(restoredPrefs.webrtc.ip_handling_url, [{ url: '*', handling: 'default' }]);
  report.checks.push('disabling proxy restores previous native WebRTC preferences after Chromium exits');
  // The stopped-profile reader must still export data with all external traffic
  // quarantined; intercepted documents require no DNS or proxy connectivity.
  const readerDir = path.join(root, 'reader');
  await prepareProxyNetworkProfile(readerDir, true);
  context = await chromium.launchPersistentContext(readerDir, applyProxyNetworkPolicy({
    executablePath, headless: true, timeout: 10000, serviceWorkers: 'block',
  }, { server: 'http://127.0.0.1:9' }));
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  const readerPage = context.pages()[0];
  await readerPage.goto('https://opfs-policy-fixture.invalid/', { timeout: 5000 });
  await readerPage.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('policy.bin', { create: true });
    const writer = await file.createWritable();
    await writer.write(new Uint8Array([0, 255, 13, 10]));
    await writer.close();
  });
  const opfs = await captureOpfs(context, ['https://opfs-policy-fixture.invalid']);
  assert.deepEqual(Buffer.from(opfs.origins[0].files[0].data, 'base64'), Buffer.from([0, 255, 13, 10]));
  report.checks.push('network-quarantined profile reader still exports binary OPFS data');
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.passed = false;
  report.error = error.message;
  console.error(JSON.stringify(report, null, 2));
  throw error;
} finally {
  await context?.close();
  if (!proxyStopped) await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => direct.close(resolve));
  await new Promise(resolve => rtcTcp.close(resolve));
  udp.close();
  await fs.rm(root, { recursive: true, force: true });
}
