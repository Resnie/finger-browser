const PLATFORM_BY_OS_PREFIX = [
  ['Windows NT', 'Win32'],
  ['Mac OS X', 'MacIntel'],
  ['Linux', 'Linux x86_64'],
];

const WEBGL_DEFAULTS = Object.freeze({
  Win32: Object.freeze({
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  }),
  MacIntel: Object.freeze({
    vendor: 'Google Inc. (Apple)',
    renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
  }),
  'Linux x86_64': Object.freeze({
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)',
  }),
});

const getPlatformForOperatingSystem = operatingSystem => {
  const value = String(operatingSystem || '').trim();
  return PLATFORM_BY_OS_PREFIX.find(([prefix]) => value.startsWith(prefix))?.[1] || '';
};

const normalizeVersion = value => {
  const version = String(value || '').trim();
  return /^\d{1,4}(?:\.\d{1,8}){0,3}$/.test(version) ? version : '';
};

/**
 * 仅从特征明确的桌面 UA 推断 navigator.platform。
 * Android/iOS 虽然可能含有 Linux 或 Mac OS X 字样，但不能映射为桌面平台。
 */
export const inferPlatformFromUserAgent = userAgent => {
  const value = String(userAgent || '');
  const isMobile = /\bAndroid\b|\b(?:iPhone|iPad|iPod)\b/i.test(value);
  const matches = [
    /\bWindows NT\b/i.test(value) ? 'Win32' : '',
    /\bMacintosh\b/i.test(value) && /\bMac OS X\b/i.test(value) ? 'MacIntel' : '',
    !isMobile && /\bLinux\b/i.test(value) ? 'Linux x86_64' : '',
  ].filter(Boolean);

  return matches.length === 1 ? matches[0] : '';
};

/**
 * UA 是浏览器实际发送的身份，特征明确时优先于旧配置中的 platform。
 */
export const resolveNavigatorPlatform = (configuredPlatform, userAgent) =>
  inferPlatformFromUserAgent(userAgent) || String(configuredPlatform || '').trim();

export const extractChromiumVersion = userAgent =>
  String(userAgent || '').match(/\b(?:Chrome|Chromium)\/(\d{1,4}(?:\.\d{1,8}){0,3})\b/i)?.[1] || '';

/**
 * 内核清单偶尔省略最后一个版本段，因此按共同版本段比较，但至少比较主版本。
 */
export const areChromiumVersionsCompatible = (browserVersion, userAgent) => {
  const expected = normalizeVersion(browserVersion);
  const actual = normalizeVersion(extractChromiumVersion(userAgent));
  if (!expected || !actual) return false;

  const expectedParts = expected.split('.');
  const actualParts = actual.split('.');
  const sharedLength = Math.min(expectedParts.length, actualParts.length);
  return expectedParts.slice(0, sharedLength).every((part, index) => part === actualParts[index]);
};

export const getPlatformsForOperatingSystems = operatingSystems =>
  new Set(
    (Array.isArray(operatingSystems) ? operatingSystems : [])
      .map(getPlatformForOperatingSystem)
      .filter(Boolean)
  );

/**
 * 校验内核、UA、操作系统与 navigator.platform 是否描述同一个浏览器身份。
 */
export const validateFingerprintIdentity = ({
  browserVersion,
  operatingSystems,
  userAgent,
  platform,
} = {}) => {
  const inferredPlatform = inferPlatformFromUserAgent(userAgent);
  if (!inferredPlatform) {
    return { valid: false, code: 'unknown-platform', platform: '' };
  }
  if (!areChromiumVersionsCompatible(browserVersion, userAgent)) {
    return { valid: false, code: 'browser-version-mismatch', platform: inferredPlatform };
  }

  const allowedPlatforms = getPlatformsForOperatingSystems(operatingSystems);
  if (allowedPlatforms.size && !allowedPlatforms.has(inferredPlatform)) {
    return { valid: false, code: 'operating-system-mismatch', platform: inferredPlatform };
  }

  const configuredPlatform = String(platform || '').trim();
  if (configuredPlatform && configuredPlatform !== inferredPlatform) {
    return { valid: false, code: 'navigator-platform-mismatch', platform: inferredPlatform };
  }

  return { valid: true, code: '', platform: inferredPlatform };
};

const selectOperatingSystem = (operatingSystems, random = Math.random) => {
  const candidates = (Array.isArray(operatingSystems) ? operatingSystems : [])
    .map(name => ({ name: String(name || ''), platform: getPlatformForOperatingSystem(name) }))
    .filter(item => item.platform);
  if (!candidates.length) {
    return { name: 'Windows NT 10.0', osType: 'windows', platform: 'Win32' };
  }

  const sample = Number(random());
  const ratio = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.9999999999999999) : 0;
  const selected = candidates[Math.floor(ratio * candidates.length)];
  return {
    ...selected,
    osType:
      selected.platform === 'MacIntel'
        ? 'macos'
        : selected.platform === 'Linux x86_64'
          ? 'linux'
          : 'windows',
  };
};

/**
 * 由内核和系统一次性生成 UA/platform，避免界面分别更新形成短暂或持久的不一致。
 */
export const createChromiumFingerprintIdentity = ({
  browserVersion,
  operatingSystems,
  language,
  generateUserAgent,
  random = Math.random,
} = {}) => {
  if (!normalizeVersion(browserVersion)) throw new Error('请先选择有效的浏览器内核版本');
  if (typeof generateUserAgent !== 'function') throw new TypeError('缺少 User-Agent 生成器');

  const selectedOS = selectOperatingSystem(operatingSystems, random);
  const userAgent = generateUserAgent({
    os: selectedOS.osType,
    osName: selectedOS.name,
    browserVersion,
    language,
  });
  const validation = validateFingerprintIdentity({
    browserVersion,
    operatingSystems: [selectedOS.name],
    userAgent,
    platform: selectedOS.platform,
  });
  if (!validation.valid) throw new Error(`生成的指纹身份无效：${validation.code}`);

  return { userAgent, platform: validation.platform, operatingSystem: selectedOS.name };
};

/**
 * WebGL 留空时按最终 navigator.platform 选择成对的默认值。
 */
export const resolveWebGLIdentity = ({ platform, userAgent, vendor, renderer } = {}) => {
  const resolvedPlatform = resolveNavigatorPlatform(platform, userAgent);
  const defaults = WEBGL_DEFAULTS[resolvedPlatform] || WEBGL_DEFAULTS.Win32;
  return {
    platform: resolvedPlatform,
    vendor: String(vendor || '').trim() || defaults.vendor,
    renderer: String(renderer || '').trim() || defaults.renderer,
  };
};
