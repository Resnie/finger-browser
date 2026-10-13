import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(import.meta.dirname, '..');
const source = (
  await fs.readFile(path.join(root, 'electron/main/models/FingerprintInjector.js'), 'utf8')
).replace(
  "from '../../../shared/fingerprintIdentity.mjs';",
  `from '${pathToFileURL(path.join(root, 'shared/fingerprintIdentity.mjs')).href}';`
);
const completeSource = source.replace("from './fingerprintCanvasText.mjs';", `from '${pathToFileURL(path.join(root, 'electron/main/models/fingerprintCanvasText.mjs')).href}';`);
const { FingerprintInjector } = await import(
  `data:text/javascript;base64,${Buffer.from(completeSource).toString('base64')}`
);
const script = `onmessage=()=>{const canvas=new OffscreenCanvas(2,2);const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(50,100,150)';ctx.fillRect(0,0,2,2);postMessage({platform:navigator.platform,cpu:navigator.hardwareConcurrency,language:navigator.language,pixels:Array.from(ctx.getImageData(0,0,2,2).data),location:location.href});};`;
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': req.url === '/worker.js' ? 'text/javascript' : 'text/html',
    'Content-Security-Policy': "worker-src 'self'; script-src 'self'",
  });
  res.end(
    req.url === '/worker.js' ? script : '<!doctype html><title>Native worker validation</title>'
  );
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const version of ['140.0.7259', '144.0.7500']) {
    const kernelRoot =
      process.env.FINGER_TEST_KERNEL_ROOT ||
      path.join(os.homedir(), 'Library/Application Support/finger-browser/browser');
    const kernel = path.join(
      kernelRoot,
      version,
      os.platform() === 'win32'
        ? 'chrome-win64/chrome.exe'
        : 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    );
    const browser = await chromium.launch({ executablePath: kernel, headless: true });
    try {
      for (const id of ['test-worker-a', 'test-worker-b']) {
        const context = await browser.newContext();
        const injector = new FingerprintInjector(id, {
          autoFingerprint: true,
          language: 'en-US',
          platform: 'Win32',
          hardwareConcurrency: 4,
          deviceMemory: 8,
        });
        await context.addInitScript(injector.getInjectionScript());
        const page = await context.newPage();
        await injector.installWorkerFingerprints(context, console);
        await page.goto(base);
        const cdp = await context.newCDPSession(page);
        let publicEvent = false;
        cdp.on('Runtime.consoleAPICalled', () => {
          publicEvent = true;
        });
        await cdp.send('Runtime.enable');
        await page.evaluate(() => console.log('test-public-cdp'));
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(publicEvent, true, 'Public CDP events were lost');
        await cdp.detach();
        for (const type of ['classic', 'module']) {
          const value = await page.evaluate(
            type =>
              new Promise((resolve, reject) => {
                const w = new Worker('/worker.js', { type });
                const timer = setTimeout(() => {
                  w.terminate();
                  reject(new Error('Worker timeout'));
                }, 5000);
                w.onmessage = e => {
                  clearTimeout(timer);
                  w.terminate();
                  resolve(e.data);
                };
                w.onerror = e => {
                  clearTimeout(timer);
                  reject(new Error(e.message));
                };
                w.postMessage({});
              }),
            type
          );
          assert.equal(value.platform, 'Win32');
          assert.equal(value.cpu, 4);
          assert.equal(value.language, 'en-US');
          assert.equal(value.location, base + '/worker.js');
          results.push({ version, id, type, ...value });
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
  for (const version of ['140.0.7259', '144.0.7500'])
    assert.notDeepEqual(
      results.find(x => x.version === version && x.id === 'test-worker-a').pixels,
      results.find(x => x.version === version && x.id === 'test-worker-b').pixels
    );
  console.log(JSON.stringify({ passed: true, cases: results.length, results }));
} finally {
  await new Promise(resolve => server.close(resolve));
}
