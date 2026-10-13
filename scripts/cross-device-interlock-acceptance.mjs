import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
assert.ok(['mac-interlock', 'windows-interlock'].includes(phase));
const live = phase.endsWith('-live');
assert.equal(process.platform === 'win32', phase.startsWith('windows'));
const control = process.env.FINGER_SYNC_CONTROL || 'http://192.168.50.221:19092';
const settings = await fetch(control + '/state').then(r => r.json());
assert.match(settings.username, /^test-sync-[A-Za-z0-9_-]+$/);
assert.equal(
  (await fetch('http://127.0.0.1:8889/health').then(r => r.json())).commit,
  'local-acceptance'
);
const executable = process.env.FINGER_TEST_EXECUTABLE;
assert.ok(executable, 'Require the real packaged executable');
const evidence =
  process.env.FINGER_SYNC_EVIDENCE ||
  (await fs.mkdtemp(path.join(os.tmpdir(), 'test-finger-sync-')));
const appData = path.join(evidence, 'appdata');
await fs.mkdir(path.join(appData, 'browser'), { recursive: true });
for (const version of ['140.0.7259', '144.0.7500']) {
  await fs
    .symlink(
      path.join(process.env.FINGER_TEST_KERNEL_ROOT, version),
      path.join(appData, 'browser', version),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    .catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
}
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:19093');
  if (url.pathname === '/login') {
    assert.match(url.searchParams.get('id'), /^[a-f0-9-]{36}$/);
    res.setHeader(
      'Set-Cookie',
      `test-sync-auth=test-auth-${url.searchParams.get('id')}; HttpOnly; SameSite=Lax; Path=/`
    );
  }
  if (url.pathname === '/me') {
    const session = req.headers.cookie?.match(/(?:^|;\s*)test-sync-auth=([^;]+)/)?.[1] || '';
    res.writeHead(session.startsWith('test-auth-') ? 200 : 401, {
      'Content-Type': 'application/json',
      'X-Finger-Runtime-Protocol': '1',
    });
    return res.end(JSON.stringify({ signedIn: session.startsWith('test-auth-'), session }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>test-sync-storage</title><h1>test-sync-storage</h1>');
});
await new Promise((resolve, reject) => {
  fixture.once('error', reject);
  fixture.listen(19093, '127.0.0.1', resolve);
});
const app = await electron.launch({
  executablePath: executable,
  args: [`--user-data-dir=${path.join(evidence, 'electron')}`],
  env: { ...process.env, PROJECT_MAC_BASE_PATH: appData, PROJECT_WIN_BASE_PATH: appData },
  timeout: 30000,
});
let token, page;
const report = { phase, platform: process.platform, evidence, startedAt: new Date().toISOString(), stages: [], records: [], passed: false };
const api = async (endpoint, body) => {
  const value = await fetch('http://127.0.0.1:8889/api/v1' + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finger-Runtime-Protocol': '1',
      Authorization: token,
    },
    body: JSON.stringify(body),
  }).then(r => r.json());
  assert.equal(value.code, 0, value.message);
  return value.data;
};
const post = async () => {
  if (report.stage && report.stages.at(-1)?.stage !== report.stage) {
    report.stages.push({ stage: report.stage, at: new Date().toISOString() });
    console.log(JSON.stringify({ phase, stage: report.stage, at: report.stages.at(-1).at }));
  }
  await fs.writeFile(path.join(evidence, 'sync-proof.json'), JSON.stringify(report, null, 2));
  const response = await fetch(control + '/result/' + phase, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Finger-Runtime-Protocol': '1' },
    body: JSON.stringify(report),
  });
  assert.equal(response.status, 201);
};
const waitStage = async (other, stage) => {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const state = await fetch(control + '/state').then(r => r.json());
    const result = state.results?.[other];
    if (result?.stage === stage) return result;
    if (result?.error) throw new Error('Peer test failed: ' + result.error);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Peer test did not reach ' + other + ':' + stage);
};
const readRuntime = async (id, action, marker) =>
  app.evaluate(
    async (_, { id, action, marker, run, site }) => {
      const context = [...globalThis.__syncContexts].findLast(([dir]) => dir.endsWith(id))?.[1];
      if (!context) throw new Error('Missing real Chromium context');
      if (action === 'sample') {
        let target = context.pages().find(p => p.url().startsWith(site));
        if (!target) target = await context.newPage();
        await target.goto(`${site}/?run=${run}&label=${id}&phase=${marker}&auto=1`);
        await target.waitForFunction(
          () => globalThis.lastFingerprintObservation || globalThis.fingerprintError,
          null,
          { timeout: 20000 }
        );
        return target.evaluate(() => {
          if (globalThis.fingerprintError) throw Error(globalThis.fingerprintError);
          return globalThis.lastFingerprintObservation;
        });
      }
      let target = context.pages().find(p => p.url().startsWith('http://127.0.0.1:19093/'));
      if (!target) {
        target = await context.newPage();
        await target.goto('http://127.0.0.1:19093/');
      }
      if (action === 'write') {
        if (marker === 'from-mac') await target.goto(`http://127.0.0.1:19093/login?id=${id}`);
        await target.goto('http://127.0.0.1:19093/');
        await target.evaluate(
          async ({ marker, id }) => {
            localStorage.setItem('test-sync-owner', id);
            localStorage.setItem('test-sync-value', marker);
            sessionStorage.setItem('test-sync-value', marker);
            const db = await new Promise((resolve, reject) => {
              const q = indexedDB.open('test-sync-idb', 1);
              q.onupgradeneeded = () => q.result.createObjectStore('values');
              q.onsuccess = () => resolve(q.result);
              q.onerror = () => reject(q.error);
            });
            await new Promise((resolve, reject) => {
              const tx = db.transaction('values', 'readwrite');
              tx.objectStore('values').put(marker, 'marker');
              tx.oncomplete = resolve;
              tx.onerror = () => reject(tx.error);
            });
            db.close();
            const dir = await navigator.storage.getDirectory(),
              file = await dir.getFileHandle('test-sync.txt', { create: true }),
              writer = await file.createWritable();
            await writer.write(marker);
            await writer.close();
            const nested = await dir.getDirectoryHandle('目录', { create: true });
            const binary = await (
              await nested.getFileHandle('binary.dat', { create: true })
            ).createWritable();
            await binary.write(new Uint8Array([0, 255, 128, 13, 10]));
            await binary.close();
            await dir.getDirectoryHandle('empty', { create: true });
            await (await caches.open('test-sync-cache')).put('/cached', new Response(marker));
          },
          { marker, id }
        );
      } else await target.waitForLoadState('domcontentloaded');
      const values = await target.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const q = indexedDB.open('test-sync-idb');
          q.onsuccess = () => resolve(q.result);
          q.onerror = () => reject(q.error);
        });
        const idb = await new Promise((resolve, reject) => {
          const q = db.transaction('values').objectStore('values').get('marker');
          q.onsuccess = () => resolve(q.result);
          q.onerror = () => reject(q.error);
        });
        db.close();
        const dir = await navigator.storage.getDirectory();
        const opfs = await dir
          .getFileHandle('test-sync.txt')
          .then(async file => (await file.getFile()).text())
          .catch(error => {
            if (error.name === 'NotFoundError') return null;
            throw error;
          });
        const binary = await dir
          .getDirectoryHandle('目录')
          .then(async nested => [
            ...new Uint8Array(
              await (await (await nested.getFileHandle('binary.dat')).getFile()).arrayBuffer()
            ),
          ])
          .catch(error => {
            if (error.name === 'NotFoundError') return null;
            throw error;
          });
        const emptyDirectory = await dir
          .getDirectoryHandle('empty')
          .then(async empty => (await Array.fromAsync(empty.keys())).length === 0)
          .catch(error => {
            if (error.name === 'NotFoundError') return false;
            throw error;
          });
        const response = await (await caches.open('test-sync-cache')).match('/cached');
        return {
          owner: localStorage.getItem('test-sync-owner'),
          localStorage: localStorage.getItem('test-sync-value'),
          sessionStorage: sessionStorage.getItem('test-sync-value'),
          indexedDB: idb,
          opfs,
          opfsBinary: binary,
          opfsEmptyDirectory: emptyDirectory,
          cacheStorage: response ? await response.text() : null,
          serverSession: await fetch('/me').then(r => r.json()),
        };
      });
      const cookie = (await context.cookies()).find(c => c.name === 'test-sync-auth');
      return { ...values, httpOnlyCookie: cookie?.httpOnly === true, cookieValue: cookie?.value };
    },
    { id, action, marker, run: settings.run, site: settings.site }
  );

try {
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page
    .context()
    .route('**/*', route =>
      ['file:', 'data:'].includes(new URL(route.request().url()).protocol) ||
      ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
        ? route.continue()
        : route.abort()
    );
  await Promise.race([
    page.getByPlaceholder('请输入用户名').waitFor(),
    page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor(),
  ]);
  if (await page.getByPlaceholder('请输入用户名').isVisible()) {
    await page.getByPlaceholder('请输入用户名').fill(settings.username);
    await page.getByPlaceholder('请输入密码').fill('test-Acceptance-20261012');
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor();
  token = await page.evaluate(() => localStorage.getItem('token'));
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  report.clientSourceSha256 = await app.evaluate(({app}) => process.getBuiltinModule('crypto').createHash('sha256').update(process.getBuiltinModule('fs').readFileSync(app.getAppPath()+'/dist-electron/main/index.js')).digest('hex'));
  await app.evaluate(({ app }) => {
    const { chromium } = process
      .getBuiltinModule('module')
      .createRequire(app.getAppPath() + '/package.json')('playwright');
    const original = chromium.launchPersistentContext.bind(chromium);
    globalThis.__syncContexts = new Map();
    chromium.launchPersistentContext = async (dir, options) => {
      const context = await original(dir, options);
      globalThis.__syncContexts.set(dir, context);
      return context;
    };
  });
  const records = (
    await api('/browsers/search', { page: 1, size: 100, includeRecovery: false })
  ).list.filter(r => r.name.startsWith(`test-${settings.run}-`));
  assert.equal(records.length, 2);
  const start = async record => {
    const config = JSON.parse(record.config);
    // The renderer deliberately supplies an invalid stale kernel/config; the
    // authoritative lease response must replace it before Chromium starts.
    config.base.browserVersion = '0.0.0';
    config.base.url = 'http://example.invalid/stale-renderer';
    await page.evaluate(data => window.ipcRenderer.restoreInstance(data), {
      id: record.browser_id,
      config,
      cloudRecoveryVersion: 1,
    });
    return readRuntime(record.browser_id, 'sample', phase);
  };
  const blocked = async record => {
    const count = await app.evaluate(() => globalThis.__syncContexts.size);
    await assert.rejects(() => start(record), /另一端|正在.*运行|运行锁|其他设备/);
    assert.equal(
      await app.evaluate(() => globalThis.__syncContexts.size),
      count,
      'Blocked open launched a native context'
    );
    assert.ok(
      !(await page.evaluate(() => window.ipcRenderer.getAllInstances())).includes(record.browser_id)
    );
  };
  const close = async record => {
    await page.evaluate(id => window.ipcRenderer.removeInstance(id), record.browser_id);
    const value = await api('/browsers/recovery', { id: record.browser_id });
    assert.ok(JSON.parse(value.state).portableProfile);
    assert.ok(JSON.parse(value.state).opfs);
    report.closedRecovery ||= [];
    report.closedRecovery.push({
      id: record.browser_id,
      pages: JSON.parse(value.pages),
      sessionStorage: JSON.parse(value.state).sessionStorage,
    });
    return value.recoveryRevision;
  };
  const checkStorage = async (record, marker) => {
    const values = await readRuntime(record.browser_id, 'read');
    for (const key of ['localStorage', 'sessionStorage', 'indexedDB', 'opfs', 'cacheStorage'])
      assert.equal(values[key], marker, `${key}: ${JSON.stringify(values)}`);
    assert.equal(values.httpOnlyCookie, true);
    assert.equal(values.serverSession.signedIn, true);
    assert.deepEqual(values.opfsBinary, [0, 255, 128, 13, 10]);
    assert.equal(values.opfsEmptyDirectory, true);
    return values;
  };
  if (phase === 'mac-interlock') {
    for (const record of records) {
      const observation = await start(record);
      await readRuntime(record.browser_id, 'write', 'from-mac');
      report.records.push({
        id: record.browser_id,
        version: JSON.parse(record.config).base.browserVersion,
        observation,
      });
    }
    assert.equal((await page.evaluate(() => window.ipcRenderer.getAllInstances())).length, 2);
    report.stage = 'opened';
    await post();
    await waitStage('windows-interlock', 'blocked');
    for (const record of records) await close(record);
    report.stage = 'released';
    await post();
    const peer = await waitStage('windows-interlock', 'opened');
    for (const record of records) {
      await blocked(record);
      const proof = report.records.find(r => r.id === record.browser_id),
        other = peer.records.find(r => r.id === record.browser_id);
      assert.equal(
        proof.observation.fingerprintId,
        other.observation.fingerprintId,
        'Cross-OS fingerprint differs'
      );
    }
    report.stage = 'blocked';
    await post();
    await waitStage('windows-interlock', 'released');
    for (const record of records) {
      const observation = await start(record);
      const proof = report.records.find(r => r.id === record.browser_id);
      assert.equal(observation.fingerprintId, proof.observation.fingerprintId);
      proof.returnedStorage = await checkStorage(record, 'from-windows');
      proof.finalRevision = await close(record);
      proof.mutualExclusion = true;
      proof.freshConfigBeforeLaunch = true;
      proof.crossOSFingerprintEqual = true;
    }
    report.stage = 'done';
    report.passed = true;
    await post();
  } else {
    await waitStage('mac-interlock', 'opened');
    for (const record of records) await blocked(record);
    report.stage = 'blocked';
    await post();
    const peer = await waitStage('mac-interlock', 'released');
    for (const record of records) {
      const observation = await start(record);
      const original = peer.records.find(r => r.id === record.browser_id);
      assert.equal(
        observation.fingerprintId,
        original.observation.fingerprintId,
        'Cross-OS fingerprint differs'
      );
      const storage = await checkStorage(record, 'from-mac');
      report.records.push({
        id: record.browser_id,
        version: JSON.parse(record.config).base.browserVersion,
        observation,
        storage,
      });
    }
    report.stage = 'opened';
    await post();
    await waitStage('mac-interlock', 'blocked');
    for (const record of records) {
      await readRuntime(record.browser_id, 'write', 'from-windows');
      report.records.find(r => r.id === record.browser_id).finalRevision = await close(record);
    }
    report.stage = 'released';
    await post();
    await waitStage('mac-interlock', 'done');
    report.stage = 'done';
    report.passed = true;
    await post();
  }
  assert.equal(new Set(report.records.map(r => r.observation.fingerprintId)).size, 2);
  await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: true });
} catch (error) {
  report.error = error.stack;
  await page
    ?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true })
    .catch(() => {});
  await post();
  throw error;
} finally {
  if (live) {
    // Pending conflicting snapshots stay encrypted in this disposable fixture. There are
    // no business contexts left; exit only the test-owned app instead of discarding data.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  } else {
    await page
      ?.evaluate(async () => {
        for (const id of await window.ipcRenderer.getAllInstances())
          await window.ipcRenderer.removeInstance(id);
      })
      .catch(() => {});
    await app.close();
  }
  await new Promise(resolve => fixture.close(resolve));
  console.log(
    JSON.stringify({ passed: report.passed, phase, evidence, ids: report.records.map(r => r.id) })
  );
}
