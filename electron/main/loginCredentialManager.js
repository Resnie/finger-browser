import { ipcRegistry } from './ipc/registry.js';
import { loginCredentialManager } from './models/LoginCredentialManager.js';

export const registerLoginCredentialHandlers = () => {
  ipcRegistry.registerHandlers([
    {
      channel: 'login-credentials:get',
      handler: async () => loginCredentialManager.load(),
      description: '读取登录凭据',
    },
    {
      channel: 'login-credentials:save',
      handler: async (_event, payload) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('登录凭据格式无效');
        }
        const { username, password, scheme } = payload;
        loginCredentialManager.save(username, password, scheme);
        return { success: true };
      },
      description: '保存登录凭据',
    },
    {
      channel: 'login-credentials:clear',
      handler: async () => {
        loginCredentialManager.clear();
        return { success: true };
      },
      description: '清除登录凭据',
    },
  ]);
};
