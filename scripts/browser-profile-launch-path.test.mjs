import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  prepareBrowserProfileLaunchPath,
  getBrowserProfileProcessPaths,
  releaseBrowserProfileLaunchPath,
  browserCommandUsesProfile,
} from '../electron/main/models/browserProfileLaunchPath.mjs';

const fixture = t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'test-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'long-folder-'.repeat(9), 'test-browser');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'retained.txt'), 'test-profile-data');
  return { root, profile };
};

test('Windows long profiles use a short binding, then unlink only the binding', t => {
  const { root, profile } = fixture(t);
  const binding = prepareBrowserProfileLaunchPath(profile, { platform: 'win32', tempDir: root });
  assert.ok(binding.launchPath.length <= 110);
  assert.equal(path.basename(binding.launchPath), 'test-browser');
  assert.equal(
    fs.readFileSync(path.join(binding.launchPath, 'retained.txt'), 'utf8'),
    'test-profile-data'
  );
  assert.deepEqual(getBrowserProfileProcessPaths(binding, profile), [profile, binding.launchPath]);
  releaseBrowserProfileLaunchPath(binding);
  assert.equal(fs.existsSync(binding.launchPath), false);
  assert.equal(fs.readFileSync(path.join(profile, 'retained.txt'), 'utf8'), 'test-profile-data');
  releaseBrowserProfileLaunchPath(binding);
});

test('retargeted aliases cannot identify processes or remove any profile', t => {
  const { root, profile } = fixture(t);
  const other = path.join(root, 'other-profile');
  fs.mkdirSync(other);
  const binding = prepareBrowserProfileLaunchPath(profile, { platform: 'win32', tempDir: root });
  fs.unlinkSync(binding.launchPath);
  fs.symlinkSync(other, binding.launchPath, 'junction');
  assert.throws(() => getBrowserProfileProcessPaths(binding, profile), /绑定已改变/);
  assert.throws(() => releaseBrowserProfileLaunchPath(binding), /绑定已改变/);
  assert.equal(fs.existsSync(profile), true);
  assert.equal(fs.existsSync(other), true);
});

test('another profile and fabricated aliases cannot reuse a binding', t => {
  const { root, profile } = fixture(t);
  const binding = prepareBrowserProfileLaunchPath(profile, { platform: 'win32', tempDir: root });
  assert.throws(() => getBrowserProfileProcessPaths(binding, path.join(root, 'other')), /不一致/);
  assert.throws(() => getBrowserProfileProcessPaths({ ...binding }, profile), /绑定无效/);
  releaseBrowserProfileLaunchPath(binding);
});

test('normal Windows paths and macOS profiles retain their direct paths', t => {
  const { root, profile } = fixture(t);
  for (const [dir, platform] of [
    [profile, 'darwin'],
    [root, 'win32'],
  ]) {
    const binding = prepareBrowserProfileLaunchPath(dir, { platform });
    assert.equal(binding.launchPath, dir);
    assert.deepEqual(getBrowserProfileProcessPaths(binding, dir), [dir]);
    releaseBrowserProfileLaunchPath(binding);
    assert.equal(fs.existsSync(dir), true);
  }
});

test('process matching requires the exact user-data-dir argument', () => {
  const dir = 'C:\\Users\\test person\\fb-abcd\\test-browser';
  for (const arg of [
    `"--user-data-dir=${dir}"`,
    `--user-data-dir="${dir}"`,
    '--user-data-dir=C:/test/profile',
  ]) {
    assert.equal(
      browserCommandUsesProfile(`chrome.exe ${arg} --test`, [dir, 'C:\\test\\profile']),
      true
    );
  }
  for (const cmd of [
    `chrome.exe "--user-data-dir=${dir}-other"`,
    `chrome.exe --test="${dir}"`,
    'chrome.exe --user-data-dir=C:\\other',
  ]) {
    assert.equal(browserCommandUsesProfile(cmd, [dir]), false);
  }
});

test('进程路径解析在应用重启后仍能识别指向受控档案的旧临时链接',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'test-profile-process-restart-'));
 try {const managed=path.join(root,'owned'),alias=path.join(root,'alias');fs.mkdirSync(managed);fs.symlinkSync(managed,alias,process.platform==='win32'?'junction':'dir');assert.equal(browserCommandUsesProfile(`chrome --user-data-dir="${alias}"`,[managed]),true);assert.equal(browserCommandUsesProfile(`chrome --user-data-dir="${alias}"`,[path.join(root,'other')]),false);}finally{fs.rmSync(root,{recursive:true,force:true})}
});
