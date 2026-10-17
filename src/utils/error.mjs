const IPC_ERROR_PREFIX = /^Error invoking remote method\s+['"][^'"]+['"]:\s*/i;
const GENERIC_ERROR_PREFIX = /^Error:\s*/i;

const DEFAULT_MESSAGE = '操作失败，请稍后重试';
const INTERNAL_DETAILS = /https?:\/\/|file:\/\/|[A-Z]:[\\/]|\/(?:Users|private|var|tmp|home|Applications)\/|\bat\s+\S+\s*\(|\b(?:SELECT|INSERT|UPDATE|DELETE)\s+|SQLSTATE|AxiosError|Protocol error|net::|ENOENT|EACCES|browserType\.|socket hang up|\{.*["']\w+["']\s*:|<[^>]+>|(?:token|password|secret|authorization)\s*[=:]/i;
const REASONS = [
  [/^未知错误$|登录失败.*有效会话/, '操作失败，请稍后重试'],
  [/运行锁仍由原设备持有|原设备.*占用/, '此环境由原设备占用，请在原设备保存并关闭后再打开'],
  [/属于其他登录用户|不属于当前登录用户|用户归属/, '此环境属于其他账号，请切换到原账号操作'],
  [/原浏览器进程尚未退出|实例 .*仍在关闭|正在启动或关闭/, '浏览器正在启动或关闭，请稍后重试'],
  [/运行锁.*(?:失效|超时|有效期异常)/, '环境状态已失效，请检查网络后重新打开'],
  [/安全存储|无法解密|快照.*(?:加密|损坏|校验失败)/, '本地数据无法安全保存，请检查系统安全存储后重试'],
  [/尚未.*同步|未能安全收口|恢复数据尚未确认保存/, '数据尚未同步完成，请检查网络后重试'],
  [/快照.*(?:已变化|不一致)|恢复版本.*(?:不一致|已变化)|阻止回滚|另一台电脑更新/, '环境数据已变化，请刷新列表后重试'],
  [/本机存在 v1|服务端需升级|无法确认服务端.*(?:恢复|互锁)/, '当前版本无法同步此环境，请更新客户端和服务端'],
  [/云端.*(?:恢复失败|数据不完整)|权威存储快照恢复失败|会话存储恢复失败/, '环境数据恢复失败，请检查网络后重试'],
  [/恢复版本.*(?:无效|未返回)|不是受控实体|路径越界|Outbox|待同步序列|恢复序列|可回滚状态/, '环境数据无法恢复，请刷新列表后重试'],
  [/代理提取认证失败/, '代理提取认证失败，请更新服务商提供的提取链接'],
  [/代理.*(?:无效|失败|不可达|无法)|ERR_PROXY|ERR_SOCKS|proxy.*(?:fail|refused|auth)/i, '代理连接失败，请检查代理地址和账号密码'],
  [/内核.*(?:不完整|未找到)|executable.*(?:exist|not found)/i, '内核文件不完整，请重新下载内核'],
  [/User-Agent.*不一致/, '内核与浏览器标识不一致，请编辑环境并重新生成 User-Agent'],
  [/certificate|CERT_|证书.*(?:过期|无效)|self.signed/i, '连接证书无效，请检查服务器证书'],
  [/authentication failed|invalid credentials|LOGIN failed|密码.*(?:错误|无效)|账号或密码错误/i, '账号或密码不正确，请检查后重试'],
  [/ECONNABORTED|ETIMEDOUT|timeout|超时/i, '连接超时，请检查网络后重试'],
  [/ECONNREFUSED|ECONNRESET|ENOTFOUND|ERR_NETWORK|Network Error|网络连接异常|连接中断|提前关闭了连接/i, '连接失败，请检查网络后重试'],
  [/服务器内部错误|SQLSTATE|\b(?:SELECT|INSERT)\s+/i, '服务暂时不可用，请稍后重试'],
];

/** 只展示简短、可处理的原因；原始异常由对应业务日志记录。 */
export const getUserFacingErrorMessage = (error, fallback = '') => {
  const raw = typeof error === 'string' ? error : error?.message;
  let message = String(raw || '')
    .split(/\r?\n/, 1)[0]
    .trim();

  let previous = '';
  while (message && message !== previous) {
    previous = message;
    message = message.replace(IPC_ERROR_PREFIX, '').replace(GENERIC_ERROR_PREFIX, '').trim();
  }

  for (const [pattern, text] of REASONS) {
    if (pattern.test(message)) return text;
  }
  // 页面可能已添加“打开窗口失败：”等前缀，检查其后的真实原因。
  const reason = message.replace(/^.{1,20}失败[：:]\s*/, '');
  if (reason && /[\u3400-\u9fff]/.test(reason) && reason.length <= 90 && !INTERNAL_DETAILS.test(reason)) {
    return /失败$/.test(reason) ? `${reason}，请稍后重试` : reason;
  }
  const safeFallback = typeof fallback === 'string' ? fallback.trim() : '';
  if (safeFallback && /[\u3400-\u9fff]/.test(safeFallback) && safeFallback.length <= 90 && !INTERNAL_DETAILS.test(safeFallback)) {
    return safeFallback;
  }
  const operation = message.match(/^([^：:\n]{1,20}失败)[：:]/)?.[1];
  return operation && /[\u3400-\u9fff]/.test(operation) && !INTERNAL_DETAILS.test(operation)
    ? `${operation}，请稍后重试`
    : DEFAULT_MESSAGE;
};

/** 同一个错误只提示一次；连续失败最多保留一个浮层，避免遮挡操作。 */
export const createErrorFeedback = (notify, { now = Date.now, interval = 3000 } = {}) => {
  const recent = new Map();
  let active;
  return (input, fallback, type = 'error') => {
    if (input?.isNotified || input === 'cancel' || input === 'close' || input === '用户取消') return;
    const options = input && typeof input === 'object' && !(input instanceof Error) ? input : {};
    const message = getUserFacingErrorMessage(input, fallback);
    const time = now();
    for (const [key, shown] of recent) if (time - shown >= interval) recent.delete(key);
    if (recent.has(message)) {
      if (input && typeof input === 'object') input.isNotified = true;
      return active;
    }
    recent.set(message, time);
    if (input && typeof input === 'object') input.isNotified = true;
    active?.close();
    let handle;
    handle = notify({
      message,
      type: type === 'warning' ? 'warning' : 'error',
      customClass: 'app-error-message',
      dangerouslyUseHTMLString: false,
      showClose: true,
      duration: options.duration === 0 ? 0 : 5000,
      grouping: false,
      onClose: () => {
        if (active === handle) active = undefined;
        options.onClose?.();
      },
    });
    active = handle;
    return handle;
  };
};
