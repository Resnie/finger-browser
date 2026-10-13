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

export const exposeIpcBrowser = () => ({
  // invoke 方法 - 请求/响应模式
  createInstance: async config => await ipcRenderer.invoke('create-browser-instance', config),
  restoreInstance: async instanceId =>
    await ipcRenderer.invoke('restore-browser-instance', instanceId),
  getAllInstances: async () => await ipcRenderer.invoke('get-all-instances'),
  prepareBrowserSessionLogout: async () =>
    await ipcRenderer.invoke('prepare-browser-session-logout'),
  removeInstance: async instanceId =>
    await ipcRenderer.invoke('remove-browser-instance', instanceId),
  deleteBrowserAndCleanup: async instanceId =>
    await ipcRenderer.invoke('delete-browser-and-cleanup', instanceId),

  // on 方法 - 事件订阅模式（返回取消订阅函数）
  saveState: createListener('save-browser-state'),
  browserDownloadStart: createListener('browser-download-start'),
  browserDownloadProgress: createListener('browser-download-progress'),
  browserDownloadError: createListener('browser-download-error'),
  browserDownloadComplete: createListener('browser-download-complete'),
  browserStatus: createListener('browserStatus'),

  // 内核版本管理
  getLocalBrowserVersions: async () => await ipcRenderer.invoke('get-local-browser-versions'),
  getAllBrowserVersions: async () => await ipcRenderer.invoke('get-all-browser-versions'),
  downloadBrowserVersion: async version =>
    await ipcRenderer.invoke('download-browser-version', version),
  deleteBrowserVersion: async version =>
    await ipcRenderer.invoke('delete-browser-version', version),
  cancelBrowserDownload: async version =>
    await ipcRenderer.invoke('cancel-browser-download', version),

  // 历史记录管理
  getBrowserHistory: async (instanceId, limit) =>
    await ipcRenderer.invoke('get-browser-history', { instanceId, limit }),
  searchBrowserHistory: async (instanceId, query, limit) =>
    await ipcRenderer.invoke('search-browser-history', {
      instanceId,
      query,
      limit,
    }),
  clearBrowserHistory: async instanceId =>
    await ipcRenderer.invoke('clear-browser-history', { instanceId }),

  // 密码管理
  getSavedCredentials: async instanceId =>
    await ipcRenderer.invoke('get-saved-credentials', { instanceId }),
  saveCredential: async (instanceId, domain, username, password) =>
    await ipcRenderer.invoke('save-credential', {
      instanceId,
      domain,
      username,
      password,
    }),
  deleteCredential: async (instanceId, domain, username) =>
    await ipcRenderer.invoke('delete-credential', {
      instanceId,
      domain,
      username,
    }),
});
