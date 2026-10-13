const EMPTY_CONNECTION_FIELDS = Object.freeze({
  host: '',
  port: 0,
  username: '',
  password: '',
});

const asProxyObject = proxy =>
  proxy && typeof proxy === 'object' && !Array.isArray(proxy) ? proxy : {};

/**
 * 生成可持久化的代理配置。
 *
 * host/port/username/password 都是运行时从 text 或 API 响应解析出的派生字段，
 * 不应沿用上一次启动产生的值。禁用代理时同时清除 text，确保重新启用必须重新填写。
 */
export const prepareProxyConfigForStorage = proxy => {
  const source = asProxyObject(proxy);
  const enabled = source.enabled === true;

  return {
    ...source,
    enabled,
    ...(enabled ? {} : { text: '' }),
    ...EMPTY_CONNECTION_FIELDS,
  };
};

export const isValidManualProxyText = (value, delimiter = ':') => {
  if (typeof value !== 'string' || typeof delimiter !== 'string' || !delimiter) return false;

  const parts = value.split(delimiter).map(item => item.trim());
  if (![2, 4].includes(parts.length)) return false;

  const [host, portText, username, password] = parts;
  const port = Number(portText);
  if (
    !host ||
    host.length > 253 ||
    /[\s/@?#]/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return false;
  }

  return parts.length === 2 || Boolean(username && password);
};
