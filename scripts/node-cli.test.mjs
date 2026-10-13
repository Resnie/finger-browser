import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { resolveElectronBuilderCli, resolveNpmCli } from './node-cli.mjs';

const fixture = (files, realpaths = {}) => ({
  fileExists: target => files.includes(target),
  resolveRealpath: target => realpaths[target] || null,
});

test('Windows 官方 Node 安装目录直接解析 npm JavaScript，不执行 cmd', () => {
  const cli = String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`;
  assert.equal(
    resolveNpmCli({
      platform: 'win32',
      execPath: String.raw`C:\Program Files\nodejs\node.exe`,
      env: {},
      ...fixture([cli]),
    }),
    cli
  );
});

test('npm run 优先使用 npm_execpath，中文与空格路径无需 shell 转义', () => {
  const cli = String.raw`C:\Users\测试 用户\工具\npm\bin\npm-cli.js`;
  assert.equal(
    resolveNpmCli({
      platform: 'win32',
      execPath: String.raw`C:\Node\node.exe`,
      env: { npm_execpath: cli },
      ...fixture([cli]),
    }),
    cli
  );
});

test('Windows Path 大小写与带引号目录兼容，忽略 npm.cmd/yarn 包装器', () => {
  const cli = String.raw`D:\Node 工具\node_modules\npm\bin\npm-cli.js`;
  assert.equal(
    resolveNpmCli({
      platform: 'win32',
      execPath: String.raw`C:\Node\node.exe`,
      env: {
        npm_execpath: String.raw`C:\Node\npm.cmd`,
        Path: String.raw`C:\Windows\System32;"D:\Node 工具"`,
      },
      ...fixture([cli]),
    }),
    cli
  );
});

test('POSIX PATH npm 符号链接和版本管理器均解析为真实 CLI', () => {
  const cli = '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js';
  assert.equal(
    resolveNpmCli({
      platform: 'darwin',
      execPath: '/opt/homebrew/bin/node',
      env: { PATH: '/usr/bin:/opt/homebrew/bin' },
      ...fixture([cli], { '/opt/homebrew/bin/npm': cli }),
    }),
    cli
  );
  const nvmCli = '/tmp/test-node-version/lib/node_modules/npm/bin/npm-cli.js';
  assert.equal(
    resolveNpmCli({
      platform: 'linux',
      execPath: '/tmp/test-node-version/bin/node',
      env: {},
      ...fixture([nvmCli]),
    }),
    nvmCli
  );
});

test('CLI 缺失明确报错，不回退为 npm.cmd/npx.cmd 或在线下载', () => {
  assert.throws(
    () =>
      resolveNpmCli({
        platform: 'win32',
        execPath: String.raw`C:\Node\node.exe`,
        env: { npm_execpath: String.raw`C:\Node\npm.cmd` },
        ...fixture([String.raw`C:\Node\npm.cmd`]),
      }),
    /未找到 npm-cli.js/
  );
  assert.throws(
    () =>
      resolveElectronBuilderCli({
        resolveModule: () => {
          throw new Error('missing');
        },
      }),
    /先执行 npm ci/
  );
});

test('electron-builder 仅解析项目已安装的官方 Node CLI', () => {
  const cli = String.raw`C:\测试项目\node_modules\electron-builder\out\cli\cli.js`;
  assert.equal(
    resolveElectronBuilderCli({
      resolveModule: specifier => {
        assert.equal(specifier, 'electron-builder/out/cli/cli.js');
        return cli;
      },
    }),
    cli
  );
  assert.ok(fs.statSync(resolveElectronBuilderCli()).isFile());
  assert.ok(fs.statSync(resolveNpmCli()).isFile());
});

test('本地构建和发布脚本始终经当前 Node 启动 CLI，仍关闭 shell', () => {
  for (const script of ['build-local.mjs', 'release.mjs']) {
    const source = fs.readFileSync(new URL(script, import.meta.url), 'utf8');
    assert.match(source, /shell: false/);
    assert.ok(!source.includes("'npm.cmd'"));
    assert.ok(!source.includes("'npx.cmd'"));
    assert.match(source, /(?:spawnSync|run)\(process\.execPath,/);
  }
});
