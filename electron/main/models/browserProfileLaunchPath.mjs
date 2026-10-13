import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CacheStorage appends hashes, UUIDs and temporary index names to the profile.
// Chromium's Windows disk cache can fail before the overall path reaches 260.
const MAX_WINDOWS_PROFILE_PATH = 110;
const bindings = new WeakMap();
const normalize = value => path.resolve(value).toLowerCase();

export const prepareBrowserProfileLaunchPath = (
  profileDir,
  { platform = process.platform, tempDir = os.tmpdir() } = {}
) => {
  const managedPath = path.resolve(profileDir);
  if (platform !== 'win32' || managedPath.length <= MAX_WINDOWS_PROFILE_PATH) {
    return Object.freeze({ managedPath, launchPath: managedPath });
  }
  fs.mkdirSync(managedPath, { recursive: true });
  if (fs.lstatSync(managedPath).isSymbolicLink() || !fs.lstatSync(managedPath).isDirectory()) {
    throw new Error('浏览器档案不是受控实体目录');
  }
  const realManagedPath = fs.realpathSync(managedPath);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tempDir), 'fb-'));
  const launchPath = path.join(root, path.basename(managedPath));
  try {
    if (launchPath.length > MAX_WINDOWS_PROFILE_PATH) {
      throw new Error('Windows 临时目录过长，请使用较短的 TEMP 目录后重试');
    }
    fs.symlinkSync(realManagedPath, launchPath, 'junction');
    const binding = Object.freeze({ managedPath, launchPath });
    bindings.set(binding, { root, realManagedPath });
    return binding;
  } catch (error) {
    fs.rmdirSync(root);
    throw error;
  }
};

/** Only a binding created here and still pointing at this profile may match PIDs. */
export const getBrowserProfileProcessPaths = (binding, managedPath) => {
  if (!binding || normalize(binding.managedPath) !== normalize(managedPath)) {
    throw new Error('浏览器启动目录与受控档案不一致');
  }
  const state = bindings.get(binding);
  if (!state) {
    if (binding.launchPath !== binding.managedPath) throw new Error('浏览器启动目录绑定无效');
    return [managedPath];
  }
  if (
    !fs.lstatSync(state.root).isDirectory() ||
    fs.lstatSync(state.root).isSymbolicLink() ||
    !fs.lstatSync(binding.launchPath).isSymbolicLink() ||
    normalize(fs.realpathSync(binding.launchPath)) !== normalize(state.realManagedPath) ||
    normalize(fs.realpathSync(managedPath)) !== normalize(state.realManagedPath)
  ) {
    throw new Error('浏览器临时启动目录绑定已改变，已阻止进程清理与档案同步');
  }
  return [managedPath, binding.launchPath];
};

export const browserCommandUsesProfile = (command, managedPaths) => {
  const match = String(command || '').match(
    /(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s]+))/i
  );
  if (!match) return false;
  const supplied = (match[1] || match[2] || match[3]).replace(/\//g, '\\').toLowerCase();
  if (managedPaths.some(dir => supplied === dir.replace(/\//g, '\\').toLowerCase())) return true;
  // A restarted application no longer has the in-memory temporary junction
  // binding. Resolve the supplied path before concluding the old process stopped.
  try {
    const actual = normalize(fs.realpathSync(match[1] || match[2] || match[3]));
    return managedPaths.some(dir => actual === normalize(fs.realpathSync(dir)));
  } catch { return false; }

};

/** Call only after the owning instance has confirmed that Chromium has stopped. */
export const releaseBrowserProfileLaunchPath = binding => {
  const state = binding && bindings.get(binding);
  if (!state) return;
  getBrowserProfileProcessPaths(binding, binding.managedPath);
  // unlink removes the junction itself; it never recursively visits user data.
  fs.unlinkSync(binding.launchPath);
  fs.rmdirSync(state.root);
  bindings.delete(binding);
};
