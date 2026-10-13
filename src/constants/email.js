/**
 * 邮件服务器映射
 * 根据邮箱后缀自动匹配 IMAP/POP3 服务器
 */
export const EMAIL_SERVER_MAP = {
  'gmail.com': {
    imap: { host: 'imap.gmail.com', port: 993, tls: true },
    pop3: { host: 'pop.gmail.com', port: 995, tls: true },
  },
  'outlook.com': {
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    pop3: { host: 'outlook.office365.com', port: 995, tls: true },
  },
  'hotmail.com': {
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    pop3: { host: 'outlook.office365.com', port: 995, tls: true },
  },
  'live.com': {
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    pop3: { host: 'outlook.office365.com', port: 995, tls: true },
  },
  'outlook.top': {
    imap: { host: 'mail.outlook.top', port: 993, tls: true, verifyCertificate: false },
    pop3: { host: 'mail.outlook.top', port: 995, tls: true, verifyCertificate: false },
  },
  'yahoo.com': {
    imap: { host: 'imap.mail.yahoo.com', port: 993, tls: true },
    pop3: { host: 'pop.mail.yahoo.com', port: 995, tls: true },
  },
  'qq.com': {
    imap: { host: 'imap.qq.com', port: 993, tls: true },
    pop3: { host: 'pop.qq.com', port: 995, tls: true },
  },
  '163.com': {
    imap: { host: 'imap.163.com', port: 993, tls: true },
    pop3: { host: 'pop.163.com', port: 995, tls: true },
  },
  '126.com': {
    imap: { host: 'imap.126.com', port: 993, tls: true },
    pop3: { host: 'pop.126.com', port: 995, tls: true },
  },
  'foxmail.com': {
    imap: { host: 'imap.qq.com', port: 993, tls: true },
    pop3: { host: 'pop.qq.com', port: 995, tls: true },
  },
};

/**
 * 根据邮箱地址获取服务器配置
 * 优先匹配已知服务器，未知域名尝试通用 imap.{domain} / pop.{domain} 推测
 * @param {string} email - 邮箱地址
 * @param {string} type - 'imap' 或 'pop3'
 * @returns {Object|null} 服务器配置
 */
export const getEmailServerConfig = (email, type = 'imap') => {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  const known = EMAIL_SERVER_MAP[domain]?.[type];
  if (known) return known;

  // 未知域名：尝试通用推测
  if (type === 'imap') {
    return { host: `imap.${domain}`, port: 993, tls: true };
  }
  return { host: `pop.${domain}`, port: 995, tls: true };
};

/**
 * 邮件同步类型
 */
export const SYNC_TYPE = {
  IMAP: 'imap',
  POP3: 'pop3',
};

export const SYNC_TYPE_OPTIONS = [
  { value: SYNC_TYPE.IMAP, label: 'IMAP' },
  { value: SYNC_TYPE.POP3, label: 'POP3' },
];

/**
 * 认证状态（与旧项目 5 种状态一致）
 * 0=未检测, 1=认证成功, 2=认证失败, 3=失败→成功, 4=成功→失败
 */
export const AUTH_STATUS = {
  UNKNOWN: 0,
  SUCCESS: 1,
  FAIL: 2,
  FAIL_TO_SUCCESS: 3,
  SUCCESS_TO_FAIL: 4,
};

export const AUTH_STATUS_LABELS = {
  [AUTH_STATUS.UNKNOWN]: '未检测',
  [AUTH_STATUS.SUCCESS]: '已实名',
  [AUTH_STATUS.FAIL]: '未实名',
  [AUTH_STATUS.FAIL_TO_SUCCESS]: '失败→成功',
  [AUTH_STATUS.SUCCESS_TO_FAIL]: '成功→失败',
};

export const AUTH_STATUS_TYPES = {
  [AUTH_STATUS.UNKNOWN]: 'info',
  [AUTH_STATUS.SUCCESS]: 'success',
  [AUTH_STATUS.FAIL]: 'danger',
  [AUTH_STATUS.FAIL_TO_SUCCESS]: 'warning',
  [AUTH_STATUS.SUCCESS_TO_FAIL]: 'warning',
};

/**
 * 云端/本地存储模式
 */
export const STORAGE_MODE = {
  CLOUD: 1,
  LOCAL: 0,
};

export const STORAGE_MODE_OPTIONS = [
  { value: STORAGE_MODE.CLOUD, label: '云端' },
  { value: STORAGE_MODE.LOCAL, label: '本地' },
];
