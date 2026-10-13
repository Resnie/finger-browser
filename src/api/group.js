import api from '@/utils/request';

// 获取分组列表
export const searchGroup = data => {
  return api.post('/groups/search', data, { loading: false });
};

export const searchGroupDetail = data => {
  return api.post('/groups/search_detail', data, { loading: true });
};

// 创建分组
export const createGroup = data => {
  return api.post('/groups/create', data, { loading: true });
};

// 删除分组
export const deleteGroup = data => {
  return api.post('/groups/delete', data, { loading: true });
};

// 更新分组
export const updateGroup = data => {
  return api.post('/groups/update', data, { loading: true });
};
