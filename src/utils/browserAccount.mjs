const text = value => (typeof value === 'string' ? value.trim() : '');

export const normalizeAccountOption = item => {
  const uuid = text(item?.uuid);
  if (!uuid) return null;

  const name = text(item?.apiName) || text(item?.api_name) || '未命名账号';
  const email = text(item?.email);

  return {
    uuid,
    name,
    email,
    label: email ? `${name} · ${email}` : name,
  };
};

export const normalizeAccountSearchResponse = response => {
  const rows = Array.isArray(response) ? response : response?.apikeyList;
  if (!Array.isArray(rows)) return [];

  const seen = new Set();
  const options = [];
  for (const row of rows) {
    const option = normalizeAccountOption(row);
    if (!option || seen.has(option.uuid)) continue;
    seen.add(option.uuid);
    options.push(option);
  }
  return options;
};

export const normalizeLinkedBrowserAccount = row => {
  const uuid = text(row?.email_uuid);
  const name = text(row?.account_name);
  const email = text(row?.account_email);
  if (!uuid) return null;

  return {
    uuid,
    name: name || '未命名账号',
    email,
    label: email ? `${name || '未命名账号'} · ${email}` : name || '未命名账号',
  };
};

export const mergeAccountOptions = (options, initialAccount) => {
  const current = normalizeLinkedBrowserAccount(initialAccount);
  if (!current || options.some(option => option.uuid === current.uuid)) return options;
  return [current, ...options];
};

export const hasUsableLinkedAccount = row => {
  const account = normalizeLinkedBrowserAccount(row);
  return Boolean(account?.email);
};

export const getBrowserAccountTooltip = row => {
  const account = normalizeLinkedBrowserAccount(row);
  if (!account) return '未关联账号';
  return account.email || '关联账号不可用';
};
