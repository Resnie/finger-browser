import axios from 'axios';
import { ElLoading, ElMessageBox } from 'element-plus';
import { ElMessage } from '@/utils/message';
import { useUserStore } from '@/store';

// 创建axios实例
const service = axios.create({
  // 基础URL，可从环境变量获取
  baseURL: import.meta.env.VITE_APP_BASE_API,
  // 请求超时时间
  timeout: 15000,
  // 请求头设置，Kratos常用JSON格式
  headers: {
    'Content-Type': 'application/json;charset=utf-8',
  },
});

// 加载实例
let loadingInstance = null;
let loadingRequestCount = 0;
let authExpiredPromptVisible = false;

const startLoading = () => {
  loadingRequestCount += 1;
  if (!loadingInstance) {
    loadingInstance = ElLoading.service({
      lock: true,
      text: '加载中...',
      background: 'rgba(15, 23, 42, 0.12)',
    });
  }
};

const stopLoading = config => {
  if (!config?._usesGlobalLoading) return;
  loadingRequestCount = Math.max(0, loadingRequestCount - 1);
  if (loadingRequestCount === 0 && loadingInstance) {
    loadingInstance.close();
    loadingInstance = null;
  }
};

const handleAuthExpired = async () => {
  if (authExpiredPromptVisible) return;
  authExpiredPromptVisible = true;
  let sessionCleared = false;
  try {
    try {
      await window.ipcRenderer?.prepareBrowserSessionLogout?.();
    } catch {
      await ElMessageBox.alert(
        '登录已失效，数据尚未安全保存。请保留应用并检查系统安全存储后重试。',
        '无法退出登录',
        { confirmButtonText: '我知道了', type: 'error' }
      );
      return;
    }
    const userStore = useUserStore();
    userStore.logout();
    sessionCleared = true;
    await ElMessageBox.alert('登录状态已过期，请重新登录', '会话已过期', {
      confirmButtonText: '去登录',
      type: 'warning',
    });
  } finally {
    authExpiredPromptVisible = false;
    if (sessionCleared && window.location.hash !== '#/login') {
      window.location.hash = '/login';
    }
  }
};

// 请求拦截器
service.interceptors.request.use(
  config => {
    // 显示加载动画
    config._usesGlobalLoading = config.loading !== false;
    if (config._usesGlobalLoading) {
      startLoading();
    }

    // 获取并添加token
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `${token}`;
    }

    return config;
  },
  error => {
    // 关闭加载动画
    stopLoading(error.config);
    // 处理请求错误
    ElMessage.error(error, '请求失败，请稍后重试');
    return Promise.reject(error);
  }
);

// 响应拦截器
service.interceptors.response.use(
  response => {
    // 关闭加载动画
    stopLoading(response.config);

    const res = response.data;

    // Kratos通常使用code字段表示状态码
    if (res.code !== 0) {
      if (res.code === 401) {
        handleAuthExpired();
      } else if (!response.config.silentError) {
        // 处理常见错误码
        switch (res.code) {
          case 403:
            ElMessage({ message: '没有操作权限', type: 'error', grouping: true });
            break;
          default:
            ElMessage({ message: res.message || '请求失败', type: 'error', grouping: true });
        }
      }

      const error = new Error(res.message || '请求失败');
      // 保留结构化错误，供创建页区分额度、价格与余额问题。
      // 仅挂在当次 Error 上，不写入日志或本地存储。
      error.apiCode = res.code;
      error.apiData = res.data;
      error.isNotified = res.code === 401 || !response.config.silentError;
      return Promise.reject(error);
    } else {
      // 请求成功，返回数据
      return res.data;
    }
  },
  error => {
    // 关闭加载动画
    stopLoading(error.config);

    // 处理网络错误
    if (!error.response) {
      const message =
        error.code === 'ECONNABORTED' ? '请求超时，请稍后重试' : '网络连接异常，请检查网络';
      if (!error.config?.silentError) {
        ElMessage({ message, type: 'error', grouping: true });
      }
      // 静默请求由调用方按业务场景展示错误，不能谎报为“已经提示”，
      // 否则断网/超时会被调用方再次吞掉，用户看不到任何反馈。
      error.isNotified = !error.config?.silentError;
      return Promise.reject(error);
    }

    // 处理HTTP错误状态码
    const status = error.response.status;
    let message = error.response.data?.message || `请求失败（${status}）`;
    if (status === 401) {
      handleAuthExpired();
    } else if (!error.config?.silentError) {
      switch (status) {
        case 403:
          message = '没有操作权限';
          break;
        case 404:
          message = '请求的资源不存在';
          break;
        case 500:
          message = '服务暂时不可用，请稍后重试';
          break;
      }
      if (status !== 401) {
        ElMessage({ message, type: 'error', grouping: true });
      }
    }
    error.isNotified = status === 401 || !error.config?.silentError;
    error.httpStatus = status;
    error.apiCode = error.response.data?.code;
    error.apiData = error.response.data?.data;

    return Promise.reject(error);
  }
);

/**
 * 封装请求方法
 * @param {string} url - 请求地址
 * @param {string} method - 请求方法
 * @param {object} data - 请求数据
 * @param {object} config - 额外配置
 * @returns {Promise}
 */
const request = (url, method = 'get', data = {}, config = {}) => {
  const options = {
    url,
    method,
    ...config,
  };

  // 根据请求方法设置数据存放位置
  if (method.toLowerCase() === 'get') {
    options.params = data;
  } else {
    options.data = data;
  }

  return service(options);
};

// 封装常用请求方法
const api = {
  get: (url, params = {}, config = {}) => request(url, 'get', params, config),
  post: (url, data = {}, config = {}) => request(url, 'post', data, config),
  put: (url, data = {}, config = {}) => request(url, 'put', data, config),
  delete: (url, data = {}, config = {}) => request(url, 'delete', data, config),
  patch: (url, data = {}, config = {}) => request(url, 'patch', data, config),
};

export default api;
