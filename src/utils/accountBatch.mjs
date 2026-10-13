export const MAX_ACCOUNT_BATCH_ITEMS = 500;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 只解析和校验快速添加的输入。
 * 不在客户端去重或判断是否已存在，净新增数由服务端统一裁决。
 */
export const parseFastAddAccountRows = content => {
  const rows = [];
  const invalidRows = [];
  const lines = String(content || '').split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    if (!rawLine.trim()) return;

    const parts = rawLine.split('----');
    const email = (parts[0] || '').trim();
    const mailPassword = parts[1] ?? '';

    if (parts.length < 2 || !email || !mailPassword) {
      invalidRows.push(`第 ${index + 1} 行缺少邮箱或密码`);
      return;
    }

    if (!EMAIL_PATTERN.test(email)) {
      invalidRows.push(`第 ${index + 1} 行邮箱格式不正确`);
      return;
    }

    rows.push({
      apiName: (parts[4] || '').trim() || email,
      email,
      mailPassword,
      bianPassword: parts[3] ?? '',
      googleAuth: (parts[2] || '').trim(),
    });
  });

  return { rows, invalidRows };
};

export const getAccountBatchSizeError = rows => {
  if (!Array.isArray(rows) || rows.length === 0) return '未解析到数据';
  if (rows.length > MAX_ACCOUNT_BATCH_ITEMS) {
    return `单次最多处理 ${MAX_ACCOUNT_BATCH_ITEMS} 条账号数据`;
  }
  return '';
};
