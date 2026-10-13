import { ipcRenderer } from 'electron';

/**
 * 创建带自动清理功能的 IPC 监听器包装函数
 * @param {string} channel - IPC 通道名称
 * @returns {Function} 注册监听器的函数，返回取消订阅函数
 */
const createListener = channel => callback => {
  const wrappedCallback = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, wrappedCallback);
  // 返回取消订阅函数
  return () => {
    ipcRenderer.off(channel, wrappedCallback);
  };
};

export const exposeIpcUpdate = () => ({
  // invoke 方法 - 请求/响应模式
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // on 方法 - 事件订阅模式（返回取消订阅函数）
  onDownloadProgress: createListener('download-progress'),
  onUpdateDownloaded: createListener('update-downloaded'),
  onUpdateError: createListener('update-error'),
  onUpdateAvailable: createListener('update-available'),
  onUpdateNotAvailable: createListener('update-not-available'),
});
