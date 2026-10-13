import { app, BrowserWindow, dialog, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'node:url';

// 导入管理器
import { registerBrowserHandlers, browserManager } from './browserManager.js';
import { registerBrowserCoreHandlers } from './browserCoreManager.js';
import { registerUpdateHandlers } from './updateManager.js';
import { registerEmailHandlers } from './emailManager.js';
import { registerLoginCredentialHandlers } from './loginCredentialManager.js';
import { initBrowserVersions } from '../utils/browser.js';
import { logger } from '../utils/logger.js';
import { ipcEmitter } from './ipc/emitter.js';

const mainLogger = logger.createContextLogger('Main');

// 计算目录路径
const __dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '../');
process.env.APP_ROOT = path.dirname(__dirname);

// 环境变量配置
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');
process.env.DEBUG = 'electron-updater';
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST;

// 主窗口引用
let mainWindow = null;

const productionIndexPath = path.resolve(process.env.APP_ROOT, 'dist', 'index.html');

/**
 * 主窗口只允许留在本应用的渲染页面，避免外部页面获得 preload API。
 */
const isAllowedMainWindowUrl = targetUrl => {
  try {
    const target = new URL(targetUrl);
    if (VITE_DEV_SERVER_URL) {
      return target.origin === new URL(VITE_DEV_SERVER_URL).origin;
    }

    return (
      target.protocol === 'file:' && path.resolve(fileURLToPath(target)) === productionIndexPath
    );
  } catch {
    return false;
  }
};

const describeNavigationTarget = targetUrl => {
  try {
    const target = new URL(targetUrl);
    return target.protocol === 'file:' ? 'file://local' : target.origin;
  } catch {
    return 'invalid-url';
  }
};

/**
 * 创建主窗口
 */
const createMainWindow = () => {
  mainLogger.info('创建主窗口');

  const { width: availableWidth, height: availableHeight } = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    width: Math.min(1440, availableWidth),
    height: Math.min(900, availableHeight),
    minWidth: Math.min(1100, availableWidth),
    minHeight: Math.min(700, availableHeight),
  });

  // 设置 IPC 发射器的主窗口引用
  ipcEmitter.setMainWindow(mainWindow);

  // 拒绝主窗口离开本地应用。若未来需要打开帮助链接，应通过
  // shell.openExternal 在系统浏览器中显式打开，而不是复用带 preload 的窗口。
  const preventUnexpectedNavigation = (event, legacyUrl) => {
    const targetUrl = event.url || legacyUrl;
    if (isAllowedMainWindowUrl(targetUrl)) return;

    event.preventDefault();
    mainLogger.warn(`已阻止主窗口导航到: ${describeNavigationTarget(targetUrl)}`);
  };
  mainWindow.webContents.on('will-navigate', preventUnexpectedNavigation);
  mainWindow.webContents.on('will-redirect', preventUnexpectedNavigation);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    mainLogger.warn(`已阻止创建新窗口: ${describeNavigationTarget(url)}`);
    return { action: 'deny' };
  });

  // 加载页面
  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainLogger.info(`加载开发服务器: ${VITE_DEV_SERVER_URL}`);
  } else {
    mainWindow.loadFile(productionIndexPath);
    mainLogger.info(`加载生产页面: ${productionIndexPath}`);
  }

  // 窗口关闭事件
  mainWindow.on('closed', () => {
    mainWindow = null;
    mainLogger.info('主窗口已关闭');
  });

  return mainWindow;
};

/**
 * 初始化应用
 */
const initializeApp = async () => {
  mainLogger.info('应用初始化开始');

  // 创建主窗口
  createMainWindow();

  // 注册所有 IPC 处理器
  registerBrowserHandlers();
  registerBrowserCoreHandlers();
  registerUpdateHandlers();
  registerEmailHandlers();
  registerLoginCredentialHandlers();

  // 初始化浏览器版本列表
  await initBrowserVersions();

  mainLogger.info('应用初始化完成');
};

// 同一用户数据目录只允许一个主程序，避免两个应用实例同时操作浏览器数据。
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // 应用就绪时初始化
  app.whenReady().then(initializeApp);
}

// macOS 特殊处理：点击 dock 图标时重新创建窗口
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// 所有窗口关闭时退出应用（所有平台）
app.on('window-all-closed', () => {
  mainLogger.info('所有窗口已关闭，准备退出应用');
  app.quit();
});

// 应用退出前清理所有浏览器实例
let isQuitting = false;

app.on('before-quit', async event => {
  // 防止重复处理
  if (isQuitting) {
    event.preventDefault();
    return;
  }

  if (browserManager.hasPendingRecoveryWork()) {
    mainLogger.info('应用退出前收口浏览器实例与恢复写队列');

    // 阻止立即退出，等待清理完成
    event.preventDefault();
    isQuitting = true;

    let unsafeToQuit = false;
    try {
      await browserManager.prepareAppQuit();
    } catch (error) {
      mainLogger.error(`应用退出前恢复数据收口失败: ${error.message}`);
      unsafeToQuit = true;
    }

    if (unsafeToQuit) {
      isQuitting = false;
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
      await dialog.showMessageBox(mainWindow || undefined, {
        type: 'error',
        title: '无法安全退出',
        message: '最新浏览器数据尚未安全保留',
        detail: '已取消退出。请修复系统安全存储或网络后重试，不要强制结束进程。',
        buttons: ['我知道了'],
      });
      return;
    }

    mainLogger.info('所有浏览器实例与恢复写队列已安全收口');

    // 清理完成后退出
    app.exit(0);
  }
});

// 导出主窗口引用（用于测试或高级用例）
export { mainWindow };
