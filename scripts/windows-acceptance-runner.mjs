import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
assert.equal(process.platform, 'win32');
const root = process.cwd();
const site = 'http://192.168.50.221:19091';
for (const file of [
  'full-ui-acceptance.mjs',
  'browser-matrix-acceptance.mjs',
  'fingerprint-worker-acceptance.mjs',
]) {
  const response = await fetch(`${site}/artifacts/${file}`);
  assert.equal(response.status, 200);
  await fs.writeFile(path.join(root, 'scripts', file), Buffer.from(await response.arrayBuffer()));
}
const source = await fetch(`${site}/artifacts/FingerprintInjector.js`);
assert.equal(source.status, 200);
await fs.writeFile(
  path.join(root, 'electron/main/models/FingerprintInjector.js'),
  Buffer.from(await source.arrayBuffer())
);
const common = {
  ...process.env,
  FINGER_TEST_EXECUTABLE: 'C:\\Program Files\\fingerbrowser\\fingerbrowser.exe',
  FINGER_TEST_KERNEL_ROOT: path.join(process.env.APPDATA, 'finger-browser/browser'),
  FINGER_TEST_HTTPS_PROXY_SPKI: await fetch(`${site}/proxy-spki`).then(r => {
    assert.equal(r.status, 200);
    return r.text();
  }),
};
for (const name of ['fingerprintCanvasText.mjs', 'fingerprintFontAssets.mjs']) {
  const r = await fetch(`${site}/artifacts/${name}`);
  assert.equal(r.status, 200);
  await fs.writeFile(
    path.join(root, 'electron/main/models', name),
    Buffer.from(await r.arrayBuffer())
  );
}
await fs.mkdir(path.join(root, 'electron/assets/fingerprint'), { recursive: true });
await fs.mkdir(path.join(root, 'node_modules/opentype.js/dist'), { recursive: true });
for (const [name, target] of [
  ['NotoSansSC-Regular.woff', 'electron/assets/fingerprint/NotoSansSC-Regular.woff'],
  ['opentype.min.js', 'node_modules/opentype.js/dist/opentype.min.js'],
]) {
  const r = await fetch(`${site}/artifacts/${name}`);
  assert.equal(r.status, 200);
  await fs.writeFile(path.join(root, target), Buffer.from(await r.arrayBuffer()));
}
await fs.writeFile(
  path.join(root, 'node_modules/opentype.js/package.json'),
  JSON.stringify({ name: 'opentype.js', version: '2.0.0' })
);
const suites = [
  ['matrix', 'browser-matrix-acceptance.mjs', [], 'test-matrix-win-strict-20261013', 'matrix.json'],
  ['ui', 'full-ui-acceptance.mjs', [], 'test-full-ui-win-strict-20261013', 'results.json'],
  [
    'edge',
    'full-ui-acceptance.mjs',
    ['--edge'],
    'test-full-ui-win-edge-strict-20261013',
    'results.json',
  ],
  ['workers', 'fingerprint-worker-acceptance.mjs', [], null, null],
];
const results = [];
for (const [name, script, args, username, reportName] of suites) {
  if (process.argv.includes('--feedback') && !['ui', 'edge'].includes(name)) continue;
  if (process.argv.includes('--edge-only') && name !== 'edge') continue;
  console.log(`START ${name}`);
  let output = '',
    errors = '';
  const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    env: {
      ...common,
      ...(username ? { FINGER_TEST_USERNAME: process.argv.includes('--feedback') ? `${username}-feedback${process.argv.includes('--quiet') ? '-quiet' : ''}` : username } : {}),
      FINGER_TEST_FIXTURE_SERVICE: 'http://192.168.50.221:19091',
    },
    windowsHide: true,
  });
  child.stdout.on('data', data => {
    output += data;
  });
  child.stderr.on('data', data => {
    errors += data;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await fs.writeFile(path.join(root, `${name}-final.log`), output + errors);
  const line = output
    .trim()
    .split('\n')
    .reverse()
    .find(line => line.startsWith('{'));
  const summary = line ? JSON.parse(line) : { failed: true };
  const report =
    reportName && summary.evidence
      ? JSON.parse(await fs.readFile(path.join(summary.evidence, reportName), 'utf8'))
      : summary;
  await fetch(`${site}/api/test-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `windows-${name}-strict`,
      report: { ...report, exitCode, stderr: errors.slice(0, 3000) },
    }),
  }).then(response => assert.equal(response.status, 201));
  results.push({
    name,
    exitCode,
    passed: summary.passed,
    failed: summary.failed,
    cases: summary.cases,
    evidence: summary.evidence,
  });
  console.log(JSON.stringify(results.at(-1)));
}
await fs.writeFile(path.join(root, 'windows-final.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ finished: true, results }));
if (results.some(result => result.exitCode !== 0)) process.exitCode = 1;
