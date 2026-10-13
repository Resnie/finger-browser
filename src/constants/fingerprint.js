/**
 * 浏览器指纹配置常量
 */

import { inferPlatformFromUserAgent } from '../utils/fingerprintIdentity.mjs';

export { inferPlatformFromUserAgent };

// 时区选项
export const TIMEZONE_OPTIONS = [
  { value: 'auto', label: '自动（跟随系统）' },
  { value: 'Asia/Shanghai', label: '中国标准时间 (UTC+8)' },
  { value: 'Asia/Tokyo', label: '日本标准时间 (UTC+9)' },
  { value: 'Asia/Seoul', label: '韩国标准时间 (UTC+9)' },
  { value: 'Asia/Singapore', label: '新加坡标准时间 (UTC+8)' },
  { value: 'Asia/Hong_Kong', label: '香港标准时间 (UTC+8)' },
  { value: 'America/New_York', label: '美国东部时间 (UTC-5)' },
  { value: 'America/Los_Angeles', label: '美国太平洋时间 (UTC-8)' },
  { value: 'America/Chicago', label: '美国中部时间 (UTC-6)' },
  { value: 'Europe/London', label: '英国标准时间 (UTC+0)' },
  { value: 'Europe/Paris', label: '中欧标准时间 (UTC+1)' },
  { value: 'Europe/Berlin', label: '德国标准时间 (UTC+1)' },
  { value: 'Europe/Moscow', label: '莫斯科标准时间 (UTC+3)' },
  { value: 'Australia/Sydney', label: '澳大利亚东部时间 (UTC+10)' },
];

// 语言选项
export const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁体中文' },
  { value: 'en-US', label: '英语（美国）' },
  { value: 'en-GB', label: '英语（英国）' },
  { value: 'ja-JP', label: '日语' },
  { value: 'ko-KR', label: '韩语' },
  { value: 'de-DE', label: '德语' },
  { value: 'fr-FR', label: '法语' },
  { value: 'es-ES', label: '西班牙语' },
  { value: 'ru-RU', label: '俄语' },
  { value: 'pt-BR', label: '葡萄牙语（巴西）' },
  { value: 'it-IT', label: '意大利语' },
];

// 屏幕分辨率选项
export const SCREEN_RESOLUTION_OPTIONS = [
  { value: 'auto', label: '自动（跟随系统）' },
  { value: '1920x1080', label: '1920 x 1080 (Full HD)' },
  { value: '2560x1440', label: '2560 x 1440 (2K)' },
  { value: '3840x2160', label: '3840 x 2160 (4K)' },
  { value: '1366x768', label: '1366 x 768' },
  { value: '1440x900', label: '1440 x 900' },
  { value: '1536x864', label: '1536 x 864' },
  { value: '1280x720', label: '1280 x 720 (HD)' },
  { value: '1600x900', label: '1600 x 900' },
  { value: '1280x800', label: '1280 x 800' },
];

// CPU 核心数选项
export const HARDWARE_CONCURRENCY_OPTIONS = [
  { value: 0, label: '自动（跟随系统）' },
  { value: 2, label: '2 核心' },
  { value: 4, label: '4 核心' },
  { value: 6, label: '6 核心' },
  { value: 8, label: '8 核心' },
  { value: 12, label: '12 核心' },
  { value: 16, label: '16 核心' },
];

// 设备内存选项 (GB)
export const DEVICE_MEMORY_OPTIONS = [
  { value: 0, label: '自动（跟随系统）' },
  { value: 2, label: '2 GB' },
  { value: 4, label: '4 GB' },
  { value: 8, label: '8 GB' },
  { value: 16, label: '16 GB' },
  { value: 32, label: '32 GB' },
];

// WebRTC 设置选项
export const WEBRTC_OPTIONS = [
  { value: 'default', label: '默认' },
  { value: 'disable', label: '禁用 WebRTC' },
  { value: 'proxy_only', label: '仅使用代理 IP' },
  { value: 'public_only', label: '仅公开 IP（暂未支持）', disabled: true },
];

/**
 * 根据主语言生成与 HTTP locale 一致的 navigator.languages。
 * 保留语言本身和主语种，非英语环境再加入常用英语回退。
 */
export const getLanguagesForLocale = locale => {
  const normalized = String(locale || '').trim();
  if (!normalized) return [];
  const baseLanguage = normalized.split('-')[0];
  const values = [normalized, baseLanguage];
  if (baseLanguage.toLowerCase() !== 'en') values.push('en-US', 'en');
  return [...new Set(values.filter(Boolean))];
};

const getPlatformForOperatingSystem = operatingSystem => {
  const value = String(operatingSystem || '');
  if (value.startsWith('Mac OS X')) return 'MacIntel';
  if (value.startsWith('Windows NT')) return 'Win32';
  return '';
};

/**
 * 按界面中已选的操作系统生成 navigator.platform。
 * 混合选择 Windows/macOS 时没有唯一答案，留给实际生成的 UA 决定。
 */
export const getPlatformForOperatingSystems = operatingSystems => {
  const platforms = new Set(
    (Array.isArray(operatingSystems) ? operatingSystems : [])
      .map(getPlatformForOperatingSystem)
      .filter(Boolean)
  );
  return platforms.size === 1 ? [...platforms][0] : '';
};

/**
 * 从多选项中抽取一个真实的操作系统用于生成 UA，避免把混合家族传给生成器。
 * random 参数便于测试，界面中使用 Math.random。
 */
export const selectOperatingSystemForUserAgent = (operatingSystems, random = Math.random) => {
  const candidates = (Array.isArray(operatingSystems) ? operatingSystems : [])
    .map(value => String(value || ''))
    .filter(value => getPlatformForOperatingSystem(value));
  if (!candidates.length) return null;

  const sample = Number(random());
  const ratio = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.9999999999999999) : 0;
  const name = candidates[Math.floor(ratio * candidates.length)];
  const platform = getPlatformForOperatingSystem(name);
  return {
    name,
    osType: platform === 'MacIntel' ? 'macos' : 'windows',
    platform,
  };
};

/**
 * 恢复旧配置时优先信任特征明确的 UA，再使用同家族的操作系统选项。
 */
export const resolveFingerprintPlatform = ({ userAgent, operatingSystems, fallback = '' } = {}) =>
  inferPlatformFromUserAgent(userAgent) ||
  getPlatformForOperatingSystems(operatingSystems) ||
  String(fallback || '');

// 默认指纹配置
export const DEFAULT_FINGERPRINT_CONFIG = {
  autoFingerprint: true,
  // 基础指纹
  canvas: false,
  webgl: false,
  audioFingerprint: false,

  // 环境指纹
  timezone: 'auto',
  language: 'zh-CN',
  languages: getLanguagesForLocale('zh-CN'),
  platform: '',

  // 硬件指纹
  screenResolution: 'auto',
  colorDepth: 24,
  hardwareConcurrency: 0,
  deviceMemory: 0,

  // 网络指纹
  webRTC: 'default',
  doNotTrack: false,

  // 其他指纹
  fonts: 'default',
  plugins: 'default',

  // 新增指纹配置
  clientRects: false,
  batteryAPI: 'real',
  mediaDevices: 'real',
  webglVendor: '',
  webglRenderer: '',
};

// 操作系统选项
export const OPERATING_SYSTEM_OPTIONS = [
  { value: 'Windows NT 11.0', label: 'Windows 11' },
  { value: 'Windows NT 10.0', label: 'Windows 10' },
  { value: 'Windows NT 6.2', label: 'Windows 8' },
  { value: 'Windows NT 6.1', label: 'Windows 7' },
  { value: 'Mac OS X 14', label: 'macOS Sonoma' },
  { value: 'Mac OS X 13', label: 'macOS Ventura' },
  { value: 'Mac OS X 12', label: 'macOS Monterey' },
];

// 获取默认操作系统（根据当前系统）
export const getDefaultOperatingSystem = () => {
  const platform = navigator.platform?.toLowerCase() || '';
  if (platform.includes('win')) {
    return ['Windows NT 10.0'];
  } else if (platform.includes('mac')) {
    return ['Mac OS X 14'];
  }
  return ['Windows NT 10.0'];
};

// Battery API 选项
export const BATTERY_API_OPTIONS = [
  { value: 'real', label: '真实值' },
  { value: 'random', label: '随机值' },
  { value: 'disable', label: '禁用' },
];

// MediaDevices 选项
export const MEDIA_DEVICES_OPTIONS = [
  { value: 'real', label: '真实值' },
  { value: 'random', label: '随机值' },
  { value: 'disable', label: '禁用' },
];

// 字体指纹选项
export const FONT_OPTIONS = [
  { value: 'default', label: '默认（不修改）' },
  { value: 'limited', label: '限制字体列表' },
];

// 插件指纹选项
export const PLUGIN_OPTIONS = [
  { value: 'default', label: '默认（不修改）' },
  { value: 'limited', label: '限制插件列表' },
];
