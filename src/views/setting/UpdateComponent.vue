<script setup lang="ts">
  import { onMounted, onUnmounted, ref } from 'vue';
  import { getUserFacingErrorMessage } from '@/utils/error.mjs';

  type UpdateInfo = {
    version?: string;
  };

  type DownloadProgress = {
    percent?: number;
  };

  type StatusType = 'success' | 'warning' | 'info' | 'error';

  const updateAvailable = ref(false);
  const updateDownloaded = ref(false);
  const isChecking = ref(false);
  const isInstalling = ref(false);
  const progress = ref(0);
  const statusMessage = ref('');
  const statusType = ref<StatusType>('info');
  const targetVersion = ref('');

  const disposers: Array<() => void> = [];
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  const getPayload = <T,>(eventOrPayload: unknown, payload?: T): T => {
    return (payload === undefined ? eventOrPayload : payload) as T;
  };

  const setStatus = (message: string, type: StatusType = 'info') => {
    statusMessage.value = message;
    statusType.value = type;
  };

  const clearStatusTimer = () => {
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
  };

  const clearStatusLater = () => {
    clearStatusTimer();
    statusTimer = setTimeout(() => {
      statusMessage.value = '';
      statusTimer = null;
    }, 3000);
  };

  // preload 的专用更新监听器会传入 (event, payload)。
  const handleUpdateAvailable = (event: unknown, payload?: UpdateInfo) => {
    const info = getPayload<UpdateInfo>(event, payload) || {};
    const version = typeof info.version === 'string' ? info.version.trim() : '';

    clearStatusTimer();
    isChecking.value = false;
    updateAvailable.value = true;
    updateDownloaded.value = false;
    progress.value = 0;
    targetVersion.value = version;
    setStatus(version ? `发现新版本 ${version}，正在下载...` : '发现新版本，正在下载...');
  };

  const handleUpdateNotAvailable = (event: unknown, payload?: UpdateInfo) => {
    getPayload<UpdateInfo>(event, payload);
    isChecking.value = false;
    updateAvailable.value = false;
    updateDownloaded.value = false;
    progress.value = 0;
    targetVersion.value = '';
    setStatus('当前已是最新版本', 'success');
    clearStatusLater();
  };

  const handleDownloadProgress = (event: unknown, payload?: DownloadProgress) => {
    const progressInfo = getPayload<DownloadProgress>(event, payload) || {};
    const percent = Number(progressInfo.percent);

    isChecking.value = false;
    updateAvailable.value = true;
    progress.value = Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0;
  };

  const handleUpdateDownloaded = (event: unknown, payload?: UpdateInfo) => {
    const info = getPayload<UpdateInfo>(event, payload) || {};
    const version = typeof info.version === 'string' ? info.version.trim() : targetVersion.value;

    clearStatusTimer();
    isChecking.value = false;
    updateAvailable.value = false;
    updateDownloaded.value = true;
    progress.value = 100;
    targetVersion.value = version;
    setStatus(
      version ? `版本 ${version} 已下载，可以重启安装` : '更新已下载，可以重启安装',
      'success'
    );
  };

  const handleUpdateError = (event: unknown, payload?: unknown) => {
    const error = getPayload<unknown>(event, payload);

    clearStatusTimer();
    isChecking.value = false;
    isInstalling.value = false;
    updateAvailable.value = false;
    updateDownloaded.value = false;
    progress.value = 0;
    setStatus(getUserFacingErrorMessage(error, '自动更新暂时不可用，请稍后重试'), 'error');
  };

  const checkForUpdates = async () => {
    if (isChecking.value || updateAvailable.value || updateDownloaded.value) return;

    const check = window.ipcRenderer?.checkForUpdates;
    if (typeof check !== 'function') {
      setStatus('当前环境不支持应用更新', 'error');
      return;
    }

    clearStatusTimer();
    isChecking.value = true;
    setStatus('正在检查更新...');

    try {
      const result = await check();
      if (result?.supported === false) {
        setStatus(result.message || '开发模式不支持自动更新', 'warning');
      } else if (result?.success === false) {
        setStatus(getUserFacingErrorMessage(result, '检查更新失败，请稍后重试'), 'error');
      } else if (!result?.updateAvailable && !updateAvailable.value && !updateDownloaded.value) {
        setStatus('当前已是最新版本', 'success');
        clearStatusLater();
      }
    } catch (error) {
      setStatus(getUserFacingErrorMessage(error, '检查更新失败，请稍后重试'), 'error');
    } finally {
      isChecking.value = false;
    }
  };

  const installUpdate = async () => {
    if (isInstalling.value || !updateDownloaded.value) return;

    const install = window.ipcRenderer?.installUpdate;
    if (typeof install !== 'function') {
      setStatus('当前环境不支持安装更新', 'error');
      return;
    }

    isInstalling.value = true;
    setStatus('正在重启并安装更新...');

    try {
      await install();
    } catch (error) {
      isInstalling.value = false;
      setStatus(getUserFacingErrorMessage(error, '安装更新失败，请稍后重试'), 'error');
    }
  };

  const disposeListeners = () => {
    while (disposers.length) {
      const dispose = disposers.pop();
      try {
        dispose?.();
      } catch (error) {
        console.error('清理更新监听器失败', error);
      }
    }
  };

  const subscribe = (
    method: ((callback: (...args: unknown[]) => void) => unknown) | undefined,
    handler: (...args: any[]) => void
  ) => {
    if (typeof method !== 'function') return;
    const dispose = method(handler);
    if (typeof dispose === 'function') {
      disposers.push(dispose as () => void);
    }
  };

  onMounted(() => {
    disposeListeners();

    const ipc = window.ipcRenderer;
    if (!ipc) {
      setStatus('当前环境不支持应用更新', 'error');
      return;
    }

    subscribe(ipc.onUpdateAvailable, handleUpdateAvailable);
    subscribe(ipc.onUpdateNotAvailable, handleUpdateNotAvailable);
    subscribe(ipc.onDownloadProgress, handleDownloadProgress);
    subscribe(ipc.onUpdateDownloaded, handleUpdateDownloaded);
    subscribe(ipc.onUpdateError, handleUpdateError);
  });

  onUnmounted(() => {
    clearStatusTimer();
    disposeListeners();
  });
</script>

<template>
  <section class="update-container" aria-labelledby="update-title">
    <div class="update-header">
      <div>
        <h2 id="update-title">应用更新</h2>
        <p>检查并安装指纹浏览器的最新版本。</p>
      </div>
      <el-button
        type="primary"
        plain
        :loading="isChecking"
        :disabled="updateAvailable || updateDownloaded || isInstalling"
        @click="checkForUpdates"
      >
        {{ isChecking ? '正在检查' : '检查更新' }}
      </el-button>
    </div>

    <el-alert
      v-if="statusMessage"
      class="status-message"
      :title="statusMessage"
      :type="statusType"
      :closable="false"
      show-icon
    />

    <div v-if="updateAvailable" class="progress-container">
      <div class="progress-meta">
        <span>{{ targetVersion ? `正在下载 ${targetVersion}` : '正在下载更新' }}</span>
        <span>{{ progress }}%</span>
      </div>
      <el-progress :percentage="progress" :stroke-width="10" :show-text="false" />
    </div>

    <div v-if="updateDownloaded" class="update-actions">
      <el-button type="success" :loading="isInstalling" @click="installUpdate">
        {{ isInstalling ? '正在安装' : '立即重启并安装更新' }}
      </el-button>
    </div>
  </section>
</template>

<style scoped>
  .update-container {
    max-width: 760px;
    margin: 0;
    padding: 20px;
    border: 1px solid var(--app-border, #e4e7ec);
    border-radius: 12px;
    background: var(--app-surface, #ffffff);
    box-shadow: var(--app-shadow, 0 8px 24px rgb(16 24 40 / 5%));
  }

  .update-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }

  .update-header h2 {
    margin: 0;
    color: var(--app-text, #172033);
    font-size: 18px;
    font-weight: 650;
  }

  .update-header p {
    margin: 6px 0 0;
    color: var(--app-text-secondary, #667085);
    font-size: 13px;
  }

  .status-message,
  .progress-container,
  .update-actions {
    margin-top: 18px;
  }

  .progress-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    color: var(--app-text-secondary, #667085);
    font-size: 13px;
  }

  .update-actions {
    display: flex;
    justify-content: flex-end;
  }

  @media (max-width: 720px) {
    .update-header {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
