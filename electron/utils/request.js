import axios from 'axios';

// 创建axios实例
const service = axios.create({
  // 基础URL，可从环境变量获取
  baseURL: import.meta.env.VITE_APP_BASE_API,
  // 请求超时时间
  timeout: 10000,
  // 请求头设置，Kratos常用JSON格式
  headers: {
    'Content-Type': 'application/json;charset=utf-8',
  },
});

// 请求拦截器
service.interceptors.request.use(
  config => {
    return config;
  },
  error => {
    return Promise.reject(error);
  }
);

// 响应拦截器
service.interceptors.response.use(
  response => {
    const res = response.data;
    // Kratos通常使用code字段表示状态码
    if (res.code !== 0) {
      return Promise.reject(new Error(res.message || 'Error'));
    } else {
      // 请求成功，返回数据
      return res.data;
    }
  },
  error => {
    // 处理网络错误
    if (!error.response) {
      return Promise.reject(error);
    }
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
