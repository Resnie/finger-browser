import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getAppPath,
  downloadFile,
  extractFile,
  deleteFolderRecursive,
  getFolderSize,
} from './tools.js';
import store from './store.js';
import api from './request.js';
import { logger } from './logger.js';
import { ipcEmitter } from '../main/ipc/emitter.js';
import {
  filterSupportedBrowserVersions,
  getBrowserDistribution,
  verifyBrowserArchive,
} from './browserDistribution.mjs';

const browserLogger = logger.createContextLogger('Browser');

// 版本会被用作目录名和下载文件名，必须在任何文件系统操作之前校验。
const SAFE_BROWSER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// 活跃安装任务跟踪。去重范围覆盖“下载 + 解压 + 验证”整个流程，
// 避免多个浏览器实例同时解压并删除同一个 ZIP。
const activeInstallations = new Map();

/**
 * 校验并返回浏览器版本。
 * @param {unknown} version
 * @returns {string}
 */
export const validateBrowserVersion = version => {
  if (typeof version !== 'string' || !SAFE_BROWSER_VERSION.test(version)) {
    throw new Error(`非法的浏览器版本: ${String(version)}`);
  }
  return version;
};

/**
 * 获取浏览器版本存储路径
 * @param {string} version - 浏览器版本号
 * @returns {string} 版本存储路径
 */
export const getBrowserVersionPath = version => {
  const safeVersion = validateBrowserVersion(version);
  return path.join(getAppPath(), 'browser', safeVersion);
};

/**
 * 获取指定版本浏览器的启动路径
 * 如果本地不存在则自动下载
 * @param {string} version - 浏览器版本号
 * @param {string} id - 实例 ID（用于进度通知）
 * @returns {Promise<string>} 浏览器可执行文件路径
 */
export const getVersionOfBrowserStartupPath = async (version, id) => {
  const safeVersion = validateBrowserVersion(version);
  browserLogger.debug(`检查浏览器版本: ${safeVersion}`);
  return ensureBrowserVersionInstalled(safeVersion, id);
};

/**
 * 安装指定版本的浏览器
 * @param {string} version - 浏览器版本号
 * @param {string} id - 实例 ID（用于进度通知）
 */
export const installBrowserVersion = async (version, id) => {
  const safeVersion = validateBrowserVersion(version);
  await ensureBrowserVersionInstalled(safeVersion, id);
};

/**
 * 获取指定版本浏览器的可执行文件路径
 * @param {string} version - 浏览器版本号
 * @returns {Promise<string>} 可执行文件路径
 */
export const getBrowserPathForVersion = async version => {
  const safeVersion = validateBrowserVersion(version);
  const browserVersionPath = getBrowserVersionPath(safeVersion);
  const platform = os.platform();

  if (platform === 'win32') {
    return path.join(browserVersionPath, 'chrome-win64', 'chrome.exe');
  } else if (platform === 'darwin') {
    return path.join(
      browserVersionPath,
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    );
  }

  throw new Error(`不支持的平台: ${platform}`);
};

/**
 * 检查版本是否在服务端公布的可用列表中。
 * 此校验必须早于删除目录、创建目录和下载文件。
 * @param {string} version - 浏览器版本号
 */
const assertBrowserVersionAvailable = version => {
  validateBrowserVersion(version);
  const versionData = store.get('browserVersions');
  if (!Array.isArray(versionData) || !versionData.includes(version)) {
    throw new Error(`请求的浏览器版本 ${version} 不存在`);
  }
};

/**
 * 执行单个版本的下载和安装。
 */
const performBrowserInstallation = async (version, record, id) => {
  const browserVersionPath = getBrowserVersionPath(version);
  const distribution = getBrowserDistribution(version, os.platform());
  const browserFile = path.join(browserVersionPath, 'chrome.zip');

  browserLogger.info(`开始下载内核版本 ${version}`);

  // 仅在版本白名单校验通过后才可清理目录。
  deleteFolderRecursive(browserVersionPath);
  fs.mkdirSync(browserVersionPath, { recursive: true });

  // 将实际下载地址通知前端
  ipcEmitter.emitDownloadProgress({
    progress: 0,
    version,
    id,
    subscribers: [...record.subscribers],
    speed: 0,
    loaded: 0,
    total: 0,
    estimated: 0,
  });

  record.stage = 'downloading';
  const browserZipPath = await downloadFile(
    distribution.url,
    browserFile,
    progressEvent => {
      const total = Number(progressEvent.total) || 0;
      const loaded = Number(progressEvent.loaded) || 0;
      const progress = total > 0 ? Math.round((loaded * 100) / total) : 0;
      ipcEmitter.emitDownloadProgress({
        progress,
        version,
        id,
        subscribers: [...record.subscribers],
        speed: progressEvent.rate || 0,
        loaded,
        total,
        estimated: progressEvent.estimated || 0,
      });
    },
    { signal: record.controller.signal }
  );

  record.stage = 'verifying';
  browserLogger.info(`校验内核版本 ${version} 的完整性`);
  await verifyBrowserArchive(browserZipPath, distribution.sha256);

  record.stage = 'extracting';
  return unzipBrowser(browserZipPath, version);
};

/**
 * 确保指定版本已完整安装，并返回可执行文件路径。
 */
const ensureBrowserVersionInstalled = async (version, id) => {
  const safeVersion = validateBrowserVersion(version);
  const browserPath = await getBrowserPathForVersion(safeVersion);

  // 先检查安装任务：解压过程中可执行文件可能已经出现，
  // 但其他运行文件尚未写完，不能因 existsSync 提前启动。
  const existing = activeInstallations.get(safeVersion);
  if (existing) {
    if (id) existing.subscribers.add(id);
    browserLogger.info(
      `版本 ${safeVersion} 正在${existing.stage === 'extracting' ? '解压' : '下载'}，` +
        `实例 ${id || '(内核)'} 加入等待队列`
    );
    ipcEmitter.emitDownloadStart({
      id,
      message: `浏览器版本 ${safeVersion} 正在安装中，等待完成...`,
      version: safeVersion,
      subscribers: [...existing.subscribers],
    });
    return existing.promise;
  }

  if (fs.existsSync(browserPath)) {
    browserLogger.info(`浏览器版本 ${safeVersion} 已安装`);
    return browserPath;
  }

  // 必须在 performBrowserInstallation 的任何文件操作之前完成。
  assertBrowserVersionAvailable(safeVersion);
  getBrowserDistribution(safeVersion, os.platform());

  const record = {
    controller: new AbortController(),
    subscribers: new Set(id ? [id] : []),
    stage: 'preparing',
    promise: null,
  };
  activeInstallations.set(safeVersion, record);

  ipcEmitter.emitDownloadStart({
    id,
    message: `浏览器版本 ${safeVersion} 不存在，开始下载...`,
    version: safeVersion,
    subscribers: [...record.subscribers],
  });

  record.promise = performBrowserInstallation(safeVersion, record, id)
    .catch(error => {
      if (error.code === 'DOWNLOAD_CANCELLED') {
        browserLogger.info(`浏览器版本 ${safeVersion} 下载已取消`);
      } else {
        ipcEmitter.emitDownloadError({
          version: safeVersion,
          subscribers: [...record.subscribers],
          message: error.message || '浏览器内核安装失败',
        });
      }
      try {
        deleteFolderRecursive(getBrowserVersionPath(safeVersion));
      } catch (cleanupError) {
        browserLogger.warn(`清理安装残留失败: ${cleanupError.message}`);
      }
      throw error;
    })
    .finally(() => {
      if (activeInstallations.get(safeVersion) === record) {
        activeInstallations.delete(safeVersion);
      }
    });

  return record.promise;
};

/**
 * 解压浏览器
 * @param {string} browserZipPath - ZIP 文件路径
 * @param {string} version - 浏览器版本号
 * @returns {Promise<string>} 浏览器可执行文件路径
 */
export const unzipBrowser = async (browserZipPath, version) => {
  const safeVersion = validateBrowserVersion(version);
  const browserVersionPath = getBrowserVersionPath(safeVersion);

  // 解压文件
  await extractFile(browserZipPath, browserVersionPath);

  // 获取浏览器路径
  const browserPath = await getBrowserPathForVersion(safeVersion);
  if (!fs.existsSync(browserPath)) {
    throw new Error(`浏览器内核解压不完整，未找到可执行文件: ${safeVersion}`);
  }

  if (process.platform !== 'win32') {
    fs.chmodSync(browserPath, 0o755);
  }

  // 先完成本地清理，再通知前端安装成功。
  fs.rmSync(browserZipPath, { force: true });

  // 发送下载完成通知
  ipcEmitter.emitDownloadComplete({
    message: `浏览器版本 ${safeVersion} 下载完成`,
    version: safeVersion,
  });

  return browserPath;
};

/**
 * 检测本地已安装的浏览器版本
 * @returns {Array<{version: string, size: number}>} 版本信息数组
 */
export const detectingLocalBrowsers = () => {
  const browserDir = path.join(getAppPath(), 'browser');

  if (!fs.existsSync(browserDir)) {
    fs.mkdirSync(browserDir, { recursive: true });
    return [];
  }

  const versions = fs
    .readdirSync(browserDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && SAFE_BROWSER_VERSION.test(dirent.name))
    .map(dirent => dirent.name);

  return versions.map(version => ({
    version,
    size: getFolderSize(getBrowserVersionPath(version)),
  }));
};

/**
 * 从 API 获取所有可用的浏览器版本
 * @returns {Promise<string[]>} 版本号数组
 */
export const getAllBrowserVersionsList = async () => {
  try {
    const res = await api.get('/browsers/versions');
    if (!Array.isArray(res)) {
      throw new Error('浏览器版本接口返回格式无效');
    }
    const versions = filterSupportedBrowserVersions(
      [
        ...new Set(
          res.filter(version => typeof version === 'string' && SAFE_BROWSER_VERSION.test(version))
        ),
      ],
      os.platform()
    );
    store.set('browserVersions', versions);
    return versions;
  } catch (error) {
    browserLogger.error(`获取浏览器版本列表失败: ${error.message}`);
    const cachedVersions = store.get('browserVersions', []);
    return Array.isArray(cachedVersions)
      ? filterSupportedBrowserVersions(
          cachedVersions.filter(version => SAFE_BROWSER_VERSION.test(version)),
          os.platform()
        )
      : [];
  }
};

/**
 * 从存储中获取已保存的浏览器版本
 * @returns {string[]} 版本号数组
 */
export const getBrowserForStore = () => {
  return store.get('browserVersions') || [];
};

/**
 * 初始化浏览器版本列表
 * @returns {Promise<string[]>} 版本号数组
 */
export const initBrowserVersions = async () => {
  browserLogger.info('初始化浏览器版本列表');
  return await getAllBrowserVersionsList();
};

/**
 * 判断本地是否已安装指定版本的浏览器
 * @param {string} version - 浏览器版本号
 * @returns {Promise<boolean>}
 */
export const isBrowserInstalled = async version => {
  const browserPath = await getBrowserPathForVersion(version);
  const exists = fs.existsSync(browserPath);
  browserLogger.debug(`检查浏览器路径: ${browserPath}, 存在: ${exists}`);
  return exists;
};

/**
 * 删除指定版本的浏览器
 * @param {string} version - 浏览器版本号
 */
export const removeBrowserVersion = version => {
  const safeVersion = validateBrowserVersion(version);
  if (activeInstallations.has(safeVersion)) {
    throw new Error(`浏览器版本 ${safeVersion} 正在安装，请先取消下载`);
  }
  const browserPath = getBrowserVersionPath(safeVersion);
  browserLogger.info(`删除浏览器版本: ${safeVersion}`);
  deleteFolderRecursive(browserPath);
};

/**
 * 取消指定版本的浏览器下载
 * @param {string} version - 浏览器版本号
 * @returns {boolean} 是否成功取消
 */
export const cancelBrowserDownload = version => {
  const safeVersion = validateBrowserVersion(version);
  const installation = activeInstallations.get(safeVersion);
  if (installation) {
    if (installation.stage === 'extracting') {
      browserLogger.warn(`浏览器版本 ${safeVersion} 已开始解压，无法安全取消`);
      return false;
    }

    browserLogger.info(`取消浏览器版本 ${safeVersion} 的下载`);
    installation.controller.abort();

    return true;
  }
  browserLogger.warn(`未找到版本 ${safeVersion} 的活跃下载`);
  return false;
};
