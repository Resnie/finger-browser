import {
  detectingLocalBrowsers,
  installBrowserVersion,
  removeBrowserVersion,
  cancelBrowserDownload,
  getAllBrowserVersionsList,
} from '../utils/browser.js';
import { logger } from '../utils/logger.js';
import { ipcRegistry } from './ipc/registry.js';

const coreLogger = logger.createContextLogger('BrowserCore');

/**
 * 注册浏览器内核管理 IPC 处理器
 */
export const registerBrowserCoreHandlers = () => {
  coreLogger.info('注册浏览器内核管理 IPC 处理器');

  ipcRegistry.registerHandlers([
    {
      channel: 'get-local-browser-versions',
      handler: async () => {
        coreLogger.debug('获取本地已安装的浏览器版本列表');
        return await detectingLocalBrowsers();
      },
      description: '获取本地浏览器版本',
    },
    {
      channel: 'get-all-browser-versions',
      handler: async () => {
        coreLogger.debug('获取所有可用的浏览器版本列表');
        return await getAllBrowserVersionsList();
      },
      description: '获取所有浏览器版本',
    },
    {
      channel: 'download-browser-version',
      handler: async (event, version) => {
        coreLogger.info(`开始下载浏览器版本: ${version}`);
        try {
          await installBrowserVersion(version, '');
          coreLogger.info(`浏览器版本 ${version} 下载完成`);
          return { success: true, version };
        } catch (error) {
          if (error.code === 'DOWNLOAD_CANCELLED') {
            coreLogger.info(`浏览器版本 ${version} 下载已取消`);
            return { success: false, version, cancelled: true };
          }
          throw error;
        }
      },
      description: '下载浏览器版本',
    },
    {
      channel: 'cancel-browser-download',
      handler: async (event, version) => {
        coreLogger.info(`取消下载浏览器版本: ${version}`);
        const result = cancelBrowserDownload(version);
        return { success: result, version };
      },
      description: '取消下载浏览器版本',
    },
    {
      channel: 'delete-browser-version',
      handler: async (event, version) => {
        coreLogger.info(`开始删除浏览器版本: ${version}`);
        removeBrowserVersion(version);
        coreLogger.info(`浏览器版本 ${version} 删除完成`);
        return { success: true, version };
      },
      description: '删除浏览器版本',
    },
  ]);
};
