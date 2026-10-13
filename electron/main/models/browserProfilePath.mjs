import fs from 'fs';
import path from 'path';

const SAFE_INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_OWNER_ID = /^[1-9][0-9]{0,19}$/;

const assertSegment = (value, pattern, label) => {
  const normalized = String(value ?? '');
  if (!pattern.test(normalized)) throw new Error(`${label}格式无效`);
  return normalized;
};

const assertManagedPath = (root, candidate, browserId) => {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`) || path.basename(resolved) !== browserId) {
    throw new Error('浏览器 profile 路径超出受控目录');
  }
  return resolved;
};

export const resolveBrowserProfilePaths = (appPath, browserId, ownerId) => {
  if (typeof appPath !== 'string' || !appPath) throw new Error('应用数据目录无效');
  const id = assertSegment(browserId, SAFE_INSTANCE_ID, '浏览器实例 ID');
  const owner = assertSegment(ownerId, SAFE_OWNER_ID, '浏览器用户 ID');
  const root = path.resolve(appPath, 'browser-data');
  const ownerRoot = path.resolve(root, `u${owner}`);
  const owned = assertManagedPath(root, path.join(ownerRoot, id), id);
  const legacy = assertManagedPath(root, path.join(root, id), id);
  return { root, ownerRoot, owned, legacy };
};

const assertRealDirectory = (target, label) => {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label}不是受控实体目录，已阻止操作`);
  }
};

const assertRealPathWithin = (root, target, label) => {
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(target);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`${label}真实路径超出受控目录`);
  }
};

const prepareVerifiedRoots = (paths, { createOwner = false } = {}) => {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  assertRealDirectory(paths.root, '浏览器 profile 根目录');
  if (process.platform !== 'win32') fs.chmodSync(paths.root, 0o700);

  if (createOwner) fs.mkdirSync(paths.ownerRoot, { recursive: false, mode: 0o700 });
  if (fs.existsSync(paths.ownerRoot)) {
    assertRealDirectory(paths.ownerRoot, '浏览器 owner 目录');
    assertRealPathWithin(paths.root, paths.ownerRoot, '浏览器 owner 目录');
    if (process.platform !== 'win32') fs.chmodSync(paths.ownerRoot, 0o700);
  }
};

/** 仅在主进程已向服务端确认 browser 归属后调用。 */
export const prepareOwnedBrowserProfile = (appPath, browserId, ownerId) => {
  const paths = resolveBrowserProfilePaths(appPath, browserId, ownerId);
  prepareVerifiedRoots(paths, { createOwner: !fs.existsSync(paths.ownerRoot) });

  if (!fs.existsSync(paths.owned) && fs.existsSync(paths.legacy)) {
    assertRealDirectory(paths.legacy, '旧浏览器 profile');
    assertRealPathWithin(paths.root, paths.legacy, '旧浏览器 profile');
    fs.renameSync(paths.legacy, paths.owned);
  }
  if (fs.existsSync(paths.owned)) {
    assertRealDirectory(paths.owned, '浏览器 profile');
    assertRealPathWithin(paths.root, paths.owned, '浏览器 profile');
    if (process.platform !== 'win32') fs.chmodSync(paths.owned, 0o700);
  }
  return paths.owned;
};

/** 服务端删除成功后，只清理经严格路径校验的当前 owner profile。 */
export const removeOwnedBrowserProfiles = (appPath, browserId, ownerId) => {
  const paths = resolveBrowserProfilePaths(appPath, browserId, ownerId);
  prepareVerifiedRoots(paths);
  let changed = false;
  for (const [target, label] of [
    [paths.owned, '浏览器 profile'],
    [paths.legacy, '旧浏览器 profile'],
  ]) {
    if (!fs.existsSync(target)) continue;
    assertRealDirectory(target, label);
    assertRealPathWithin(paths.root, target, label);
    fs.rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
    changed = true;
  }
  try {
    if (fs.existsSync(paths.ownerRoot) && fs.readdirSync(paths.ownerRoot).length === 0) {
      fs.rmdirSync(paths.ownerRoot);
    }
  } catch {
    // owner 目录仍有其他实例或被系统占用时保留。
  }
  return changed;
};

export const listOwnedBrowserProfileIds = (appPath, ownerId) => {
  // 用合法占位 ID 复用根目录解析与祖先符号链接校验。
  const paths = resolveBrowserProfilePaths(appPath, 'profile-scan', ownerId);
  prepareVerifiedRoots(paths);
  if (!fs.existsSync(paths.ownerRoot)) return [];
  return fs
    .readdirSync(paths.ownerRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => entry.name)
    .filter(id => SAFE_INSTANCE_ID.test(id))
    .filter(id => {
      const target = path.join(paths.ownerRoot, id);
      assertRealDirectory(target, '浏览器 profile');
      assertRealPathWithin(paths.root, target, '浏览器 profile');
      return true;
    })
    .sort();
};
