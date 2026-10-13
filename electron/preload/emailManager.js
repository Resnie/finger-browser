import { ipcRenderer } from 'electron';

/**
 * 创建带自动清理功能的 IPC 监听器包装函数
 * @param {string} channel - IPC 通道名称
 * @returns {Function} 注册监听器的函数，返回取消订阅函数
 */
const createListener = channel => callback => {
  const wrappedCallback = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, wrappedCallback);
  return () => {
    ipcRenderer.off(channel, wrappedCallback);
  };
};

export const exposeIpcEmail = () => ({
  // ==================== Google Auth invoke 方法 ====================
  prepareGoogleAuthMigration: async data =>
    await ipcRenderer.invoke('google-auth:prepare-migration', data),
  commitGoogleAuthMigration: async data =>
    await ipcRenderer.invoke('google-auth:commit-migration', data),
  getGoogleAuthCode: async email => await ipcRenderer.invoke('google-auth:get-code', email),
  generateTotp: async secret => await ipcRenderer.invoke('google-auth:generate-totp', secret),
  saveAuthSecret: async (email, authCode) =>
    await ipcRenderer.invoke('google-auth:save-secret', { email, authCode }),
  commitLocalAuthSecret: async data =>
    await ipcRenderer.invoke('google-auth:commit-local-secret', data),
  deleteAuthSecret: async email => await ipcRenderer.invoke('google-auth:delete-secret', email),
  listAllAuthEmails: async () => await ipcRenderer.invoke('google-auth:list-all'),
  rsaEncrypt: async data => await ipcRenderer.invoke('google-auth:rsa-encrypt', data),

  // ==================== Email invoke 方法 ====================
  fetchEmailsViaImap: async data => await ipcRenderer.invoke('email:fetch-imap', data),
  fetchEmailsViaPop3: async data => await ipcRenderer.invoke('email:fetch-pop3', data),
  listLocalEmailCache: async email => await ipcRenderer.invoke('email:list-local-cache', email),
  readLocalEmailBody: async filePath => await ipcRenderer.invoke('email:read-local-body', filePath),
  scanEmailAuthStatus: async data => await ipcRenderer.invoke('email:scan-auth-status', data),
  extractVerificationCode: async data => await ipcRenderer.invoke('email:extract-code', data),
  parseExcelImportFile: async () => await ipcRenderer.invoke('email:parse-excel'),
  exportImportTemplate: async () => await ipcRenderer.invoke('email:export-template'),
  prepareEmailForImport: async (emailData, isGoAuthCloud) =>
    await ipcRenderer.invoke('email:prepare-import', { emailData, isGoAuthCloud }),

  // ==================== Email 事件监听 ====================
  onEmailFetchProgress: createListener('email-fetch-progress'),
  onEmailFetchComplete: createListener('email-fetch-complete'),
  onEmailFetchError: createListener('email-fetch-error'),
});
