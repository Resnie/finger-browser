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
assert.ok(
  ['mac-create', 'windows-handoff', 'mac-return', 'mac-live', 'windows-live'].includes(phase)
);
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
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'test-finger-sync-'));
const appData = path.join(evidence, 'appdata');
await fs.mkdir(path.join(appData, 'browser'), { recursive: true });
for (const version of ['140.0.7259', '144.0.7500']) {
  await fs.symlink(
    path.join(process.env.FINGER_TEST_KERNEL_ROOT, version),
    path.join(appData, 'browser', version),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
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
      'Content-Type': 'application/json', 'X-Finger-Runtime-Protocol': '1',
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
const report = { phase, platform: process.platform, evidence, records: [], passed: false };
const api = async (endpoint, body) => {
  const value = await fetch('http://127.0.0.1:8889/api/v1' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Finger-Runtime-Protocol': '1', Authorization: token },
    body: JSON.stringify(body),
  }).then(r => r.json());
  assert.equal(value.code, 0, value.message);
  return value.data;
};
const post = async () => {
  await fs.writeFile(path.join(evidence, 'sync-proof.json'), JSON.stringify(report, null, 2));
  const response = await fetch(control + '/result/' + phase, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Finger-Runtime-Protocol': '1' },
    body: JSON.stringify(report),
  });
  assert.equal(response.status, 201);
};
const waitStage = async (other, stage) => {
  const deadline = Date.now() + 120000;
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
      if (!target) target = await context.newPage();
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
  await page.getByPlaceholder('请输入用户名').fill(settings.username);
  await page.getByPlaceholder('请输入密码').fill('test-Acceptance-20261012');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '创建新窗口', exact: true }).waitFor();
  token = await page.evaluate(() => localStorage.getItem('token'));
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
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
  if (phase === 'mac-create') {
    const existingNames = new Set(
      (await api('/browsers/search', { page: 1, size: 100, includeRecovery: false })).list.map(
        r => r.name
      )
    );
    for (const version of ['140.0.7259', '144.0.7500']) {
      const name = `test-${settings.run}-${version.split('.')[0]}`;
      if (existingNames.has(name)) continue;
      await page.getByRole('button', { name: '创建新窗口', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '创建新窗口', exact: true });
      assert.equal(
        await dialog
          .locator('.el-form-item')
          .filter({ hasText: '自动指纹' })
          .getByRole('switch')
          .getAttribute('aria-checked'),
        'true'
      );
      await dialog.getByRole('textbox', { name: /名称/ }).fill(name);
      const combo = dialog.getByRole('combobox', { name: /浏览器版本/ });
      await combo.press('Enter');
      await page
        .locator(`[id="${await combo.getAttribute('aria-controls')}"]`)
        .getByRole('option', { name: version, exact: true })
        .click();
      await dialog
        .getByRole('textbox', { name: '初始 URL', exact: true })
        .fill(`${settings.site}/?run=${settings.run}&label=${name}&auto=1`);
      await dialog.getByRole('button', { name: '创建窗口', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
  }
  const records = (
    await api('/browsers/search', { page: 1, size: 100, includeRecovery: false })
  ).list.filter(r => r.name.startsWith(`test-${settings.run}-`));
  assert.equal(records.length, 2);
  if (phase === 'windows-live') await waitStage('mac-live', 'opened');
  for (const record of records) {
    const config = JSON.parse(record.config);
    if (live && config.base.browserVersion !== '140.0.7259') continue;
    const original = settings.results?.['mac-create']?.records.find(
      r => r.id === record.browser_id
    );
    const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    if (original) assert.equal(configHash, original.configHash, 'Cross-device config changed');
    const row = page.locator('.el-table__body tr').filter({ hasText: record.name });
    await row.getByRole('button', { name: '打开', exact: true }).click();
    await row.getByText('运行中', { exact: false }).waitFor({ timeout: 120000 });
    const before = await readRuntime(record.browser_id, 'sample', phase);
    const proof = {
      id: record.browser_id,
      name: record.name,
      version: config.base.browserVersion,
      configHash,
      config,
      observation: before,
    };
    report.records.push(proof);
    if (live) {
      proof.storage = await readRuntime(record.browser_id, 'read');
      assert.equal(proof.storage.localStorage, 'from-windows');
      assert.equal(proof.storage.opfs, 'from-windows');
      proof.runningIds = await page.evaluate(() => window.ipcRenderer.getAllInstances());
      assert.ok(proof.runningIds.includes(record.browser_id));
      report.stage = 'opened';
      await post();
      if (phase === 'mac-live') {
        const peer = await waitStage('windows-live', 'closed');
        assert.equal(peer.passed, true);
        assert.equal(peer.records[0].id, record.browser_id);
        proof.afterPeerClose = await readRuntime(record.browser_id, 'read');
        assert.equal(
          proof.afterPeerClose.localStorage,
          'from-windows',
          'Live local process unexpectedly merged remote writes'
        );
        const remote = await api('/browsers/recovery', { id: record.browser_id });
        const value = JSON.parse(remote.state)
          .origins.find(o => o.origin === 'http://127.0.0.1:19093')
          .localStorage.find(entry => entry.name === 'test-sync-value')?.value;
        assert.equal(value, 'from-windows-live');
        await readRuntime(record.browser_id, 'write', 'from-mac-live');
        let conflict;
        try {
          await page.evaluate(
            id =>
              window.ipcRenderer.saveCredential(
                id,
                '127.0.0.1',
                'test-live-stale-user',
                'test-live-password'
              ),
            record.browser_id
          );
        } catch (error) {
          conflict = error.message;
        }
        assert.match(conflict || '', /冲突|其他设备|revision|conflict/i);
        proof.staleWriteRejected = true;
        proof.conflictMessage = conflict;
      } else {
        await readRuntime(record.browser_id, 'write', 'from-windows-live');
        await readRuntime(record.browser_id, 'sample', 'windows-live-save');
      }
      await page.evaluate(id => window.ipcRenderer.removeInstance(id), record.browser_id);
      const recovery = await api('/browsers/recovery', { id: record.browser_id });
      const state = JSON.parse(recovery.state);
      const cloudValue = state.origins
        .find(o => o.origin === 'http://127.0.0.1:19093')
        .localStorage.find(entry => entry.name === 'test-sync-value')?.value;
      assert.equal(
        cloudValue,
        'from-windows-live',
        'Stale device overwrote the newer cloud snapshot'
      );
      proof.cloudValue = cloudValue;
      if (phase === 'mac-live') {
        const outbox = JSON.parse(
          await fs.readFile(path.join(evidence, 'electron', 'browser-recovery-outbox.json'), 'utf8')
        );
        const entry = outbox.entries?.[record.browser_id];
        assert.ok(entry?.encryptedPayload);
        proof.localOutboxRetained = true;
        proof.localOutboxRevision = entry.expectedRevision;
        proof.newerCloudRevision = recovery.recoveryRevision;
        assert.ok(proof.newerCloudRevision > proof.localOutboxRevision);
      }
      report.stage = 'closed';
      report.passed = true;
      await post();
      continue;
    }
    let storage = null;
    if (phase !== 'mac-create') {
      storage = await readRuntime(record.browser_id, 'read');
      proof.storage = storage;
      const expected = phase === 'windows-handoff' ? 'from-mac' : 'from-windows';
      for (const key of ['localStorage', 'sessionStorage', 'indexedDB', 'opfs', 'cacheStorage'])
        assert.equal(storage[key], expected, key);
      assert.equal(storage.owner, record.browser_id);
      assert.equal(storage.httpOnlyCookie, true);
      assert.equal(storage.serverSession.signedIn, true);
      assert.equal(storage.cookieValue, `test-auth-${record.browser_id}`);
      assert.deepEqual(storage.opfsBinary, [0, 255, 128, 13, 10]);
      assert.equal(storage.opfsEmptyDirectory, true);
    }
    if (phase !== 'mac-return')
      await readRuntime(
        record.browser_id,
        'write',
        phase === 'mac-create' ? 'from-mac' : 'from-windows'
      );
    const second = await readRuntime(record.browser_id, 'sample', phase + '-repeat');
    assert.equal(
      before.fingerprintId,
      second.fingerprintId,
      'Fingerprint changed on the same device'
    );
    const history = await page.evaluate(
      id => window.ipcRenderer.getBrowserHistory(id, 100),
      record.browser_id
    );
    if (phase === 'mac-create')
      await page.evaluate(
        id =>
          window.ipcRenderer.saveCredential(
            id,
            '127.0.0.1',
            'test-sync-user',
            'test-sync-password'
          ),
        record.browser_id
      );
    else
      assert.ok(
        (
          await page.evaluate(id => window.ipcRenderer.getSavedCredentials(id), record.browser_id)
        ).some(c => c.username === 'test-sync-user')
      );
    await page.evaluate(id => window.ipcRenderer.removeInstance(id), record.browser_id);
    const recovery = await api('/browsers/recovery', { id: record.browser_id });
    assert.ok(JSON.parse(recovery.state).portableProfile, 'Stopped native snapshot missing');
    Object.assign(proof, {
      id: record.browser_id,
      name: record.name,
      version: config.base.browserVersion,
      configHash,
      config,
      observation: before,
      repeatedFingerprintId: second.fingerprintId,
      storage,
      historyRestored: Boolean(history.length),
      credentialsRestored: phase !== 'mac-create',
      recoveryRevision: recovery.recoveryRevision,
      savedSessionStorage: JSON.parse(recovery.state).sessionStorage,
      savedPageUrls: recovery.pages,
      savedOpfs: JSON.parse(recovery.state).opfs,
    });
  }
  assert.equal(new Set(report.records.map(r => r.observation.fingerprintId)).size, live ? 1 : 2);
  report.passed = true;
  await post();
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
  } else await app.close();
  await new Promise(resolve => fixture.close(resolve));
  console.log(
    JSON.stringify({ passed: report.passed, phase, evidence, ids: report.records.map(r => r.id) })
  );
}
