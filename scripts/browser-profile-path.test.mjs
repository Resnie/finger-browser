import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  listOwnedBrowserProfileIds,
  prepareOwnedBrowserProfile,
  removeOwnedBrowserProfiles,
  resolveBrowserProfilePaths,
} from '../electron/main/models/browserProfilePath.mjs';

test('旧 profile 在确认 owner 后原子迁移到用户隔离目录并可定向清理', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-profile-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const paths = resolveBrowserProfilePaths(temp, 'test-browser', '7');
  fs.mkdirSync(paths.legacy, { recursive: true });
  fs.writeFileSync(path.join(paths.legacy, 'Cookies'), 'test-cookie');

  const owned = prepareOwnedBrowserProfile(temp, 'test-browser', '7');
  assert.equal(owned, paths.owned);
  assert.equal(fs.existsSync(paths.legacy), false);
  assert.equal(fs.readFileSync(path.join(paths.owned, 'Cookies'), 'utf8'), 'test-cookie');

  assert.equal(removeOwnedBrowserProfiles(temp, 'test-browser', '7'), true);
  assert.equal(fs.existsSync(paths.owned), false);
});

test('profile 路径拒绝越界 ID 与符号链接', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-profile-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  assert.throws(() => resolveBrowserProfilePaths(temp, '../escape', '7'), /ID格式无效/);

  const paths = resolveBrowserProfilePaths(temp, 'test-browser', '7');
  fs.mkdirSync(paths.root, { recursive: true });
  fs.symlinkSync(temp, paths.legacy);
  assert.throws(() => prepareOwnedBrowserProfile(temp, 'test-browser', '7'), /不是受控实体目录/);
});

test('profile 拒绝 browser-data 或 owner 祖先目录符号链接', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-profile-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-profile-outside-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  fs.symlinkSync(outside, path.join(temp, 'browser-data'));
  assert.throws(
    () => prepareOwnedBrowserProfile(temp, 'test-browser', '7'),
    /根目录不是受控实体目录/
  );

  fs.unlinkSync(path.join(temp, 'browser-data'));
  fs.mkdirSync(path.join(temp, 'browser-data'));
  fs.symlinkSync(outside, path.join(temp, 'browser-data', 'u7'));
  assert.throws(
    () => prepareOwnedBrowserProfile(temp, 'test-browser', '7'),
    /owner 目录不是受控实体目录/
  );
});

test('清理当前 owner profile 不会删除其他用户同名目录', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-profile-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const owner7 = resolveBrowserProfilePaths(temp, 'test-browser', '7');
  const owner8 = resolveBrowserProfilePaths(temp, 'test-browser', '8');
  fs.mkdirSync(owner7.owned, { recursive: true });
  fs.mkdirSync(owner8.owned, { recursive: true });

  assert.deepEqual(listOwnedBrowserProfileIds(temp, '7'), ['test-browser']);
  removeOwnedBrowserProfiles(temp, 'test-browser', '7');
  assert.equal(fs.existsSync(owner7.owned), false);
  assert.equal(fs.existsSync(owner8.owned), true);
});
