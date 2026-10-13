import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Windows初始化不删除现有卸载注册项，由builder管理升级与卸载', () => {
  const script = fs.readFileSync(new URL('../electron/installer.nsh', import.meta.url), 'utf8');
  const init = /!macro customInit([\s\S]*?)!macroend/.exec(script)?.[1] || '';
  assert.ok(!/^\s*DeleteRegKey\b/im.test(init));
});

test('修复保留原应用身份、安装范围和卸载后数据保留策略', () => {
  const { build } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(build.nsis.guid, 'fingerbrowser');
  assert.equal(build.nsis.perMachine, true);
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(build.nsis.include, 'electron/installer.nsh');
});
