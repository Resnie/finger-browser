import { useUserStore } from '@/store';
import { globalIpcManager } from '@/composables/useIpcListener';
import { ElMessage } from '@/utils/message';

/**
 * 初始化全局下载监听器（单例）
 * 统一处理所有下载 IPC 事件，写入 versionDownloads
 */
export function initGlobalDownloadListeners() {
  const userStore = useUserStore();

  if (userStore.downloadInitialized) return;
  if (!window || !window.ipcRenderer) return;

  userStore.setDownloadInitialized(true);

  // 下载开始事件
  globalIpcManager.register('browser-download-start', data => {
    const id = data && (data.id || data.browser_id);
    const version = data && data.version;
    const subscribers = data && data.subscribers ? data.subscribers : id ? [id] : [];

    if (version) {
      userStore.initVersionDownload(version, subscribers);
      userStore.setVersionDownloadMessage(version, data.message || '');
      ElMessage.success(data.message || `内核 ${version} 开始下载`);
    }
  });

  // 下载进度事件
  globalIpcManager.register('browser-download-progress', data => {
    const version = data && data.version;
    if (!version) return;

    userStore.setVersionDownloadProgress(version, {
      progress: data.progress || 0,
      speed: data.speed || 0,
      loaded: data.loaded || 0,
      total: data.total || 0,
      estimated: data.estimated || 0,
      subscribers: data.subscribers || [],
    });
  });

  // 下载错误事件
  globalIpcManager.register('browser-download-error', data => {
    const version = data && data.version;

    ElMessage.error(data?.message || '内核下载失败', '内核下载失败，请稍后重试');

    if (version) {
      userStore.clearVersionDownload(version);
    }
  });

  // 下载完成事件
  globalIpcManager.register('browser-download-complete', data => {
    const version = data && data.version;

    if (version) {
      userStore.clearVersionDownload(version);
    }
  });

  // 浏览器实例状态变更
  globalIpcManager.register('browserStatus', data => {
    userStore.setBrowserInstances(data.id, data.status);
  });

  // 浏览器标签页/状态变更（主进程已负责持久化到后端，此处仅缓存到 store 供 UI 同步）
  globalIpcManager.register('save-browser-state', data => {
    if (!data || !data.id) return;
    userStore.setLastSavedBrowserState(data.id, {
      config: data.config,
    });
  });

  globalIpcManager.register('browser-recovery-conflict', () => {
    ElMessage.warning(
      '该窗口已在另一台电脑更新，本次未覆盖云端数据；请关闭窗口并刷新列表后重新打开'
    );
  });

  globalIpcManager.register('browser-recovery-sync-failed', data => {
    if (data?.retained) {
      ElMessage.error('数据暂未同步到云端，已保存在本机，请检查网络后重试');
      return;
    }
    ElMessage.error({
      message:
        data?.message ||
        '数据无法安全保存，请检查系统安全存储后重试',
      duration: data?.critical ? 0 : 6000,
      showClose: true,
    });
  });
}
