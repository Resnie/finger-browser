import api from '@/utils/request';

// 创建浏览器实例
export const createBrowserInstance = data => {
  return api.post('/browsers/create', data, { loading: false, silentError: true });
};

// 删除浏览器实例
export const deleteBrowserInstance = id => {
  return api.post('/browsers/delete', { id }, { loading: false });
};

// 更新浏览器实例
export const updateBrowserInstance = data => {
  return api.post('/browsers/update', data, { loading: false });
};

// 获取浏览器实例列表
export const searchBrowserInstanceList = data => {
  return api.post('/browsers/search', data, { loading: true });
};

export const updateBrowserGroup = data => {
  return api.post('/browsers/update_group', data, { loading: false });
};

export const getEngineCount = () => {
  return api.get('/browsers/engine_count', {}, { loading: false });
};

// 更新浏览器会话（标签页/状态）
export const updateBrowserSession = data => {
  return api.post('/browsers/update_session', data, { loading: false });
};
