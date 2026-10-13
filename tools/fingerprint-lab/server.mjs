import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.FINGER_LAB_HOST || '127.0.0.1';
const port = Number(process.env.FINGER_LAB_PORT || 19090);
const evidence = process.env.FINGER_LAB_EVIDENCE || path.join(root, 'evidence.local');
await fs.mkdir(evidence, { recursive: true });
const observations = [];
for (const file of (await fs.readdir(evidence)).filter(file =>
  /^[A-Za-z0-9_-]+\.jsonl$/.test(file)
)) {
  for (const line of (await fs.readFile(path.join(evidence, file), 'utf8')).trim().split('\n')) {
    if (line) observations.push(JSON.parse(line));
  }
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    );
  return value;
};
const reply = (res, status, value) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
};
const body = async req => {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 500_000) throw new Error('Payload too large');
  }
  return JSON.parse(text);
};
const files = new Map([
  ['/', 'index.html'],
  ['/probe.js', 'probe.js'],
  ['/lab.js', 'lab.js'],
]);
const artifactRoot = process.env.FINGER_LAB_ARTIFACTS;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health')
      return reply(res, 200, { status: 'ok', service: 'fingerprint-lab', version: 1 });
    if (req.method === 'GET' && artifactRoot && url.pathname === '/api/test-proxy') {
      if (!['192.168.50.73', '192.168.50.221'].includes(req.socket.remoteAddress))
        return reply(res, 403, {});
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('192.168.50.221:19502:test-proxy:test-proxy-pass');
    }
    if (req.method === 'POST' && artifactRoot && url.pathname === '/api/test-results') {
      if (!['192.168.50.73', '192.168.50.221'].includes(req.socket.remoteAddress))
        return reply(res, 403, {});
      const value = await body(req);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(value.name) || !value.report) return reply(res, 400, {});
      await fs.writeFile(
        path.join(evidence, `${value.name}.json`),
        JSON.stringify(value.report, null, 2)
      );
      return reply(res, 201, { saved: value.name });
    }
    if (req.method === 'POST' && url.pathname === '/api/observations') {
      const value = await body(req);
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(value.run) ||
        typeof value.label !== 'string' ||
        value.label.length > 100 ||
        !value.probe?.identity ||
        !value.probe?.signals
      )
        return reply(res, 400, { error: 'Invalid observation' });
      const componentHashes = Object.fromEntries(
        Object.entries(value.probe.signals).map(([key, signal]) => [key, hash(canonical(signal))])
      );
      const stable = canonical({ identity: value.probe.identity, components: componentHashes });
      const observation = {
        run: value.run,
        label: value.label,
        phase: String(value.phase || 'manual').slice(0, 60),
        timestamp: new Date().toISOString(),
        fingerprintId: hash(stable),
        signalId: hash(canonical(componentHashes)),
        componentHashes,
        identity: value.probe.identity,
        checks: value.probe.checks,
        request: {
          peer: req.socket.remoteAddress,
          userAgent: req.headers['user-agent'],
          acceptLanguage: req.headers['accept-language'],
          proxy: req.headers['x-fingerprint-lab-proxy'] || null,
        },
      };
      if (observations.length >= 5000) observations.shift();
      observations.push(observation);
      await fs.appendFile(
        path.join(evidence, `${value.run}.jsonl`),
        JSON.stringify(observation) + '\n'
      );
      return reply(res, 201, observation);
    }
    if (req.method === 'GET' && url.pathname === '/api/observations') {
      const run = url.searchParams.get('run') || 'manual';
      const samples = observations.filter(item => item.run === run);
      const groups = [...new Set(samples.map(item => item.label))].map(label => {
        const rows = samples.filter(item => item.label === label);
        return {
          label,
          samples: rows.length,
          fingerprintIds: [...new Set(rows.map(item => item.fingerprintId))],
          stable: new Set(rows.map(item => item.fingerprintId)).size === 1,
        };
      });
      return reply(res, 200, {
        run,
        samples,
        groups,
        uniqueBrowsers: new Set(samples.map(item => item.fingerprintId)).size,
        uniqueSignals: new Set(samples.map(item => item.signalId)).size,
      });
    }
    if (req.method === 'GET' && artifactRoot && url.pathname.startsWith('/artifacts/')) {
      if (!['192.168.50.73', '192.168.50.221'].includes(req.socket.remoteAddress))
        return reply(res, 403, {});
      const name = url.pathname.slice('/artifacts/'.length);
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return reply(res, 404, {});
      const file = path.join(artifactRoot, name);
      const stat = await fs.stat(file);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      const { createReadStream } = await import('node:fs');
      return createReadStream(file).pipe(res);
    }
    const file = files.get(url.pathname);
    if (req.method === 'GET' && file) {
      res.writeHead(200, {
        'Content-Type': file.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(await fs.readFile(path.join(root, file)));
    }
    return reply(res, 404, { error: 'Not found' });
  } catch (error) {
    return reply(res, 400, { error: error.message });
  }
});
server.listen(port, host, () => console.log(`Fingerprint Lab ready: http://${host}:${port}`));
