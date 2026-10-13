// Temporary pagination fixture service for the named acceptance VM.
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const host = process.env.FINGER_LAB_HOST || '127.0.0.1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = new Map([
  ...[
    'local-runtime-interlock-acceptance.mjs',
    'full-ui-acceptance.mjs',
    'browser-matrix-acceptance.mjs',
    'fingerprint-worker-acceptance.mjs',
    'windows-acceptance-runner.mjs',
  ].map(name => [name, path.join(root, 'scripts', name)]),
  ...['FingerprintInjector.js', 'fingerprintCanvasText.mjs', 'fingerprintFontAssets.mjs'].map(
    name => [name, path.join(root, 'electron/main/models', name)]
  ),
  [
    'NotoSansSC-Regular.woff',
    path.join(root, 'electron/assets/fingerprint/NotoSansSC-Regular.woff'),
  ],
  ['opentype.min.js', path.join(root, 'node_modules/opentype.js/dist/opentype.min.js')],
]);
http
  .createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (!['192.168.50.73', '192.168.50.221'].includes(req.socket.remoteAddress))
      return reply(403, {});
    if (req.method === 'GET' && req.url === '/proxy-spki') {
      if (!process.env.FINGER_PROXY_TLS_SPKI) return reply(503, {});
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(process.env.FINGER_PROXY_TLS_SPKI);
    }
    if (req.method === 'GET' && req.url === '/api/test-proxy') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('192.168.50.221:19502:test-proxy:test-proxy-pass');
    }
    if (req.method === 'GET' && req.url.startsWith('/artifacts/')) {
      const target = artifacts.get(req.url.slice('/artifacts/'.length));
      if (!target) return reply(404, {});
      const content = await fs.readFile(target);
      res.writeHead(200, { 'Content-Length': content.length });
      return res.end(content);
    }
    if (req.method === 'POST' && req.url === '/api/test-results') {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 2_000_000) return reply(413, {});
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!/^windows-(runtime|matrix|ui|edge|workers)-strict$/.test(value.name) || !value.report)
        return reply(400, {});
      const evidence = process.env.FINGER_LAB_TEST_EVIDENCE;
      if (!evidence) return reply(503, {});
      await fs.mkdir(evidence, { recursive: true });
      await fs.writeFile(
        path.join(evidence, value.name + '.json'),
        JSON.stringify(value.report, null, 2)
      );
      return reply(201, { saved: value.name });
    }
    if (req.method !== 'POST' || req.url !== '/seed-pagination') return reply(403, {});
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1000) throw new Error('Payload too large');
      }
      const { username, run } = JSON.parse(body);
      if (!/^test-full-ui-[A-Za-z0-9_-]{1,60}$/.test(username) || !/^[a-z0-9]{1,20}$/.test(run))
        return reply(400, {});
      if (
        (await fetch('http://127.0.0.1:8889/health').then(r => r.json())).commit !==
        'local-acceptance'
      )
        return reply(503, {});
      const numbers = Array.from({ length: 12 }, (_, i) => `SELECT ${i} AS n`).join(' UNION ALL ');
      const query = `INSERT INTO t_apikey(uuid,api_name,email,uid,creatTime,del) SELECT CONCAT('${run}-page-',n),CONCAT('test-page-',n),CONCAT('test-page-${run}-',n,'@example.test'),u.id,UNIX_TIMESTAMP(),0 FROM t_user u CROSS JOIN (${numbers}) numbers WHERE u.user='${username}';`;
      const seeded = spawnSync(
        'docker',
        [
          'exec',
          '-e',
          'MYSQL_PWD=test-local-mysql-20261012',
          'test-finger-mysql-20261012',
          'mysql',
          '-uroot',
          'test_finger_acceptance_20261012',
          '-e',
          query,
        ],
        { encoding: 'utf8' }
      );
      return reply(seeded.status === 0 ? 200 : 500, { success: seeded.status === 0 });
    } catch {
      return reply(500, { success: false });
    }
  })
  .listen(19091, host, () => console.log(`Named test VM fixture service ready: ${host}:19091`));
