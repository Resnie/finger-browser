import { logger } from '../../utils/logger.js';

const emitterLogger = logger.createContextLogger('IPCEmitter');

/**
 * IPC 事件通道常量
 */
export const IPC_CHANNELS = {
  // 浏览器状态相关
  BROWSER_STATUS: 'browserStatus',
  SAVE_BROWSER_STATE: 'save-browser-state',
  FLUSH_BROWSER_STATE: 'flush-browser-state',
  BROWSER_RECOVERY_CONFLICT: 'browser-recovery-conflict',
  BROWSER_RECOVERY_SYNC_FAILED: 'browser-recovery-sync-failed',

  // 下载相关
  BROWSER_DOWNLOAD_START: 'browser-download-start',
  BROWSER_DOWNLOAD_PROGRESS: 'browser-download-progress',
  BROWSER_DOWNLOAD_COMPLETE: 'browser-download-complete',
  BROWSER_DOWNLOAD_ERROR: 'browser-download-error',

  // 更新相关
  UPDATE_AVAILABLE: 'update-available',
  UPDATE_NOT_AVAILABLE: 'update-not-available',
  DOWNLOAD_PROGRESS: 'download-progress',
  UPDATE_DOWNLOADED: 'update-downloaded',
  UPDATE_ERROR: 'update-error',

  // 历史记录相关
  GET_BROWSER_HISTORY: 'get-browser-history',
  SEARCH_BROWSER_HISTORY: 'search-browser-history',
  CLEAR_BROWSER_HISTORY: 'clear-browser-history',

  // 密码管理相关
  GET_SAVED_CREDENTIALS: 'get-saved-credentials',
  SAVE_CREDENTIAL: 'save-credential',
  DELETE_CREDENTIAL: 'delete-credential',

  // 邮件相关
  EMAIL_FETCH_PROGRESS: 'email-fetch-progress',
  EMAIL_FETCH_COMPLETE: 'email-fetch-complete',
  EMAIL_FETCH_ERROR: 'email-fetch-error',
};

/**
 * IPC 事件发射器类
 * 统一管理从主进程到渲染进程的事件发送
 */
class IPCEmitter {
  constructor() {
    this.mainWindow = null;
  }

  /**
   * 设置主窗口引用
   * @param {BrowserWindow} win - 主窗口实例
   */
  setMainWindow(win) {
    this.mainWindow = win;
    emitterLogger.info('主窗口已设置');
  }

  /**
   * 检查窗口是否可用
   * @returns {boolean}
   */
  isWindowAvailable() {
    if (!this.mainWindow) {
      return false;
    }
    // 检查窗口是否已销毁
    if (this.mainWindow.isDestroyed()) {
      return false;
    }
    // 检查 webContents 是否可用
    if (!this.mainWindow.webContents || this.mainWindow.webContents.isDestroyed()) {
      return false;
    }
    return true;
  }

  /**
   * 发送事件到渲染进程
   * @param {string} channel - 事件通道
   * @param {any} data - 事件数据
   * @returns {boolean} 是否发送成功
   */
  send(channel, data) {
    if (!this.isWindowAvailable()) {
      emitterLogger.warn(`无法发送事件 "${channel}": 主窗口不可用或已销毁`);
      return false;
    }

    try {
      this.mainWindow.webContents.send(channel, data);
      // data 可能包含浏览器 cookies/localStorage、代理凭据或邮箱信息，
      // 日志只记录通道名，不序列化业务载荷。
      emitterLogger.debug(`发送事件: ${channel}`);
      return true;
    } catch (error) {
      emitterLogger.error(`发送事件失败 "${channel}": ${error.message}`);
      return false;
    }
  }

  // ==================== 浏览器状态相关 ====================

  /**
   * 发送浏览器状态变更事件
   * @param {string} id - 浏览器实例 ID
   * @param {string} status - 状态 ('started' | 'closed')
   * @returns {boolean} 是否发送成功
   */
  emitBrowserStatus(id, status) {
    emitterLogger.info(`准备发送浏览器状态: id=${id}, status=${status}`);
    return this.send(IPC_CHANNELS.BROWSER_STATUS, { id, status });
  }

  /**
   * 发送保存浏览器状态事件
   * @param {Object} data - 状态数据
   */
  emitSaveBrowserState(data) {
    this.send(IPC_CHANNELS.SAVE_BROWSER_STATE, data);
  }

  /**
   * 发送刷新浏览器表格事件
   */
  emitFlushBrowserState() {
    this.send(IPC_CHANNELS.FLUSH_BROWSER_STATE, {});
  }

  emitBrowserRecoveryConflict(id) {
    this.send(IPC_CHANNELS.BROWSER_RECOVERY_CONFLICT, { id });
  }

  emitBrowserRecoverySyncFailed(id, details = {}) {
    this.send(IPC_CHANNELS.BROWSER_RECOVERY_SYNC_FAILED, {
      id,
      retained: details.retained === true,
      critical: details.critical === true,
      // 仅允许主进程生成的短错误文案，不携带快照或凭据内容。
      message:
        typeof details.message === 'string' && details.message.length <= 300
          ? details.message
          : '',
    });
  }

  // ==================== 下载相关 ====================

  /**
   * 发送下载开始事件
   * @param {Object} data - 下载信息
   */
  emitDownloadStart(data) {
    this.send(IPC_CHANNELS.BROWSER_DOWNLOAD_START, data);
  }

  /**
   * 发送下载进度事件
   * @param {Object} data - 进度信息
   */
  emitDownloadProgress(data) {
    this.send(IPC_CHANNELS.BROWSER_DOWNLOAD_PROGRESS, data);
  }

  /**
   * 发送下载完成事件
   * @param {Object} data - 完成信息
   */
  emitDownloadComplete(data) {
    this.send(IPC_CHANNELS.BROWSER_DOWNLOAD_COMPLETE, data);
  }

  /**
   * 发送下载错误事件
   * @param {Object} data - 错误信息
   */
  emitDownloadError(data) {
    this.send(IPC_CHANNELS.BROWSER_DOWNLOAD_ERROR, data);
  }

  // ==================== 更新相关 ====================

  /**
   * 发送更新可用事件
   * @param {Object} info - 更新信息
   */
  emitUpdateAvailable(info) {
    this.send(IPC_CHANNELS.UPDATE_AVAILABLE, info);
  }

  /**
   * 发送无可用更新事件
   * @param {Object} info - 更新信息
   */
  emitUpdateNotAvailable(info) {
    this.send(IPC_CHANNELS.UPDATE_NOT_AVAILABLE, info);
  }

  /**
   * 发送更新下载进度事件
   * @param {Object} progressObj - 进度信息
   */
  emitUpdateDownloadProgress(progressObj) {
    this.send(IPC_CHANNELS.DOWNLOAD_PROGRESS, progressObj);
  }

  /**
   * 发送更新已下载事件
   * @param {Object} info - 下载信息
   */
  emitUpdateDownloaded(info) {
    this.send(IPC_CHANNELS.UPDATE_DOWNLOADED, info);
  }

  /**
   * 发送更新错误事件
   * @param {string} message - 错误消息
   */
  emitUpdateError(message) {
    this.send(IPC_CHANNELS.UPDATE_ERROR, message);
  }

  // ==================== 邮件相关 ====================

  /**
   * 发送邮件读取进度事件
   * @param {Object} data - 进度信息
   */
  emitEmailFetchProgress(data) {
    this.send(IPC_CHANNELS.EMAIL_FETCH_PROGRESS, data);
  }

  /**
   * 发送邮件读取完成事件
   * @param {Object} data - 完成信息
   */
  emitEmailFetchComplete(data) {
    this.send(IPC_CHANNELS.EMAIL_FETCH_COMPLETE, data);
  }

  /**
   * 发送邮件读取错误事件
   * @param {Object} data - 错误信息
   */
  emitEmailFetchError(data) {
    this.send(IPC_CHANNELS.EMAIL_FETCH_ERROR, data);
  }
}

// 导出单例实例
export const ipcEmitter = new IPCEmitter();

// 导出类以便创建自定义实例
export { IPCEmitter };
