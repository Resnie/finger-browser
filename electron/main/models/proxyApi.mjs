export class ProxyApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProxyApiError';
    this.code = code;
  }
}

export const resolveProxyApiRequestUrl = apiUrl => {
  let url;
  try { url = new URL(apiUrl); } catch {
    throw new ProxyApiError('PROXY_API_URL', '请填写有效的代理 API 链接');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ProxyApiError('PROXY_API_URL', '代理 API 仅支持 HTTP/HTTPS');
  }
  // 91HTTP can return only ip:port while the selected proxy still requires
  // authentication. Request its documented credentials without changing the
  // saved URL, chosen protocol, quantity, or other provider parameters.
  if (url.hostname === 'api.91http.com' && url.pathname === '/v1/get-ip' && !url.searchParams.has('pw')) {
    url.searchParams.set('pw', '1');
  }
  return url.href;
};

const invalidResponse = () =>
  new ProxyApiError('PROXY_API_FORMAT', '代理 API 未返回有效 IP 和端口，请检查返回格式');

const providerFailure = node => {
  const reason = String(node.detail || node.msg || node.message || node.error || '');
  const status = node.status ?? node.code ?? node.error_code;
  const statusText = /^\d{1,6}$/.test(String(status)) ? `（状态 ${status}）` : '';
  let message = '代理服务商拒绝提取，请检查提取链接和套餐';
  if (/白名单|whitelist|white.?list/i.test(reason)) {
    message = '代理服务商要求添加本机 IP 白名单，请在服务商后台添加后重试';
  } else if (/余额|balance|积分.*不足|点数.*不足/i.test(reason)) {
    message = '代理套餐余额不足，请检查服务商套餐';
  } else if (/过期|到期|expired/i.test(reason)) {
    message = '代理套餐或提取链接已过期，请更新有效提取链接';
  } else if (/认证|鉴权|密码|签名|session|token|登录|unauthorized|auth/i.test(reason)) {
    message = '代理提取认证失败，请更新服务商提供的提取链接';
  }
  // Raw responses can contain API tokens, usernames and passwords. Only these
  // fixed, actionable messages and a bounded numeric status reach the UI/log.
  return new ProxyApiError('PROXY_API_PROVIDER_REJECTED', message + statusText);
};

const assertProviderSuccess = node => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if (node.success === false) throw providerFailure(node);
  for (const field of ['status', 'code', 'error_code']) {
    if (node[field] === undefined || node[field] === null || node[field] === '') continue;
    if (!['0', '200', 'true', 'ok', 'success'].includes(String(node[field]).toLowerCase())) {
      throw providerFailure(node);
    }
  }
};

const connectionText = (host, port, user = '', pass = '', delimiter = ':') => {
  if (![host, port, user, pass].every(value => ['string', 'number'].includes(typeof value))) {
    return '';
  }
  host = String(host).trim();
  port = String(port).trim();
  user = String(user).trim();
  pass = String(pass).trim();
  const portNumber = Number(port);
  if (
    !host || host.length > 253 || /[\s/@?#]/.test(host) || host.includes(delimiter) ||
    !/^\d+$/.test(port) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535 ||
    Boolean(user) !== Boolean(pass) || user.includes(delimiter) || pass.includes(delimiter)
  ) return '';
  return [host, portNumber, ...(user ? [user, pass] : [])].join(delimiter);
};

const parseText = (text, delimiter) => {
  const line = text.split(/[\r\n]+/).map(value => value.trim()).find(Boolean) || '';
  const parts = line.split(delimiter);
  if (parts.length === 2 || parts.length === 4) {
    const direct = connectionText(parts[0], parts[1], parts[2] || '', parts[3] || '', delimiter);
    if (direct) return direct;
  }
  // Providers also offer ip:port@user:password and user:password@ip:port.
  const at = line.split('@');
  if (at.length === 2) {
    const left = at[0].split(delimiter), right = at[1].split(delimiter);
    if (left.length === 2 && right.length === 2) {
      return connectionText(left[0], left[1], right[0], right[1], delimiter) ||
        connectionText(right[0], right[1], left[0], left[1], delimiter);
    }
  }
  return '';
};

const extract = (node, delimiter, depth = 0) => {
  if (depth > 5) return '';
  if (typeof node === 'string') return parseText(node.trim(), delimiter);
  if (Array.isArray(node)) return node.length ? extract(node[0], delimiter, depth + 1) : '';
  if (!node || typeof node !== 'object') return '';
  assertProviderSuccess(node);
  const host = node.ip ?? node.host ?? node.server ?? node.sever ?? node.proxy_ip;
  const port = node.port ?? node.proxy_port;
  if (host !== undefined && port !== undefined) {
    return connectionText(host, port, node.user ?? node.username ?? '', node.pass ?? node.password ?? node.pw ?? '', delimiter);
  }
  for (const key of ['data', 'list', 'proxies', 'result']) {
    if (node[key] !== undefined) {
      const proxy = extract(node[key], delimiter, depth + 1);
      if (proxy) return proxy;
    }
  }
  return '';
};

export const parseProxyApiResponse = (data, { delimiter = ':' } = {}) => {
  if (typeof delimiter !== 'string' || !delimiter || delimiter.length > 8) throw invalidResponse();
  if (typeof data === 'string') {
    data = data.trim();
    if (!data) throw new ProxyApiError('PROXY_API_EMPTY', '代理 API 返回空内容，请检查提取链接');
    if (data.startsWith('{') || data.startsWith('[')) {
      try { data = JSON.parse(data); } catch { throw invalidResponse(); }
    }
  }
  const proxy = extract(data, delimiter);
  if (!proxy) throw invalidResponse();
  return proxy;
};

export const normalizeProxyApiRequestError = error => {
  if (error instanceof ProxyApiError) return error;
  const status = Number(error?.response?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return new ProxyApiError('PROXY_API_HTTP', `代理 API 请求失败（HTTP ${status}），请检查提取链接`);
  }
  const timedOut = ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code);
  return new ProxyApiError('PROXY_API_NETWORK', timedOut
    ? '代理 API 请求超时，请稍后重试'
    : '无法连接代理 API，请检查网络和提取链接');
};
