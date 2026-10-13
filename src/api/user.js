import api from '@/utils/request';

// 用户登录
export const login = data => {
  return api.post('/users/login', data, { loading: false });
};

// 退出登录并撤销服务端会话；短超时避免离线时阻塞用户退出。
export const logout = () => {
  return api.post('/users/logout', {}, { loading: false, silentError: true, timeout: 3000 });
};
