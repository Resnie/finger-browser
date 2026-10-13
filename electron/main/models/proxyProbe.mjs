import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { closeContextWithTimeout } from './browserLifecycle.mjs';

export const DEFAULT_PROXY_PROBE_TIMEOUT_MS = 9000;
export const DEFAULT_PROXY_PROBE_CLOSE_TIMEOUT_MS = 3000;

export const DEFAULT_PROXY_PROBE_TARGETS = Object.freeze([
  Object.freeze({
    name: 'ipify',
    url: 'https://api.ipify.org?format=json',
    responseType: 'json',
  }),
  Object.freeze({
    name: 'cloudflare',
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
    responseType: 'trace',
  }),
]);

export class ProxyProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProxyProbeError';
    this.code = code;
  }
}

const assertProxyConfig = proxyConfig => {
  if (!proxyConfig || typeof proxyConfig.server !== 'string' || !proxyConfig.server.trim()) {
    throw new ProxyProbeError('PROXY_CONFIG_INVALID', '代理配置无效，已阻止启动');
  }

  let serverUrl;
  try {
    serverUrl = new URL(proxyConfig.server);
  } catch {
    throw new ProxyProbeError('PROXY_CONFIG_INVALID', '代理地址无效，已阻止启动');
  }

  if (!['http:', 'https:', 'socks5:'].includes(serverUrl.protocol)) {
    throw new ProxyProbeError('PROXY_CONFIG_INVALID', '代理协议不受支持，已阻止启动');
  }

  const port = Number(serverUrl.port);
  if (
    !serverUrl.hostname ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !['', '/'].includes(serverUrl.pathname) ||
    serverUrl.search ||
    serverUrl.hash
  ) {
    throw new ProxyProbeError('PROXY_CONFIG_INVALID', '代理主机或端口无效，已阻止启动');
  }

  if (serverUrl.username || serverUrl.password) {
    throw new ProxyProbeError('PROXY_CONFIG_INVALID', '代理认证信息必须与地址分开配置');
  }

  if (Boolean(proxyConfig.username) !== Boolean(proxyConfig.password)) {
    throw new ProxyProbeError('PROXY_CONFIG_INVALID', '代理用户名和密码必须同时填写');
  }
};

const isUsableExitIp = ip => {
  const normalized = ip.trim().toLowerCase();
  const version = isIP(normalized);
  if (version === 4) {
    const octets = normalized.split('.').map(Number);
    const [a, b, c] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  if (version === 6) {
    if (normalized.startsWith('::ffff:')) {
      return isUsableExitIp(normalized.slice('::ffff:'.length));
    }
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }

  return false;
};

const extractExitIp = (body, responseType) => {
  if (typeof body !== 'string' || !body.trim()) return '';

  if (responseType === 'json') {
    try {
      const ip = JSON.parse(body).ip;
      return typeof ip === 'string' && isUsableExitIp(ip) ? ip.trim() : '';
    } catch {
      return '';
    }
  }

  if (responseType === 'trace') {
    const match = body.match(/^ip=(.+)$/m);
    const ip = match?.[1]?.trim() || '';
    return isUsableExitIp(ip) ? ip : '';
  }

  const ip = body.trim();
  return isUsableExitIp(ip) ? ip : '';
};

const classifyRequestFailure = error => {
  const message = String(error?.message || '').toLowerCase();
  if (
    message.includes('407') ||
    message.includes('proxy authentication') ||
    message.includes('invalid_auth_credentials')
  ) {
    return 'auth';
  }
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  return 'network';
};

const probeTarget = async (context, target, timeoutMs, closeTimeoutMs) => {
  let page;
  try {
    page = await context.newPage();
    const response = await page.goto(target.url, {
      timeout: timeoutMs,
      waitUntil: 'domcontentloaded',
    });
    if (!response) return { ok: false, reason: 'network' };

    const status = response.status();
    if (status === 407) return { ok: false, reason: 'auth' };
    if (status < 200 || status >= 300) return { ok: false, reason: 'http' };

    const body = await response.text();
    if (!extractExitIp(body, target.responseType)) {
      return { ok: false, reason: 'invalid-response' };
    }

    return { ok: true, target: target.name };
  } catch (error) {
    return { ok: false, reason: classifyRequestFailure(error) };
  } finally {
    if (page) {
      try {
        await waitWithTimeout(
          () => page.close(),
          closeTimeoutMs,
          '代理检测页关闭超时'
        );
      } catch {
        // context/Browser 级关闭会在探测结束时继续收口。
      }
    }
  }
};

const createFailure = (results, timeoutMs) => {
  const reasons = new Set(results.map(result => result?.reason).filter(Boolean));
  if (reasons.has('auth')) {
    return new ProxyProbeError('PROXY_AUTH_REQUIRED', '代理认证失败（HTTP 407），已阻止启动');
  }
  if (reasons.has('invalid-response')) {
    return new ProxyProbeError('PROXY_EXIT_INVALID', '代理未返回有效出口地址，已阻止启动');
  }
  if (reasons.has('timeout')) {
    return new ProxyProbeError(
      'PROXY_TIMEOUT',
      `代理连接超时（${Math.round(timeoutMs / 1000)} 秒），已阻止启动`
    );
  }
  if (reasons.has('http')) {
    return new ProxyProbeError(
      'PROXY_HTTPS_UNAVAILABLE',
      '无法通过代理访问 HTTPS 探测服务，已阻止启动'
    );
  }
  return new ProxyProbeError('PROXY_UNREACHABLE', '代理不可达或无法访问互联网，已阻止启动');
};

const createDefaultProfile = () => fs.mkdtemp(path.join(os.tmpdir(), 'finger-proxy-probe-'));
const removeDefaultProfile = profilePath =>
  fs.rm(profilePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

const waitWithTimeout = async (operation, timeoutMs, timeoutMessage) => {
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

/**
 * persistent context 的 close 事件或 close() 任一收敛即视为已关闭。
 * 两者均超时时再用 Browser.close() 停止临时内核，全程有界。
 */
const closeProbeContext = async (context, timeoutMs) => {
  try {
    await closeContextWithTimeout(context, timeoutMs);
    return;
  } catch (contextCloseError) {
    const browser = context?.browser?.();
    if (!browser || typeof browser.close !== 'function') throw contextCloseError;
    await waitWithTimeout(
      () => browser.close(),
      timeoutMs,
      '代理检测内核关闭超时'
    );
  }
};

const removeProbeProfile = (removeProfile, profilePath, timeoutMs) =>
  waitWithTimeout(
    () => removeProfile(profilePath),
    timeoutMs,
    '代理检测临时目录清理超时'
  );

const buildProbeLaunchOptions = (proxyConfig, contextOptions) => {
  const executablePath = contextOptions?.executablePath;
  if (typeof executablePath !== 'string' || !executablePath.trim()) {
    throw new ProxyProbeError('PROXY_PROBE_UNAVAILABLE', '代理检测缺少实际浏览器内核，已阻止启动');
  }

  return {
    executablePath,
    headless: true,
    proxy: {
      server: proxyConfig.server,
      ...(proxyConfig.username ? { username: proxyConfig.username } : {}),
      ...(proxyConfig.password ? { password: proxyConfig.password } : {}),
    },
    ignoreHTTPSErrors: false,
    ...(Array.isArray(contextOptions.args) ? { args: [...contextOptions.args] } : {}),
    ...(typeof contextOptions.userAgent === 'string'
      ? { userAgent: contextOptions.userAgent }
      : {}),
    ...(typeof contextOptions.locale === 'string' ? { locale: contextOptions.locale } : {}),
  };
};

/**
 * 使用与真实窗口相同的 Chromium 内核和持久化上下文路径验证 HTTPS 出口。
 * 临时 profile 不携带业务 Cookie/存储；探测失败不会回退直连。
 */
export const probeProxyConnectivity = async (
  proxyConfig,
  {
    launchPersistentContext,
    contextOptions,
    targets = DEFAULT_PROXY_PROBE_TARGETS,
    timeoutMs = DEFAULT_PROXY_PROBE_TIMEOUT_MS,
    closeTimeoutMs = DEFAULT_PROXY_PROBE_CLOSE_TIMEOUT_MS,
    createProfile = createDefaultProfile,
    removeProfile = removeDefaultProfile,
  } = {}
) => {
  assertProxyConfig(proxyConfig);
  if (typeof launchPersistentContext !== 'function') {
    throw new ProxyProbeError('PROXY_PROBE_UNAVAILABLE', '代理检测组件不可用，已阻止启动');
  }
  if (typeof createProfile !== 'function' || typeof removeProfile !== 'function') {
    throw new ProxyProbeError('PROXY_PROBE_UNAVAILABLE', '代理检测临时目录不可用，已阻止启动');
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new ProxyProbeError('PROXY_PROBE_UNAVAILABLE', '代理检测地址未配置，已阻止启动');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new ProxyProbeError('PROXY_PROBE_UNAVAILABLE', '代理检测超时配置无效，已阻止启动');
  }
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs < 10 || closeTimeoutMs > 10000) {
    throw new ProxyProbeError('PROXY_PROBE_UNAVAILABLE', '代理检测关闭超时配置无效，已阻止启动');
  }

  for (const target of targets) {
    let parsedUrl;
    try {
      parsedUrl = new URL(target?.url);
    } catch {
      throw new ProxyProbeError('PROXY_PROBE_UNAVAILABLE', '代理检测地址无效，已阻止启动');
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new ProxyProbeError('PROXY_PROBE_UNAVAILABLE', '代理检测仅允许 HTTPS 地址');
    }
  }

  const launchOptions = buildProbeLaunchOptions(proxyConfig, contextOptions);
  let profilePath = '';
  let context;
  try {
    profilePath = await createProfile();
    context = await launchPersistentContext(profilePath, launchOptions);
  } catch {
    if (profilePath) {
      try {
        await removeProbeProfile(removeProfile, profilePath, closeTimeoutMs);
      } catch {
        throw new ProxyProbeError(
          'PROXY_PROBE_CLEANUP_FAILED',
          '代理检测资源未能安全清理，已阻止启动'
        );
      }
    }
    throw new ProxyProbeError('PROXY_PROBE_UNAVAILABLE', '代理检测内核启动失败，已阻止启动');
  }

  try {
    const results = [];
    // 串行探测避免短效/限并发代理被同时占用多条连接。
    for (const target of targets) {
      const result = await probeTarget(context, target, timeoutMs, closeTimeoutMs);
      if (result.ok) return result;
      results.push(result);
    }
    throw createFailure(results, timeoutMs);
  } finally {
    let cleanupFailed = false;
    try {
      await closeProbeContext(context, closeTimeoutMs);
    } catch {
      cleanupFailed = true;
    }
    try {
      await removeProbeProfile(removeProfile, profilePath, closeTimeoutMs);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      throw new ProxyProbeError(
        'PROXY_PROBE_CLEANUP_FAILED',
        '代理检测资源未能安全清理，已阻止启动'
      );
    }
  }
};
