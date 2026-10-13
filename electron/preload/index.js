import { contextBridge, ipcRenderer } from 'electron';
import { exposeIpcUpdate } from './updateManager';
import { exposeIpcBrowser } from './browserManager';
import { exposeIpcEmail } from './emailManager';
import { exposeIpcLoginCredentials } from './loginCredentialManager';

// 仅允许渲染进程订阅主进程明确公开的事件。
// 注意：不要将 IpcRendererEvent 透传给渲染进程，其 sender 会绕过此处的通道边界。
const ALLOWED_EVENT_CHANNELS = new Set([
  'browserStatus',
  'save-browser-state',
  'flush-browser-state',
  'browser-recovery-conflict',
  'browser-recovery-sync-failed',
  'browser-download-start',
  'browser-download-progress',
  'browser-download-complete',
  'browser-download-error',
  'update-available',
  'update-not-available',
  'download-progress',
  'update-downloaded',
  'update-error',
  'email-fetch-progress',
  'email-fetch-complete',
  'email-fetch-error',
]);

const assertAllowedEventChannel = channel => {
  if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
    throw new Error(`IPC 事件通道未授权: ${channel}`);
  }
};

const subscribe = (channel, listener) => {
  assertAllowedEventChannel(channel);
  if (typeof listener !== 'function') {
    throw new TypeError('IPC 事件监听器必须是函数');
  }

  const wrappedListener = (_event, ...args) => listener(...args);
  ipcRenderer.on(channel, wrappedListener);

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    ipcRenderer.removeListener(channel, wrappedListener);
  };
};

// 集中暴露所有 API
const electronAPI = {
  ...exposeIpcUpdate(),
  ...exposeIpcBrowser(),
  ...exposeIpcEmail(),
  ...exposeIpcLoginCredentials(),
  on(channel, listener) {
    return subscribe(channel, listener);
  },
};

// 暴露API到渲染进程
contextBridge.exposeInMainWorld('ipcRenderer', electronAPI);
