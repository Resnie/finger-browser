import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';

// 获取当前模块的目录
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite 在构建主进程时会将这两个值静态替换进产物。
// 生产包因此不再依赖未被 electron-builder 打包的 .env.production。
const isProductionBuild = import.meta.env.PROD;
const injectedApiBaseUrl = import.meta.env.VITE_APP_BASE_API;

const RUNTIME_CONFIG_KEYS = [
  'VITE_APP_BASE_API',
  'PROJECT_WIN_BASE_PATH',
  'PROJECT_MAC_BASE_PATH',
  'PROJECT_CACHE_PATH',
  'PROJECT_LOGS_PATH',
  'RSA_PUBLIC_KEY',
  'RSA_PRIVATE_KEY',
];

/**
 * 解析 .env 文件内容
 * @param {string} content - 文件内容
 * @returns {Object} 解析后的键值对
 */
const parseEnvFile = content => {
  const result = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trim();
    // 跳过空行和注释
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const equalIndex = trimmedLine.indexOf('=');
    if (equalIndex > 0) {
      const key = trimmedLine.substring(0, equalIndex).trim();
      let value = trimmedLine.substring(equalIndex + 1).trim();

      // 移除引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      result[key] = value;
    }
  }

  return result;
};

/**
 * 加载环境配置
 * @returns {Object} 环境配置
 */
const loadEnvConfig = () => {
  let fileConfig = {};

  // 开发态仍支持直接读取项目根目录的 .env，方便本地调试。
  // 打包态禁止此回退，避免因运行目录不同而误用开发配置。
  if (!isProductionBuild) {
    const projectRoot = path.resolve(__dirname, '../..');
    const localEnvPath = path.join(projectRoot, '.env.local');
    const envFilePath = path.join(projectRoot, '.env.development');
    const fallbackEnvPath = path.join(projectRoot, '.env');

    try {
      if (fs.existsSync(localEnvPath)) {
        fileConfig = parseEnvFile(fs.readFileSync(localEnvPath, 'utf-8'));
      } else if (fs.existsSync(envFilePath)) {
        fileConfig = parseEnvFile(fs.readFileSync(envFilePath, 'utf-8'));
      } else if (fs.existsSync(fallbackEnvPath)) {
        fileConfig = parseEnvFile(fs.readFileSync(fallbackEnvPath, 'utf-8'));
      }
    } catch (error) {
      console.error(`读取开发环境配置文件失败: ${error.message}`);
    }
  }

  // PROJECT_/RSA_ 只允许由显式运行时环境变量覆盖；不将私钥内联进客户端。
  const runtimeConfig = {};
  for (const key of RUNTIME_CONFIG_KEYS) {
    if (process.env[key]) runtimeConfig[key] = process.env[key];
  }

  return {
    ...fileConfig,
    ...runtimeConfig,
    ...(injectedApiBaseUrl ? { VITE_APP_BASE_API: injectedApiBaseUrl } : {}),
  };
};

// 加载环境配置
const envConfig = loadEnvConfig();

/**
 * 获取项目基础路径
 * 优先使用 env 配置，否则使用默认路径
 */
export const getProjectBasePath = () => {
  const platform = os.platform();

  if (platform === 'win32') {
    // Windows
    const configPath = envConfig.PROJECT_WIN_BASE_PATH;
    if (configPath && fs.existsSync(path.dirname(configPath))) {
      return configPath;
    }
    // 默认路径
    return path.join(process.env.APPDATA || os.homedir(), 'finger-browser');
  } else if (platform === 'darwin') {
    // macOS
    const configPath = envConfig.PROJECT_MAC_BASE_PATH;
    if (configPath && fs.existsSync(path.dirname(configPath))) {
      return configPath;
    }
    // 默认路径
    return path.join(os.homedir(), 'Library', 'Application Support', 'finger-browser');
  } else {
    // Linux
    return path.join(os.homedir(), '.config', 'finger-browser');
  }
};

/**
 * 获取日志目录路径
 */
export const getLogsPath = () => {
  const basePath = getProjectBasePath();
  const logsSubPath = envConfig.PROJECT_LOGS_PATH || 'logs';
  return path.join(basePath, logsSubPath);
};

/**
 * 获取缓存目录路径
 */
export const getCachePath = () => {
  const basePath = getProjectBasePath();
  const cacheSubPath = envConfig.PROJECT_CACHE_PATH || 'cache';
  return path.join(basePath, cacheSubPath);
};

/**
 * 获取 API 基础 URL
 */
export const getApiBaseUrl = () => {
  const baseUrl = envConfig.VITE_APP_BASE_API || 'http://localhost:8888/api/v1';
  if (isProductionBuild) {
    const parsed = new URL(baseUrl);
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !isLoopback) {
      throw new Error('生产环境 API 必须使用 HTTPS');
    }
  }
  return baseUrl.replace(/\/$/, '');
};

/**
 * 获取 RSA 公钥（PEM 格式）
 */
export const getRsaPublicKey = () => {
  const base64 = envConfig.RSA_PUBLIC_KEY;
  if (!base64) return null;
  return `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`;
};

/**
 * 获取 RSA 私钥（PEM 格式）
 */
export const getRsaPrivateKey = () => {
  const base64 = envConfig.RSA_PRIVATE_KEY;
  if (!base64) return null;
  return `-----BEGIN RSA PRIVATE KEY-----\n${base64}\n-----END RSA PRIVATE KEY-----`;
};

/**
 * 导出原始环境配置
 */
export const getEnvConfig = () => ({ ...envConfig });

/**
 * 确保目录存在
 * @param {string} dirPath - 目录路径
 */
export const ensureDir = dirPath => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  // 邮件、日志等应用数据只应由当前系统用户访问。
  if (process.platform !== 'win32') {
    fs.chmodSync(dirPath, 0o700);
  }
  return dirPath;
};
