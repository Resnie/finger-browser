import { ipcRenderer } from 'electron';

export const exposeIpcLoginCredentials = () => ({
  getSavedLoginCredentials: async () => await ipcRenderer.invoke('login-credentials:get'),
  saveLoginCredentials: async (username, password, scheme = 'plain') =>
    await ipcRenderer.invoke('login-credentials:save', { username, password, scheme }),
  clearLoginCredentials: async () => await ipcRenderer.invoke('login-credentials:clear'),
});
