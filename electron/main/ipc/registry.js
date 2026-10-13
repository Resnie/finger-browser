import { ipcMain } from 'electron';
import { logger } from '../../utils/logger.js';

const ipcLogger = logger.createContextLogger('IPC');

/**
 * IPC 处理器配置
 * @typedef {Object} IPCHandlerConfig
 * @property {string} channel - IPC 通道名称
 * @property {Function} handler - 处理函数
 * @property {string} [description] - 处理器描述（用于日志）
 */

/**
 * 创建带错误处理的 IPC 处理器包装函数
 * @param {Function} handler - 原始处理函数
 * @param {string} description - 处理器描述
 * @returns {Function} 包装后的处理函数
 */
export const withErrorHandling = (handler, description) => {
  return async (event, ...args) => {
    try {
      ipcLogger.debug(`执行: ${description}`);
      const result = await handler(event, ...args);
      return result;
    } catch (error) {
      ipcLogger.error(`${description} 失败: ${error.message}`);
      throw error;
    }
  };
};

/**
 * IPC 注册中心类
 * 统一管理所有 IPC 处理器的注册
 */
class IPCRegistry {
  constructor() {
    this.handlers = new Map();
    this.initialized = false;
  }

  /**
   * 注册单个 IPC 处理器
   * @param {string} channel - IPC 通道名称
   * @param {Function} handler - 处理函数
   * @param {string} [description] - 处理器描述
   */
  handle(channel, handler, description = channel) {
    if (this.handlers.has(channel)) {
      ipcLogger.warn(`IPC 通道 "${channel}" 已存在，将被覆盖`);
    }

    const wrappedHandler = withErrorHandling(handler, description);
    ipcMain.handle(channel, wrappedHandler);
    this.handlers.set(channel, { handler: wrappedHandler, description });

    ipcLogger.debug(`注册 IPC 处理器: ${channel}`);
  }

  /**
   * 批量注册 IPC 处理器
   * @param {IPCHandlerConfig[]} configs - 处理器配置数组
   */
  registerHandlers(configs) {
    configs.forEach(({ channel, handler, description }) => {
      this.handle(channel, handler, description || channel);
    });
  }

  /**
   * 移除 IPC 处理器
   * @param {string} channel - IPC 通道名称
   */
  removeHandler(channel) {
    if (this.handlers.has(channel)) {
      ipcMain.removeHandler(channel);
      this.handlers.delete(channel);
      ipcLogger.debug(`移除 IPC 处理器: ${channel}`);
    }
  }

  /**
   * 获取所有已注册的通道名称
   * @returns {string[]}
   */
  getChannels() {
    return Array.from(this.handlers.keys());
  }

  /**
   * 清除所有处理器
   */
  clear() {
    this.handlers.forEach((_, channel) => {
      ipcMain.removeHandler(channel);
    });
    this.handlers.clear();
    ipcLogger.info('已清除所有 IPC 处理器');
  }
}

// 导出单例实例
export const ipcRegistry = new IPCRegistry();

// 导出类以便创建自定义实例
export { IPCRegistry };
