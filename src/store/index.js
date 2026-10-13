import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useUserStore = defineStore('user', () => {
  const initialToken = localStorage.getItem('token') || '';
  const isLoggedIn = ref(Boolean(initialToken));
  const token = ref(initialToken);
  const userInfo = ref({});
  const login = (tokenStr, userInfoJson = {}) => {
    if (!tokenStr) return;
    localStorage.setItem('token', tokenStr);
    isLoggedIn.value = true;
    token.value = tokenStr;
    userInfo.value = userInfoJson;
  };
  const logout = () => {
    localStorage.removeItem('token');
    isLoggedIn.value = false;
    token.value = '';
    userInfo.value = {};
    versionDownloads.value = {};
    browserIdToVersion.value = {};
    browserInstances.value = {};
    lastSavedBrowserStates.value = {};
  };
  const downloadInitialized = ref(false);
  const setDownloadInitialized = initialized => {
    downloadInitialized.value = initialized;
  };

  // 统一下载状态管理（按 version 为键）
  // { [version]: { progress, isDownloading, message, speed, loaded, total, estimated } }
  const versionDownloads = ref({});
  // 浏览器实例 ID 到正在下载的 version 的映射
  // { [browser_id]: version }
  const browserIdToVersion = ref({});

  const initVersionDownload = (version, subscribers = []) => {
    if (!versionDownloads.value[version]) {
      versionDownloads.value[version] = {
        progress: 0,
        isDownloading: true,
        message: '',
        speed: 0,
        loaded: 0,
        total: 0,
        estimated: 0,
      };
    }
    // 将 subscribers 中的 browser_id 映射到该 version
    subscribers.forEach(id => {
      if (id) browserIdToVersion.value[id] = version;
    });
  };

  const setVersionDownloadProgress = (
    version,
    { progress, speed, loaded, total, estimated, subscribers } = {}
  ) => {
    if (!versionDownloads.value[version]) {
      initVersionDownload(version);
    }
    const dl = versionDownloads.value[version];
    if (progress !== undefined) dl.progress = progress;
    if (speed !== undefined) dl.speed = speed;
    if (loaded !== undefined) dl.loaded = loaded;
    if (total !== undefined) dl.total = total;
    if (estimated !== undefined) dl.estimated = estimated;
    // 更新 subscribers 映射
    if (subscribers && subscribers.length) {
      subscribers.forEach(id => {
        if (id) browserIdToVersion.value[id] = version;
      });
    }
  };

  const setVersionDownloadMessage = (version, message) => {
    if (!versionDownloads.value[version]) {
      initVersionDownload(version);
    }
    versionDownloads.value[version].message = message;
  };

  const clearVersionDownload = version => {
    delete versionDownloads.value[version];
    // 清理 browserIdToVersion 中指向该 version 的映射
    for (const [id, v] of Object.entries(browserIdToVersion.value)) {
      if (v === version) delete browserIdToVersion.value[id];
    }
  };

  const getDownloadByBrowserId = browserId => {
    const version = browserIdToVersion.value[browserId];
    if (version && versionDownloads.value[version]) {
      return versionDownloads.value[version];
    }
    return null;
  };

  const getVersionByBrowserId = browserId => {
    return browserIdToVersion.value[browserId] || null;
  };
  // 开发状态管理
  const browserInstances = ref({});
  const setBrowserInstances = (id, status) => {
    browserInstances.value[id] = status;
  };

  // 浏览器状态缓存（全局保存，供浏览器列表页同步本地表格数据）
  const lastSavedBrowserStates = ref({});
  const setLastSavedBrowserState = (id, data) => {
    lastSavedBrowserStates.value[id] = data;
  };
  const getLastSavedBrowserState = id => {
    return lastSavedBrowserStates.value[id] || null;
  };
  const clearLastSavedBrowserState = id => {
    delete lastSavedBrowserStates.value[id];
  };

  return {
    isLoggedIn,
    token,
    userInfo,
    login,
    logout,
    downloadInitialized,
    setDownloadInitialized,
    versionDownloads,
    browserIdToVersion,
    initVersionDownload,
    setVersionDownloadProgress,
    setVersionDownloadMessage,
    clearVersionDownload,
    getDownloadByBrowserId,
    getVersionByBrowserId,
    browserInstances,
    setBrowserInstances,
    lastSavedBrowserStates,
    setLastSavedBrowserState,
    getLastSavedBrowserState,
    clearLastSavedBrowserState,
  };
});

// 浏览器版本管理store
export const useBrowserVersionStore = defineStore('browserVersion', () => {
  const availableVersions = ref([]);
  const selectedVersion = ref('');

  // 设置可用的浏览器版本
  const setAvailableVersions = versions => {
    availableVersions.value = versions;
  };

  // 设置当前选择的浏览器版本
  const setSelectedVersion = version => {
    selectedVersion.value = version;
  };

  return {
    availableVersions,
    selectedVersion,
    setAvailableVersions,
    setSelectedVersion,
  };
});
