import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const dir = process.argv[2];
if (!dir || !path.resolve(dir).startsWith('/private/tmp/test-finger-')) throw Error('Require the named private test directory');
let source = fs.readFileSync(path.join(root, 'electron/main/models/FingerprintInjector.js'), 'utf8');
for (const [from, file] of [['./fingerprintCanvasText.mjs', 'electron/main/models/fingerprintCanvasText.mjs'], ['../../../shared/fingerprintIdentity.mjs', 'shared/fingerprintIdentity.mjs']]) {
  source = source.replace(`from '${from}'`, `from '${pathToFileURL(path.join(root, file)).href}'`);
}
const { FingerprintInjector } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const meta = { workerInstaller: FingerprintInjector.prototype.installWorkerFingerprints.toString(), profiles: [] };
for (const id of ['test-stable-one', 'test-stable-two']) {
  const fp = new FingerprintInjector(id, { autoFingerprint: true, language: 'zh-CN', languages: ['zh-CN', 'zh'] }, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
  fs.writeFileSync(path.join(dir, id + '.js'), fp.getInjectionScript());
  fs.writeFileSync(path.join(dir, id + '-worker.js'), fp.getWorkerInjectionScript());
  meta.profiles.push({ id, config: fp.config });
}
fs.writeFileSync(path.join(dir, 'runtime-config.json'), JSON.stringify(meta));
