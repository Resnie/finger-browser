const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function resolveApiOrigin(baseApiUrl, { production = false } = {}) {
  if (typeof baseApiUrl !== 'string' || baseApiUrl.trim() === '') {
    throw new Error('缺少 VITE_APP_BASE_API');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(baseApiUrl);
  } catch {
    throw new Error('VITE_APP_BASE_API 不是有效 URL');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('VITE_APP_BASE_API 仅支持 HTTP 或 HTTPS');
  }

  const isLoopback = LOOPBACK_HOSTNAMES.has(parsedUrl.hostname);
  if (production && parsedUrl.protocol !== 'https:' && !isLoopback) {
    throw new Error('生产环境 API 必须使用 HTTPS（本机回环地址除外）');
  }

  return parsedUrl.origin;
}
