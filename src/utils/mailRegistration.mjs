export const getMailboxRegistrationState = config => {
  const domain = typeof config?.mailDomain === 'string' ? config.mailDomain.trim() : '';

  if (!domain) {
    return {
      available: false,
      domain: '',
      suffix: '@--',
      reason: '邮箱域名未配置，暂时无法注册邮箱',
    };
  }

  if (config?.isMailboxRegistrationConfigured !== true) {
    return {
      available: false,
      domain,
      suffix: `@${domain}`,
      reason: '邮箱创建服务未配置完整，暂时无法注册邮箱',
    };
  }

  return {
    available: true,
    domain,
    suffix: `@${domain}`,
    reason: '',
  };
};
