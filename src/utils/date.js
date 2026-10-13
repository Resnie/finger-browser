/**
 * 日期格式化工具函数
 */

/**
 * 格式化日期字符串
 * @param {string|Date|number} dateInput - 日期输入（字符串、Date对象或时间戳）
 * @param {string} format - 格式字符串，支持 YYYY、MM、DD、HH、mm、ss
 * @returns {string} 格式化后的日期字符串
 */
export const formatDate = (dateInput, format = 'YYYY-MM-DD HH:mm') => {
  if (!dateInput) return '';

  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);

  if (isNaN(date.getTime())) return '';

  const tokens = {
    YYYY: date.getFullYear(),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    DD: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
  };

  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, match => tokens[match]);
};

/**
 * 格式化为日期（不含时间）
 * @param {string|Date|number} dateInput - 日期输入
 * @returns {string} YYYY-MM-DD 格式的日期字符串
 */
export const formatDateOnly = dateInput => {
  return formatDate(dateInput, 'YYYY-MM-DD');
};

/**
 * 格式化为时间（不含日期）
 * @param {string|Date|number} dateInput - 日期输入
 * @returns {string} HH:mm:ss 格式的时间字符串
 */
export const formatTimeOnly = dateInput => {
  return formatDate(dateInput, 'HH:mm:ss');
};

/**
 * 格式化为完整日期时间
 * @param {string|Date|number} dateInput - 日期输入
 * @returns {string} YYYY-MM-DD HH:mm:ss 格式的日期时间字符串
 */
export const formatDateTime = dateInput => {
  return formatDate(dateInput, 'YYYY-MM-DD HH:mm:ss');
};

/**
 * 获取相对时间描述
 * @param {string|Date|number} dateInput - 日期输入
 * @returns {string} 相对时间描述（如：刚刚、5分钟前、1小时前等）
 */
export const getRelativeTime = dateInput => {
  if (!dateInput) return '';

  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const diff = now.getTime() - date.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;

  return formatDate(dateInput, 'YYYY-MM-DD');
};

/**
 * 判断日期是否是今天
 * @param {string|Date|number} dateInput - 日期输入
 * @returns {boolean}
 */
export const isToday = dateInput => {
  if (!dateInput) return false;

  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return false;

  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
};
