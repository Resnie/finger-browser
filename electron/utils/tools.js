import os from 'os';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import { logger } from './logger.js';
import { getProjectBasePath, ensureDir } from './config.js';

const toolsLogger = logger.createContextLogger('Tools');

/**
 * 获取应用数据存储路径
 * 使用 env 配置的路径
 */
export const getAppPath = () => {
  const appPath = getProjectBasePath();
  ensureDir(appPath);
  return appPath;
};

/**
 * 获取 JSON 数据
 * @param {string} url - 请求 URL
 * @returns {Promise<any>} JSON 数据
 */
export const fetchJsonData = async url => {
  try {
    toolsLogger.debug('正在获取 JSON 数据');
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    toolsLogger.error(`获取JSON数据失败: ${error.message}`);
    throw error;
  }
};

/**
 * 下载文件
 * @param {string} fileUrl - 文件 URL
 * @param {string} outputPath - 输出路径
 * @param {Function} progressFn - 进度回调函数
 * @param {Object} options - 可选配置
 * @param {AbortSignal} options.signal - 取消信号
 * @returns {Promise<string>} 输出路径
 */
export const downloadFile = async (fileUrl, outputPath, progressFn, options = {}) => {
  try {
    toolsLogger.info('开始下载文件');

    const response = await axios({
      method: 'get',
      url: fileUrl,
      responseType: 'stream',
      signal: options.signal,
      onDownloadProgress: progressEvent => {
        if (progressFn) {
          progressFn(progressEvent);
        }
      },
    });

    await pipeline(response.data, createWriteStream(outputPath));
    toolsLogger.info('下载完成');
    return outputPath;
  } catch (error) {
    // 处理取消下载
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
      toolsLogger.info('下载已取消');
      // 清理部分下载的文件
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      const cancelError = new Error('DOWNLOAD_CANCELLED');
      cancelError.code = 'DOWNLOAD_CANCELLED';
      throw cancelError;
    }
    toolsLogger.error(`下载失败: ${error.message}`);
    throw error;
  }
};

/**
 * 解压缩文件
 * @param {string} zipPath - ZIP 文件路径
 * @param {string} extractDir - 解压目录
 * @returns {Promise<string>} 解压目录
 */
export const extractFile = async (zipPath, extractDir) => {
  try {
    toolsLogger.info(`开始解压缩: ${zipPath}`);
    const zip = new AdmZip(zipPath);
    let totalUncompressedSize = 0;
    for (const entry of zip.getEntries()) {
      const entryName = entry.entryName.replace(/\\/g, '/');
      const normalized = path.posix.normalize(entryName);
      if (
        !entryName ||
        entryName.includes('\0') ||
        entryName.startsWith('/') ||
        /^[A-Za-z]:\//.test(entryName) ||
        normalized === '..' ||
        normalized.startsWith('../')
      ) {
        throw new Error('压缩包包含非法路径');
      }
      totalUncompressedSize += Number(entry.header?.size) || 0;
      if (totalUncompressedSize > 4 * 1024 * 1024 * 1024) {
        throw new Error('压缩包解压后体积异常');
      }
    }
    zip.extractAllTo(extractDir, true, true);
    toolsLogger.info(`解压缩完成，文件保存至: ${extractDir}`);
    return extractDir;
  } catch (error) {
    toolsLogger.error(`解压缩失败: ${error.message}`);
    throw error;
  }
};

/**
 * 递归删除文件夹及其内容
 * @param {string} folderPath - 文件夹路径
 */
export const deleteFolderRecursive = folderPath => {
  if (!folderPath || !fs.existsSync(folderPath)) return;
  // fs.rmSync 会删除符号链接本身，不会沿链接递归到目录外。
  fs.rmSync(folderPath, { recursive: true, force: true });
};

/**
 * 计算文件夹大小
 * @param {string} folderPath - 文件夹路径
 * @returns {number} 文件夹大小（字节）
 */
export const getFolderSize = folderPath => {
  let totalSize = 0;

  if (!fs.existsSync(folderPath)) {
    return 0;
  }

  const files = fs.readdirSync(folderPath);
  for (const file of files) {
    const curPath = path.join(folderPath, file);
    const stat = fs.lstatSync(curPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      totalSize += getFolderSize(curPath);
    } else {
      totalSize += stat.size;
    }
  }
  return totalSize;
};
