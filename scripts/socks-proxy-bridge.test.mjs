import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { createSocksProxyBridge } from '../electron/main/models/socksProxyBridge.mjs';

const request = (proxy, target, authorized = false) =>
  new Promise((resolve, reject) => {
    const address = new URL(proxy.server);
    const req = http.get(
      {
        hostname: address.hostname,
        port: address.port,
        path: target,
        agent: false,
        headers: authorized
          ? {
              'Proxy-Authorization':
                'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64'),
            }
          : {},
      },
      res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
  });
const unusedPort = async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};

test('SOCKS5 认证桥拒绝未授权本机请求，关闭后释放端口', async () => {
  const bridge = await createSocksProxyBridge({
    server: `socks5://127.0.0.1:${await unusedPort()}`,
    username: 'test-user',
    password: 'test-password',
  });
  try {
    assert.equal(await request(bridge.proxy, 'http://127.0.0.1/'), 407);
  } finally {
    await bridge.close();
  }
  await assert.rejects(
    request(bridge.proxy, 'http://127.0.0.1/'),
    error => error.code === 'ECONNREFUSED'
  );
});

test('认证上游不可达时返回失败，不直连目标网站', async () => {
  let calls = 0;
  const origin = http.createServer((_req, res) => {
    calls++;
    res.end('test-direct');
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const bridge = await createSocksProxyBridge({
    server: `socks5://127.0.0.1:${await unusedPort()}`,
    username: 'test-user',
    password: 'test-password',
  });
  try {
    assert.equal(
      await request(bridge.proxy, `http://127.0.0.1:${origin.address().port}/`, true),
      502
    );
    assert.equal(calls, 0);
  } finally {
    await bridge.close();
    await new Promise(resolve => origin.close(resolve));
  }
});
