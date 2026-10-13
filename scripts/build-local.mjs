#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveNpmCli } from './node-cli.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiBaseUrl = process.argv[2];

const fail = message => {
  console.error(`本地构建失败：${message}`);
  process.exit(1);
};

if (!apiBaseUrl) {
  fail('请显式传入本地 API，例如 npm run build:local -- http://127.0.0.1:8889/api/v1');
}

let parsedApi;
try {
  parsedApi = new URL(apiBaseUrl);
} catch {
  fail('API 地址无效');
}

if (
  !['http:', 'https:'].includes(parsedApi.protocol) ||
  !['localhost', '127.0.0.1', '::1'].includes(parsedApi.hostname)
) {
  fail('本地构建只允许回环地址，避免测试客户端误连远程服务');
}

let npmCli;
try {
  npmCli = resolveNpmCli();
} catch (error) {
  fail(error.message);
}
const result = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
  cwd: repositoryRoot,
  env: { ...process.env, VITE_APP_BASE_API: apiBaseUrl.replace(/\/$/, '') },
  stdio: 'inherit',
  shell: false,
});
if (result.error) fail(`无法执行 npm：${result.error.message}`);
if (result.status !== 0) fail('Vite 构建未通过');

const collectJavaScript = directory => {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScript(target));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
  }
  return files;
};

const builtFiles = [
  ...collectJavaScript(path.join(repositoryRoot, 'dist')),
  ...collectJavaScript(path.join(repositoryRoot, 'dist-electron')),
];
const expected = apiBaseUrl.replace(/\/$/, '');
const matches = builtFiles.filter(file => fs.readFileSync(file, 'utf8').includes(expected));
if (matches.length < 2) {
  fail('构建产物未同时固定前端与 Electron 主进程的本地 API');
}

console.log(`本地构建已锁定 API：${expected}`);
