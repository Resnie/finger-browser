import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PORTABLE_PROFILE_VERSION = 1;
export const PORTABLE_PROFILE_LIMITS = Object.freeze({
  files: 2000,
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
  preferenceBytes: 1024 * 1024,
  pathLength: 512,
  extensions: 50,
});

// 不复制 Local State、Cookie/Login Data 密文库、Secure Preferences 或磁盘HTTP缓存。
// 文件格式由同一内核读取；登录态仍由标准 Cookie/IDB 协议恢复。
const SINGLE_FILES = ['Default/Bookmarks', 'Default/Bookmarks.bak'];
const DIRECTORY_ROOTS = [
  'Default/File System',
  'Default/Storage',
  'Default/Service Worker/CacheStorage',
  'Default/Service Worker/Database',
  'Default/Service Worker/ScriptCache',
  'Default/Extensions',
  'Default/Local Extension Settings',
  'Default/Sync Extension Settings',
  'Default/Extension State',
  'Default/Extension Rules',
  'Default/Extension Scripts',
];
const SAFE_EXTENSION_ID = /^[a-p]{32}$/;
const SAFE_EXTENSION_VERSION = /^\d+(?:\.\d+){0,3}(?:_\d+)?$/;
const NATIVE_EXTENSION_FILE = /\.(?:exe|dll|dylib|so|node|app|com|bat|cmd|ps1)$/i;
// Win32设备名在任意目录中都保留，带扩展名也不会成为普通文件。
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });
const plain = value =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Chromium可向前升级档案格式，已升级的档案不能交给旧内核读取。
export const canRestorePortableKernelVersion = (saved, current) => {
  if (!/^\d+(?:\.\d+){1,3}$/.test(saved || '') || !/^\d+(?:\.\d+){1,3}$/.test(current || ''))
    return false;
  const left = saved.split('.').map(Number);
  const right = current.split('.').map(Number);
  for (let index = 0; index < 4; index++) {
    const difference = (right[index] || 0) - (left[index] || 0);
    if (difference) return difference > 0;
  }
  return true;
};

export const isPortableProfilePath = value => {
  if (
    typeof value !== 'string' ||
    value.length > PORTABLE_PROFILE_LIMITS.pathLength ||
    !value ||
    /[\\\0-\x1f\x7f:<>"|?*]/.test(value)
  )
    return false;
  const parts = value.split('/');
  if (
    parts.some(
      part =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        WINDOWS_DEVICE_NAME.test(part)
    )
  )
    return false;
  if (SINGLE_FILES.includes(value)) return true;
  if (!DIRECTORY_ROOTS.some(root => value.startsWith(`${root}/`))) return false;
  if (parts.at(-1) === 'LOCK' || parts.at(-1).startsWith('Singleton')) return false;
  if (value.startsWith('Default/Extensions/')) {
    if (
      !SAFE_EXTENSION_ID.test(parts[2]) ||
      !SAFE_EXTENSION_VERSION.test(parts[3] || '') ||
      parts.length < 5 ||
      NATIVE_EXTENSION_FILE.test(value)
    )
      return false;
  }
  if (
    /^Default\/(?:Local|Sync) Extension Settings\//.test(value) &&
    !SAFE_EXTENSION_ID.test(parts[2] || '')
  )
    return false;
  return true;
};

const normalizePermissions = value => {
  if (!plain(value)) return null;
  const result = { defaults: {}, exceptions: {} };
  for (const [kind, setting] of Object.entries(value.defaults || {})) {
    if (
      !/^[a-z_]{1,80}$/.test(kind) ||
      UNSAFE_OBJECT_KEYS.has(kind) ||
      !Number.isInteger(setting) ||
      setting < 0 ||
      setting > 5
    )
      return null;
    result.defaults[kind] = setting;
  }
  for (const [kind, patterns] of Object.entries(value.exceptions || {})) {
    if (!/^[a-z_]{1,80}$/.test(kind) || UNSAFE_OBJECT_KEYS.has(kind) || !plain(patterns))
      return null;
    const normalized = {};
    for (const [pattern, entry] of Object.entries(patterns)) {
      // 导出站点授权状态，省略设备标识、文件选择器本机路径及平台特定附加字段。
      if (
        !pattern ||
        UNSAFE_OBJECT_KEYS.has(pattern) ||
        pattern.length > 4096 ||
        /[\0-\x1f\x7f]/.test(pattern) ||
        !plain(entry) ||
        !Number.isInteger(entry.setting) ||
        entry.setting < 0 ||
        entry.setting > 5
      )
        return null;
      normalized[pattern] = { setting: entry.setting };
    }
    result.exceptions[kind] = normalized;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > PORTABLE_PROFILE_LIMITS.preferenceBytes)
    return null;
  return result;
};

export const extensionIdForPublicKey = key => {
  if (
    typeof key !== 'string' ||
    key.length < 16 ||
    key.length > 16 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(key)
  )
    return null;
  const bytes = Buffer.from(key, 'base64');
  if (bytes.toString('base64') !== key) return null;
  return hash(bytes)
    .slice(0, 32)
    .replace(/[0-9a-f]/g, char => String.fromCharCode('a'.charCodeAt(0) + parseInt(char, 16)));
};

/** 严格校验整个信封，任何坏文件都会让整份快照失效，避免部分恢复。 */
export const normalizePortableProfile = value => {
  try {
    if (
      !plain(value) ||
      value.version !== PORTABLE_PROFILE_VERSION ||
      !/^\d+(?:\.\d+){1,3}$/.test(value.kernelVersion || '') ||
      !Number.isSafeInteger(value.capturedAt) ||
      value.capturedAt < 0 ||
      !Array.isArray(value.files) ||
      value.files.length > PORTABLE_PROFILE_LIMITS.files ||
      !Array.isArray(value.extensions) ||
      value.extensions.length > PORTABLE_PROFILE_LIMITS.extensions
    )
      return null;
    const permissions = normalizePermissions(value.permissions);
    if (!permissions) return null;
    const files = [];
    const seen = new Set();
    let totalBytes = 0;
    for (const item of value.files) {
      if (
        !plain(item) ||
        !isPortableProfilePath(item.path) ||
        seen.has(item.path.toLowerCase()) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        item.bytes > PORTABLE_PROFILE_LIMITS.fileBytes ||
        typeof item.data !== 'string' ||
        item.data.length !== Math.ceil(item.bytes / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data) ||
        !/^[a-f0-9]{64}$/.test(item.sha256 || '')
      )
        return null;
      totalBytes += item.bytes;
      if (totalBytes > PORTABLE_PROFILE_LIMITS.totalBytes) return null;
      const bytes = Buffer.from(item.data, 'base64');
      if (
        bytes.length !== item.bytes ||
        bytes.toString('base64') !== item.data ||
        hash(bytes) !== item.sha256
      )
        return null;
      const lowerPath = item.path.toLowerCase();
      for (const other of seen) {
        if (other.startsWith(`${lowerPath}/`) || lowerPath.startsWith(`${other}/`)) return null;
      }
      seen.add(item.path.toLowerCase());
      files.push({ path: item.path, bytes: item.bytes, sha256: item.sha256, data: item.data });
    }
    const extensions = [];
    const extensionIds = new Set();
    for (const entry of value.extensions) {
      if (
        !plain(entry) ||
        !SAFE_EXTENSION_ID.test(entry.id || '') ||
        !SAFE_EXTENSION_VERSION.test(entry.directoryVersion || '') ||
        typeof entry.enabled !== 'boolean' ||
        extensionIdForPublicKey(entry.publicKey) !== entry.id ||
        extensionIds.has(entry.id)
      )
        return null;
      const manifestPath = `Default/Extensions/${entry.id}/${entry.directoryVersion}/manifest.json`;
      const manifestFile = files.find(file => file.path === manifestPath);
      if (!manifestFile) return null;
      const manifest = JSON.parse(Buffer.from(manifestFile.data, 'base64').toString('utf8'));
      if (
        !plain(manifest) ||
        manifest.key !== entry.publicKey ||
        manifest.manifest_version !== 3 ||
        [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].includes(
          'nativeMessaging'
        )
      )
        return null;
      extensionIds.add(entry.id);
      extensions.push({
        id: entry.id,
        directoryVersion: entry.directoryVersion,
        publicKey: entry.publicKey,
        enabled: entry.enabled,
      });
    }
    // 扩展代码必须有对应且ID稳定的加载描述，不接受游离代码。
    for (const file of files) {
      if (file.path.startsWith('Default/Extensions/') && !extensionIds.has(file.path.split('/')[2]))
        return null;
    }
    return {
      version: PORTABLE_PROFILE_VERSION,
      kernelVersion: value.kernelVersion,
      capturedAt: value.capturedAt,
      permissions,
      extensions,
      files,
    };
  } catch {
    return null;
  }
};

const statOrNull = async target => {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const ensureRealPath = async (root, relative, { createParents = false } = {}) => {
  const rootStat = await statOrNull(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw failure('PORTABLE_PROFILE_UNSAFE_PATH', '浏览器档案根目录不是实体目录');
  }
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let stat = await statOrNull(current);
    if (!stat && createParents && current !== path.join(root, ...relative.split('/'))) {
      await fs.mkdir(current, { mode: 0o700 });
      stat = await fs.lstat(current);
    }
    if (stat?.isSymbolicLink())
      throw failure('PORTABLE_PROFILE_UNSAFE_PATH', '浏览器档案含符号链接，已阻止读取或恢复');
    if (stat && current !== path.join(root, ...relative.split('/')) && !stat.isDirectory()) {
      throw failure('PORTABLE_PROFILE_UNSAFE_PATH', '浏览器档案祖先路径不是目录');
    }
  }
  return current;
};

const assertTreeSafe = async target => {
  const stat = await statOrNull(target);
  if (!stat) return;
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw failure('PORTABLE_PROFILE_UNSAFE_PATH', '浏览器档案含非普通文件，已阻止操作');
  }
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(target)) await assertTreeSafe(path.join(target, name));
  }
};

const readPreferences = async (root, relative = 'Default/Preferences') => {
  const target = await ensureRealPath(root, relative);
  const stat = await statOrNull(target);
  if (!stat) return {};
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
    throw new Error('浏览器站点设置格式无效或过大');
  return JSON.parse(await fs.readFile(target, 'utf8'));
};

const permissionSnapshot = preferences => {
  const profile = preferences.profile || {};
  const defaults = profile.default_content_setting_values || {};
  const exceptions = {};
  for (const [kind, entries] of Object.entries(profile.content_settings?.exceptions || {})) {
    if (!plain(entries)) continue;
    const selected = {};
    for (const [pattern, value] of Object.entries(entries)) {
      if (Number.isInteger(value?.setting)) selected[pattern] = { setting: value.setting };
    }
    if (Object.keys(selected).length) exceptions[kind] = selected;
  }
  return normalizePermissions({ defaults, exceptions });
};

/** 仅在调用方确认整个 Chromium 进程树退出后采集磁盘数据。 */
export const capturePortableProfile = async ({ profileDir, kernelVersion, assertStopped }) => {
  if (typeof assertStopped !== 'function' || (await assertStopped()) !== true) {
    throw failure('PORTABLE_PROFILE_ACTIVE', '浏览器尚未完全退出，暂不能采集完整档案');
  }
  const preferences = await readPreferences(profileDir);
  const permissions = permissionSnapshot(preferences);
  if (!permissions) throw new Error('浏览器站点权限数据超限或无效');
  const files = [];
  let totalBytes = 0;
  const addFile = async relative => {
    if (!isPortableProfilePath(relative)) {
      if (relative.startsWith('Default/Extensions/') && NATIVE_EXTENSION_FILE.test(relative)) {
        throw failure(
          'PORTABLE_PROFILE_UNSUPPORTED_EXTENSION',
          '扩展包含依赖本机系统的原生组件，无法跨电脑恢复'
        );
      }
      if (path.posix.basename(relative) === 'LOCK') return;
      throw failure('PORTABLE_PROFILE_UNSAFE_PATH', '浏览器档案文件路径无法安全移植');
    }
    const target = await ensureRealPath(profileDir, relative);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('浏览器档案含非普通文件');
    totalBytes += stat.size;
    if (
      stat.size > PORTABLE_PROFILE_LIMITS.fileBytes ||
      totalBytes > PORTABLE_PROFILE_LIMITS.totalBytes ||
      files.length >= PORTABLE_PROFILE_LIMITS.files
    ) {
      throw failure(
        'PORTABLE_PROFILE_TOO_LARGE',
        '浏览器完整档案超过同步限制（单文件4MB，总计12MB或2000文件），请清理大文件后重新关闭窗口'
      );
    }
    const bytes = await fs.readFile(target);
    files.push({
      path: relative,
      bytes: bytes.length,
      sha256: hash(bytes),
      data: bytes.toString('base64'),
    });
  };
  const visit = async relative => {
    const target = await ensureRealPath(profileDir, relative);
    const stat = await statOrNull(target);
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(target)).sort()) await visit(`${relative}/${name}`);
    } else await addFile(relative);
  };
  for (const relative of [...SINGLE_FILES, ...DIRECTORY_ROOTS]) await visit(relative);
  const extensions = [];
  const manifestFiles = files.filter(file =>
    /^Default\/Extensions\/[a-p]{32}\/[^/]+\/manifest\.json$/.test(file.path)
  );
  // 只读取公开manifest.key，绝不上传Secure Preferences的设备保护哈希。
  const securePreferences = manifestFiles.length
    ? await readPreferences(profileDir, 'Default/Secure Preferences')
    : {};
  const extensionsByID = new Map();
  for (const file of manifestFiles) {
    const [, , id, directoryVersion] = file.path.split('/');
    const manifest = JSON.parse(Buffer.from(file.data, 'base64').toString('utf8'));
    if (
      manifest.manifest_version !== 3 ||
      [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].includes(
        'nativeMessaging'
      )
    ) {
      throw failure(
        'PORTABLE_PROFILE_UNSUPPORTED_EXTENSION',
        '扩展使用旧Manifest版本或本机原生通信，无法跨电脑恢复，请移除此扩展后重新关闭窗口'
      );
    }
    const publicKey =
      manifest.key ||
      preferences.extensions?.settings?.[id]?.manifest?.key ||
      securePreferences.extensions?.settings?.[id]?.manifest?.key;
    const settings =
      securePreferences.extensions?.settings?.[id] || preferences.extensions?.settings?.[id] || {};
    const enabled =
      (settings.state === 1 ||
        (settings.state === undefined && Object.hasOwn(settings, 'disable_reasons'))) &&
      (!settings.disable_reasons ||
        settings.disable_reasons === 0 ||
        (Array.isArray(settings.disable_reasons) && settings.disable_reasons.length === 0));
    if (extensionIdForPublicKey(publicKey) !== id) {
      throw failure(
        'PORTABLE_PROFILE_UNSUPPORTED_EXTENSION',
        '浏览器扩展缺少稳定公开标识，无法保证换电脑后扩展数据一致，请移除此扩展后重新关闭窗口'
      );
    }
    manifest.key = publicKey;
    const bytes = Buffer.from(JSON.stringify(manifest));
    file.bytes = bytes.length;
    file.data = bytes.toString('base64');
    file.sha256 = hash(bytes);
    const previous = extensionsByID.get(id);
    if (
      !previous ||
      directoryVersion.localeCompare(previous.directoryVersion, undefined, { numeric: true }) > 0
    ) {
      extensionsByID.set(id, { id, directoryVersion, publicKey, enabled });
    }
  }
  extensions.push(...extensionsByID.values());
  if ((await assertStopped()) !== true)
    throw failure('PORTABLE_PROFILE_ACTIVE', '浏览器在采集时重新启动，档案未同步');
  const result = normalizePortableProfile({
    version: 1,
    kernelVersion,
    capturedAt: Date.now(),
    permissions,
    extensions,
    files,
  });
  if (!result) throw failure('PORTABLE_PROFILE_INVALID', '浏览器完整档案格式无效或超过同步限制');
  return result;
};

/** 在内核启动前，以服务端完整快照权威替换白名单目录。 */
export const restorePortableProfile = async ({
  profileDir,
  kernelVersion,
  snapshot,
  assertStopped,
}) => {
  const normalized = normalizePortableProfile(snapshot);
  if (!normalized) throw failure('PORTABLE_PROFILE_INVALID', '云端浏览器完整档案格式无效');
  if (!canRestorePortableKernelVersion(normalized.kernelVersion, kernelVersion)) {
    throw failure(
      'PORTABLE_PROFILE_VERSION_DOWNGRADE',
      `完整档案已使用内核 ${normalized.kernelVersion}，请选择同版本或更高版本后打开窗口，降级会损坏浏览数据`
    );
  }
  if (typeof assertStopped !== 'function' || (await assertStopped()) !== true) {
    throw failure('PORTABLE_PROFILE_ACTIVE', '浏览器仍在运行，暂不能恢复完整档案');
  }
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  // 先完整预检查，发现符号链接时不删除任何已有数据。
  for (const relative of [
    ...SINGLE_FILES,
    ...DIRECTORY_ROOTS,
    'Default/Preferences',
    'Default/Secure Preferences',
  ]) {
    await assertTreeSafe(await ensureRealPath(profileDir, relative));
  }
  const preferences = await readPreferences(profileDir);
  const securePreferences = await readPreferences(profileDir, 'Default/Secure Preferences');
  preferences.profile = plain(preferences.profile) ? preferences.profile : {};
  preferences.profile.content_settings = plain(preferences.profile.content_settings)
    ? preferences.profile.content_settings
    : {};
  preferences.profile.content_settings.exceptions = normalized.permissions.exceptions;
  preferences.profile.default_content_setting_values = normalized.permissions.defaults;
  for (const relative of [...SINGLE_FILES, ...DIRECTORY_ROOTS]) {
    await fs.rm(await ensureRealPath(profileDir, relative), { recursive: true, force: true });
  }
  for (const file of normalized.files) {
    const target = await ensureRealPath(profileDir, file.path, { createParents: true });
    await fs.writeFile(target, Buffer.from(file.data, 'base64'), { mode: 0o600, flag: 'wx' });
  }
  // 只重建选定注册字段；保护哈希与OS密钥从未进入云快照。
  const extensionSettings = {};
  for (const entry of normalized.extensions) {
    const manifestFile = normalized.files.find(
      file => file.path === `Default/Extensions/${entry.id}/${entry.directoryVersion}/manifest.json`
    );
    extensionSettings[entry.id] = {
      state: entry.enabled ? 1 : 0,
      disable_reasons: entry.enabled ? [] : [1],
      path: path.join(profileDir, 'Default', 'Extensions', entry.id, entry.directoryVersion),
      location: 4,
      manifest: JSON.parse(Buffer.from(manifestFile.data, 'base64').toString('utf8')),
    };
  }
  for (const prefs of [preferences, securePreferences]) {
    prefs.extensions = plain(prefs.extensions) ? prefs.extensions : {};
    prefs.extensions.settings = structuredClone(extensionSettings);
  }
  const prefsPath = await ensureRealPath(profileDir, 'Default/Preferences', {
    createParents: true,
  });
  await fs.writeFile(prefsPath, JSON.stringify(preferences), { mode: 0o600 });
  const securePrefsPath = await ensureRealPath(profileDir, 'Default/Secure Preferences', {
    createParents: true,
  });
  await fs.writeFile(securePrefsPath, JSON.stringify(securePreferences), { mode: 0o600 });
  return normalized.extensions
    .filter(entry => entry.enabled)
    .map(entry => path.join(profileDir, 'Default', 'Extensions', entry.id, entry.directoryVersion));
};
