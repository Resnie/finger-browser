import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
let assets;
export function getFingerprintFontAssets() {
  if (assets) return assets;
  const root = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar'))
    ? path.join(process.resourcesPath, 'app.asar')
    : typeof __dirname !== 'undefined'
      ? path.resolve(__dirname, '../..')
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const require = createRequire(path.join(root, 'package.json'));
  assets = {
    parser: fs.readFileSync(require.resolve('opentype.js/dist/opentype.min.js'), 'utf8'),
    font: fs.readFileSync(path.join(root, 'electron/assets/fingerprint/NotoSansSC-Regular.woff')).toString('base64'),
  };
  return assets;
}
