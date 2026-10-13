#!/usr/bin/env node
// Render the repository's vector brand, then produce platform icon formats.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.argv[2];
if (!executablePath) throw new Error('请提供本机测试 Chromium 可执行路径');
await fs.mkdir(path.join(root, 'build'), { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1,
  });
  const svg = await fs.readFile(path.join(root, 'public/app-icon.svg'), 'utf8');
  await page.setContent(
    `<style>html,body{margin:0;width:1024px;height:1024px;background:transparent}</style>${svg}`
  );
  await page.screenshot({ path: path.join(root, 'public/app-icon.png'), omitBackground: true });
} finally {
  await browser.close();
}
const platform =
  process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const binary =
  platform === 'mac'
    ? `app-builder_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
    : platform === 'win'
      ? 'app-builder.exe'
      : 'app-builder';
const builder = path.join(
  root,
  'node_modules/app-builder-bin',
  platform,
  ...(platform === 'mac' ? [] : [process.arch]),
  binary
);
for (const format of ['icns', 'ico']) {
  execFileSync(
    builder,
    [
      'icon',
      '--format',
      format,
      '--input',
      path.join(root, 'public/app-icon.png'),
      '--out',
      path.join(root, 'build'),
    ],
    { stdio: 'inherit' }
  );
}
console.log('已生成应用品牌 PNG、macOS ICNS 与 Windows ICO');
