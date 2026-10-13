/**
 * JSON 安全解析工具函数
 */

/**
 * 安全解析 JSON 字符串
 * @param {string} jsonString - JSON 字符串
 * @param {any} defaultValue - 解析失败时的默认值
 * @returns {any} 解析结果或默认值
 */
export const safeJsonParse = (jsonString, defaultValue = null) => {
  if (jsonString === null || jsonString === undefined) {
    return defaultValue;
  }

  if (typeof jsonString !== 'string') {
    return jsonString;
  }

  try {
    return JSON.parse(jsonString);
  } catch {
    // JSON 可能承载 Cookie、localStorage、代理或账号数据，日志不得回显原文。
    console.warn('[JSON] 解析失败，已使用默认值');
    return defaultValue;
  }
};

/**
 * 安全序列化为 JSON 字符串
 * @param {any} value - 要序列化的值
 * @param {string} defaultValue - 序列化失败时的默认值
 * @returns {string} JSON 字符串
 */
export const safeJsonStringify = (value, defaultValue = '{}') => {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    console.warn('[JSON] 序列化失败:', error.message);
    return defaultValue;
  }
};

/**
 * 解析浏览器实例表格数据
 * 将 JSON 字符串字段解析为对象
 * @param {Array} list - 原始数据列表
 * @returns {Array} 解析后的数据列表
 */
export const parseBrowserTableData = list => {
  if (!Array.isArray(list)) {
    return [];
  }

  return list.map(item => {
    // 恢复字段可包含 Cookie、IndexedDB 和凭据明文，不允许进入 Vue 响应式列表。
    // 新客户端由 Electron 主进程按 browserId 调用鉴权恢复详情接口。
    const {
      pages: _pages,
      state: _state,
      history: _history,
      credentials: _credentials,
      recoveryRevision: _recoveryRevision,
      recovery_revision: _recoveryRevisionSnake,
      ...metadata
    } = item;

    return {
      ...metadata,
      config: safeJsonParse(item.config, {}),
    };
  });
};

/**
 * 深拷贝对象（使用 JSON 序列化方式）
 * @param {any} obj - 要拷贝的对象
 * @returns {any} 拷贝后的对象
 */
export const deepClone = obj => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (error) {
    console.warn('[JSON] 深拷贝失败:', error.message);
    return obj;
  }
};

/**
 * 合并对象（深度合并）
 * @param {Object} target - 目标对象
 * @param {...Object} sources - 源对象
 * @returns {Object} 合并后的对象
 */
export const deepMerge = (target, ...sources) => {
  if (!sources.length) return target;

  const source = sources.shift();

  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key in source) {
      if (isPlainObject(source[key])) {
        if (!target[key]) {
          Object.assign(target, { [key]: {} });
        }
        deepMerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return deepMerge(target, ...sources);
};

/**
 * 判断是否为普通对象
 * @param {any} obj - 要判断的值
 * @returns {boolean}
 */
export const isPlainObject = obj => {
  return Object.prototype.toString.call(obj) === '[object Object]';
};

/**
 * 从对象中安全获取嵌套属性值
 * @param {Object} obj - 对象
 * @param {string} path - 属性路径，如 'a.b.c'
 * @param {any} defaultValue - 默认值
 * @returns {any} 属性值或默认值
 */
export const getNestedValue = (obj, path, defaultValue = undefined) => {
  if (!obj || !path) return defaultValue;

  const keys = path.split('.');
  let result = obj;

  for (const key of keys) {
    if (result === null || result === undefined) {
      return defaultValue;
    }
    result = result[key];
  }

  return result === undefined ? defaultValue : result;
};
