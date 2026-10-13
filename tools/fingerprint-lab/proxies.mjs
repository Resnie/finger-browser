// Bounded test proxies: only the LAN lab and the product's HTTPS exit probes.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
const host = process.env.FINGER_LAB_HOST || '127.0.0.1';
const tlsOptions =
  process.env.FINGER_PROXY_TLS_CERT && process.env.FINGER_PROXY_TLS_KEY
    ? {
        cert: await fs.readFile(process.env.FINGER_PROXY_TLS_CERT),
        key: await fs.readFile(process.env.FINGER_PROXY_TLS_KEY),
      }
    : null;
const log = process.env.FINGER_PROXY_LOG || '/private/tmp/test-finger-proxy.jsonl';
const peers = new Set(['127.0.0.1', '192.168.50.73', '192.168.50.221']);
const allowed = (hostname, port) =>
  (hostname === '192.168.50.221' && Number(port) === 19090) ||
  (['api.ipify.org', 'www.cloudflare.com'].includes(hostname) && Number(port) === 443);
const record = value =>
  fs.appendFile(log, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
const authValue = 'Basic ' + Buffer.from('test-proxy:test-proxy-pass').toString('base64');
const sockets = new Set();
const track = socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
};
for (const [port, name, authenticated] of [
  [19501, 'http', false],
  [19502, 'http-auth', true],
  ...(tlsOptions
    ? [
        [19505, 'https', false],
        [19506, 'https-auth', true],
      ]
    : []),
]) {
  const check = (req, socket) =>
    peers.has(socket.remoteAddress?.replace(/^::ffff:/, '')) &&
    (!authenticated || req.headers['proxy-authorization'] === authValue);
  const handler = (req, res) => {
    if (!check(req, req.socket)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
      return res.end();
    }
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (!allowed(target.hostname, target.port || 80)) {
      res.writeHead(403);
      return res.end();
    }
    const headers = { ...req.headers, host: target.host, 'x-fingerprint-lab-proxy': name };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request(target, { method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('error', () => upstream.destroy());
    res.on('error', () => upstream.destroy());
    req.pipe(upstream);
    record({ proxy: name, kind: 'http', target: target.host, path: target.pathname });
  };
  const server = name.startsWith('https')
    ? https.createServer(tlsOptions, handler)
    : http.createServer(handler);
  server.on('connection', track);
  server.on('secureConnection', track);
  server.on('tlsClientError', () => {});
  server.on('connect', (req, client, head) => {
    track(client);
    if (!check(req, client))
      return client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n'
      );
    const match = req.url.match(/^([^:]+):(\d+)$/);
    if (!match || !allowed(match[1], match[2])) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const upstream = net.connect(Number(match[2]), match[1], () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    track(upstream);
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    record({ proxy: name, kind: 'connect', target: req.url });
  });
  server.listen(port, host, () => console.log(`Test ${name} proxy ready: ${host}:${port}`));
}
for (const [socksPort, authenticated] of [
  [19503, false],
  [19504, true],
]) {
  net
    .createServer(async client => {
      track(client);
      if (!peers.has(client.remoteAddress?.replace(/^::ffff:/, ''))) return client.destroy();
      let pending,
        buffer = Buffer.alloc(0);
      client.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        if (pending) {
          const resolve = pending;
          pending = null;
          resolve();
        }
      });
      const read = async size => {
        while (buffer.length < size)
          await new Promise(resolve => {
            pending = resolve;
          });
        const data = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        return data;
      };
      try {
        const greeting = await read(2);
        if (greeting[0] !== 5) return client.destroy();
        const methods = await read(greeting[1]);
        const method = authenticated ? 2 : 0;
        if (!methods.includes(method)) return client.end(Buffer.from([5, 255]));
        client.write(Buffer.from([5, method]));
        if (authenticated) {
          const version = (await read(1))[0];
          const username = (await read((await read(1))[0])).toString();
          const password = (await read((await read(1))[0])).toString();
          if (version !== 1 || username !== 'test-proxy' || password !== 'test-proxy-pass')
            return client.end(Buffer.from([1, 1]));
          client.write(Buffer.from([1, 0]));
        }
        const request = await read(4);
        if (request[0] !== 5 || request[1] !== 1) return client.destroy();
        let hostname;
        if (request[3] === 3) hostname = (await read((await read(1))[0])).toString();
        else if (request[3] === 1) hostname = [...(await read(4))].join('.');
        else return client.destroy();
        const port = (await read(2)).readUInt16BE();
        if (!allowed(hostname, port))
          return client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        const upstream = net.connect(port, hostname, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.removeAllListeners('data');
          if (hostname === '192.168.50.221' && port === 19090) {
            let headers = Buffer.alloc(0);
            const forward = data => {
              headers = Buffer.concat([headers, data]);
              const end = headers.indexOf('\r\n\r\n');
              if (end < 0) return;
              client.removeListener('data', forward);
              upstream.write(
                Buffer.concat([
                  Buffer.from(
                    headers
                      .subarray(0, end)
                      .toString()
                      .replace(/\r\nconnection:[^\r\n]*/gi, '')
                  ),
                  Buffer.from(
                    `\r\nConnection: close\r\nX-Fingerprint-Lab-Proxy: ${authenticated ? 'socks5-auth' : 'socks5'}\r\n\r\n`
                  ),
                  headers.subarray(end + 4),
                ])
              );
              client.pipe(upstream);
            };
            client.on('data', forward);
            if (buffer.length) forward(buffer);
          } else {
            if (buffer.length) upstream.write(buffer);
            client.pipe(upstream);
          }
          upstream.pipe(client);
        });
        track(upstream);
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        record({
          proxy: authenticated ? 'socks5-auth' : 'socks5',
          kind: 'connect',
          target: `${hostname}:${port}`,
        });
      } catch {
        client.destroy();
      }
    })
    .listen(socksPort, host, () =>
      console.log(`Test socks5 ${authenticated ? 'auth' : ''} proxy ready: ${host}:${socksPort}`)
    );
}
