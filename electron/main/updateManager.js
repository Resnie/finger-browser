import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { logger } from '../utils/logger.js';
import { ipcRegistry } from './ipc/registry.js';
import { ipcEmitter } from './ipc/emitter.js';

const updateLogger = logger.createContextLogger('Updater');
let autoUpdaterConfigured = false;

const createUnsupportedSummary = () => ({
  success: false,
  supported: false,
  updateAvailable: false,
  version: null,
  message: '开发模式不支持自动更新，请在打包后的应用中检查',
});

const createUpdateCheckSummary = result => ({
  success: true,
  supported: true,
  updateAvailable: Boolean(result?.isUpdateAvailable),
  version: result?.updateInfo?.version || null,
  message: result ? null : '自动更新器未启用',
});

const checkForUpdates = async source => {
  if (!app.isPackaged) {
    updateLogger.info(`${source}检查更新已跳过：当前为开发模式`);
    return createUnsupportedSummary();
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    return createUpdateCheckSummary(result);
  } catch (error) {
    // electron-updater 同时会触发 error 事件通知渲染进程；此处收敛
    // Promise，避免未等待 invoke/定时检查时产生 unhandled rejection。
    updateLogger.error(`${source}检查更新失败: ${error.message}`);
    return {
      success: false,
      supported: true,
      updateAvailable: false,
      version: null,
      message: error.message,
    };
  }
};

/**
 * 配置自动更新
 */
const configureAutoUpdater = () => {
  if (autoUpdaterConfigured) return;

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'Resnie',
    repo: 'finger-browser',
    releaseType: 'release',
    channel: 'latest',
    private: false,
  });

  // 更新可用
  autoUpdater.on('update-available', info => {
    updateLogger.info(`更新可用: ${JSON.stringify(info)}`);
    ipcEmitter.emitUpdateAvailable(info);
  });

  // 无可用更新
  autoUpdater.on('update-not-available', info => {
    updateLogger.info(`无可用更新: ${JSON.stringify(info)}`);
    ipcEmitter.emitUpdateNotAvailable(info);
  });

  // 下载进度
  autoUpdater.on('download-progress', progressObj => {
    updateLogger.debug(`下载进度: ${JSON.stringify(progressObj)}`);
    ipcEmitter.emitUpdateDownloadProgress(progressObj);
  });

  // 更新已下载
  autoUpdater.on('update-downloaded', info => {
    updateLogger.info(`更新已下载: ${JSON.stringify(info)}`);
    ipcEmitter.emitUpdateDownloaded(info);
  });

  // 更新错误
  autoUpdater.on('error', err => {
    updateLogger.error(`更新错误: ${err.message}`);
    ipcEmitter.emitUpdateError(err.message);
  });

  autoUpdaterConfigured = true;
};

/**
 * 注册更新管理 IPC 处理器
 */
export const registerUpdateHandlers = () => {
  updateLogger.info('注册更新管理 IPC 处理器');

  // 配置自动更新
  configureAutoUpdater();

  ipcRegistry.registerHandlers([
    {
      channel: 'check-for-updates',
      handler: async () => {
        updateLogger.info('检查更新');
        return checkForUpdates('手动');
      },
      description: '检查更新',
    },
    {
      channel: 'install-update',
      handler: async () => {
        updateLogger.info('安装更新');
        autoUpdater.quitAndInstall(true, true);
      },
      description: '安装更新',
    },
  ]);

  // 开发态没有 app-update.yml，启动时自动检查只会产生误导性报错。
  if (app.isPackaged) {
    setTimeout(() => {
      updateLogger.info('自动检查更新');
      void checkForUpdates('自动').catch(error => {
        // checkForUpdates 已捕获 updater 错误；这里防止未预期的编程错误泄漏为未处理 Promise。
        updateLogger.error(`自动检查更新异常: ${error.message}`);
      });
    }, 3000);
  } else {
    updateLogger.info('开发模式已禁用启动自动更新检查');
  }
};
