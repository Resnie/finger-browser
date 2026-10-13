import api from '@/utils/request';

// 搜索邮箱列表
// 参数: { groupId, apiName, pageSize, current }
// 返回: { apikeyList: [...], count: number }
export const searchEmails = data => {
  return api.post('/emails/search', data, { loading: true });
};

// 获取账号敏感详情（仅在查看邮件或编辑时按需加载）
// 参数: { uuid }
export const getEmailDetail = data => {
  return api.post('/emails/detail', data, { loading: false });
};

// 仅返回当前 6 位 TOTP，不下发原始密钥。
export const getCloudGoogleAuthCode = data => {
  return api.post('/emails/google_auth_code', data, { loading: false, silentError: true });
};

// 添加邮箱
export const addEmail = data => {
  return api.post('/emails/create', data, { loading: true, silentError: true });
};

// 批量导入邮箱
// 参数: 直接传数组
export const importEmails = data => {
  return api.post('/emails/import', data, { loading: true, silentError: true });
};

// 删除邮箱
export const deleteEmails = data => {
  return api.post('/emails/delete', data, { loading: false });
};

// 修改邮箱字段
// 参数: { uuid, changeField, [changeField]: value }
export const updateEmailField = data => {
  return api.post('/emails/update_field', data, { loading: false });
};

// 修改邮箱分组
// 参数: { group: [uuid,...], groupId }
export const updateEmailGroup = data => {
  return api.post('/emails/update_group', data, { loading: false });
};

// 快速添加邮箱
export const fastAddEmails = data => {
  return api.post('/emails/fast_add', data, { loading: true, silentError: true });
};

// 编辑邮箱
export const editEmail = data => {
  return api.post('/emails/edit', data, { loading: true });
};

// 创建邮箱
export const createMailbox = data => {
  return api.post('/emails/create_mailbox', data, { loading: true, silentError: true });
};

// 获取系统配置
export const getSystemConfig = () => {
  return api.get('/users/system_config');
};

// 更新系统配置
export const updateSystemConfig = data => {
  return api.post('/users/update_system_config', data, { loading: false });
};

// 获取分组列表
export const getUserGroup = () => {
  return api.post('/email_groups/search', {}, { loading: false });
};

// 获取分组列表（带分页和邮箱数量）
export const searchEmailGroupDetail = data => {
  return api.post('/email_groups/search_detail', data, { loading: false });
};

// 创建邮箱分组
export const createEmailGroup = data => {
  return api.post('/email_groups/create', data, { loading: true });
};

// 更新邮箱分组名称
export const updateEmailGroupName = data => {
  return api.post('/email_groups/update', data, { loading: false });
};

// 删除邮箱分组
// 参数: { id, all } all=1 同时删除组内邮箱, all=0 仅解除关联
export const deleteEmailGroup = data => {
  return api.post('/email_groups/delete', data, { loading: true });
};
