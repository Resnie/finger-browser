/**
 * 应用配置常量
 */

// 分页配置
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_SIZE: 20,
  PAGE_SIZES: [10, 20, 30, 40],
  MAX_SIZE: 1000,
};

// 本地存储 Key
export const STORAGE_KEYS = {
  TOKEN: 'token',
  USER_INFO: 'userInfo',
  REMEMBERED_USER: 'rememberedUser',
};

// 浏览器配置
export const BROWSER_CONFIG = {
  DEFAULT_URL: '',
  DEFAULT_VERSION: '',
};

// 操作系统选项
export const OPERATING_SYSTEMS = [
  { value: 'Windows NT 11.0', label: 'Windows 11' },
  { value: 'Windows NT 10.0', label: 'Windows 10' },
  { value: 'Windows NT 6.2', label: 'Windows 8' },
  { value: 'Windows NT 6.1', label: 'Windows 7' },
  { value: 'Macintosh', label: 'macOS' },
];

// 代理类型选项
export const PROXY_TYPES = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
];

// 代理获取方式
export const PROXY_METHODS = [
  { value: 'manual', label: '手动输入' },
  { value: 'api', label: 'API 获取' },
];

// 代理分隔符选项
export const PROXY_DELIMITERS = [
  { value: ':', label: '冒号 (:)' },
  { value: ',', label: '逗号 (,)' },
  { value: ';', label: '分号 (;)' },
  { value: '|', label: '竖线 (|)' },
  { value: '\t', label: 'Tab' },
  { value: ' ', label: '空格' },
];

// 浏览器实例状态
export const BROWSER_STATUS = {
  STARTED: 'started',
  CLOSED: 'closed',
};

// 日期格式
export const DATE_FORMATS = {
  DEFAULT: 'YYYY-MM-DD HH:mm',
  DATE_ONLY: 'YYYY-MM-DD',
  TIME_ONLY: 'HH:mm:ss',
  FULL: 'YYYY-MM-DD HH:mm:ss',
};

// API 响应状态码
export const API_CODES = {
  SUCCESS: 200,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SERVER_ERROR: 500,
};

// 表单验证规则
export const VALIDATION_RULES = {
  required: (message = '此字段为必填项') => ({
    required: true,
    message,
    trigger: 'blur',
  }),
  minLength: (min, message) => ({
    min,
    message: message || `最少输入 ${min} 个字符`,
    trigger: 'blur',
  }),
  maxLength: (max, message) => ({
    max,
    message: message || `最多输入 ${max} 个字符`,
    trigger: 'blur',
  }),
};
