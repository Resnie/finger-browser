import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { SocksClient } from 'socks';

// Chromium does not authenticate SOCKS5. Keep a per-instance authenticated
// loopback HTTP proxy and carry every upstream TCP connection through SOCKS5.
export async function createSocksProxyBridge(proxy) {
  const address = new URL(proxy.server);
  const proxyHost = address.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = Number(address.port);
  if (
    address.protocol !== 'socks5:' ||
    !proxy.username ||
    !proxy.password ||
    Buffer.byteLength(proxy.username) > 255 ||
    Buffer.byteLength(proxy.password) > 255
  )
    throw new Error('SOCKS5 认证配置无效');
  const username = crypto.randomBytes(24).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const sockets = new Set();
  let closed = false,
    closing;
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const authorized = req => req.headers['proxy-authorization'] === authorization;
  const connect = async destination => {
    if (closed) throw new Error('Proxy closed');
    const socket = track(net.connect(proxyPort, proxyHost));
    socket.setTimeout(10000, () => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Proxy connection closed')));
      });
      const result = await SocksClient.createConnection({
        command: 'connect',
        existing_socket: socket,
        timeout: 10000,
        proxy: {
          host: proxyHost,
          port: proxyPort,
          type: 5,
          userId: proxy.username,
          password: proxy.password,
        },
        destination: {
          host: destination.hostname.replace(/^\[|\]$/g, ''),
          port: Number(destination.port || 80),
        },
      });
      if (closed) {
        result.socket.destroy();
        throw new Error('Proxy closed');
      }
      result.socket.setTimeout(0);
      return result.socket;
    } catch {
      socket.destroy();
      throw new Error('SOCKS5 连接或认证失败');
    }
  };
  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="finger-browser"' });
      return res.end();
    }
    let target;
    try {
      target = new URL(req.url);
      if (target.protocol !== 'http:') throw new Error();
    } catch {
      res.writeHead(400);
      return res.end();
    }
    try {
      const socket = await connect(target);
      if (req.socket.destroyed) return socket.destroy();
      const headers = { ...req.headers, host: target.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const upstream = http.request(
        {
          hostname: target.hostname,
          port: Number(target.port || 80),
          path: target.pathname + target.search,
          method: req.method,
          headers,
          agent,
        },
        response => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
          response.once('end', () => agent.destroy());
        }
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch {
      res.writeHead(502);
      res.end('Proxy connection failed');
    }
  });
  server.on('connection', track);
  server.on('connect', async (req, client, head) => {
    if (!authorized(req))
      return client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="finger-browser"\r\nContent-Length: 0\r\n\r\n'
      );
    try {
      const target = new URL(`http://${req.url}`);
      if (!target.port || target.username || target.password || target.pathname !== '/')
        throw new Error();
      const upstream = await connect(target);
      if (client.destroyed) return upstream.destroy();
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    } catch {
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    }
  });
  server.on('upgrade', async (req, client, head) => {
    if (!authorized(req)) return client.destroy();
    try {
      const target = new URL(req.url);
      if (!['ws:', 'http:'].includes(target.protocol)) throw new Error();
      const upstream = await connect(target);
      if (client.destroyed) return upstream.destroy();
      const headers = { ...req.headers, host: target.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      upstream.write(
        `${req.method} ${target.pathname + target.search} HTTP/${req.httpVersion}\r\n` +
          Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join('') +
          '\r\n'
      );
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    } catch {
      client.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    proxy: { server: `http://127.0.0.1:${server.address().port}`, username, password },
    close() {
      if (closing) return closing;
      closed = true;
      for (const socket of sockets) socket.destroy();
      closing = new Promise(resolve => server.close(resolve));
      return closing;
    },
  };
}
