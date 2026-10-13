const RESOURCE_META = Object.freeze({
  browser: {
    label: '浏览器窗口',
    shortLabel: '窗口',
    description: '独立的指纹浏览器环境',
  },
  account: {
    label: '账号资料',
    shortLabel: '账号',
    description: '账号管理中的登录资料',
  },
});

const BILL_CATEGORY_LABELS = Object.freeze({
  browser_create: '创建浏览器窗口',
  account_create: '创建账号',
  recharge: '充值',
  refund: '退款',
  adjustment: '余额调整',
  server_fee: '服务器费用',
  strategy_fee: '策略费用',
  app_fee: '应用费用',
});

const BILL_DIRECTION_LABELS = Object.freeze({
  credit: '收入',
  debit: '支出',
});

const toSafeInteger = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
};

const toStringOrEmpty = value => (typeof value === 'string' ? value.trim() : '');

export const isIntegerString = value => /^(?:0|[1-9]\d*)$/.test(toStringOrEmpty(value));

export const isDecimalString = value => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(toStringOrEmpty(value));

const formatWalletMinor = (value, scale) => {
  const raw = toStringOrEmpty(value);
  if (/^-(?:0|[1-9]\d*)$/.test(raw)) return `-${formatMinorAmount(raw.slice(1), scale)}`;
  return formatMinorAmount(raw, scale);
};

export const formatMinorAmount = (minor, scale = 6) => {
  const raw = toStringOrEmpty(minor);
  const safeScale = Math.min(18, toSafeInteger(scale, 6));
  if (!isIntegerString(raw)) return '';
  if (safeScale === 0) return raw;
  const padded = raw.padStart(safeScale + 1, '0');
  return `${padded.slice(0, -safeScale)}.${padded.slice(-safeScale)}`;
};

export const multiplyMinorAmount = (minor, quantity, scale = 6) => {
  if (!isIntegerString(minor)) return null;
  const count = toSafeInteger(quantity, 0);
  if (count < 1) return null;
  const totalMinor = (BigInt(minor) * BigInt(count)).toString();
  return {
    minor: totalMinor,
    amount: formatMinorAmount(totalMinor, scale),
  };
};

export const hasEnoughBalance = (balanceMinor, requiredMinor) => {
  if (!isIntegerString(balanceMinor) || !isIntegerString(requiredMinor)) return false;
  return BigInt(balanceMinor) >= BigInt(requiredMinor);
};

export const getResourceMeta = resource =>
  RESOURCE_META[resource] || {
    label: resource || '未知项目',
    shortLabel: resource || '未知项目',
    description: '',
  };

export const getBillCategoryLabel = category =>
  BILL_CATEGORY_LABELS[category] || category || '其他';

export const getBillDirectionLabel = direction =>
  BILL_DIRECTION_LABELS[direction] || direction || '未知';

export const normalizeBillingSummary = source => {
  const data = source && typeof source === 'object' ? source : {};
  const scale = Math.min(18, toSafeInteger(data.scale, 6));
  const wallet = data.wallet && typeof data.wallet === 'object' ? data.wallet : {};
  const balanceMinor = toStringOrEmpty(wallet.balanceMinor);
  const formattedBalanceMinor = formatWalletMinor(balanceMinor, scale);
  const balance =
    formattedBalanceMinor || (isDecimalString(wallet.balance) ? wallet.balance.trim() : '');

  const pricing = (Array.isArray(data.pricing) ? data.pricing : [])
    .filter(
      item => item && RESOURCE_META[item.resource] && ['per_create', 'monthly'].includes(item.mode)
    )
    .map(item => ({
      resource: item.resource,
      mode: item.mode,
      status: ['pending', 'disabled', 'active'].includes(item.status) ? item.status : 'pending',
      unitPrice: isDecimalString(item.unitPrice) ? item.unitPrice.trim() : '',
      unitPriceMinor: isIntegerString(item.unitPriceMinor) ? item.unitPriceMinor.trim() : '',
    }));

  const usage = (Array.isArray(data.usage) ? data.usage : [])
    .filter(item => item && RESOURCE_META[item.resource])
    .map(item => {
      const lifetimeCreated = toSafeInteger(item.lifetimeCreated);
      const freeLimit = toSafeInteger(item.freeLimit, 10);
      const calculatedRemaining = Math.max(0, freeLimit - lifetimeCreated);
      const freeRemaining = Math.min(
        freeLimit,
        toSafeInteger(item.freeRemaining, calculatedRemaining)
      );
      return {
        resource: item.resource,
        lifetimeCreated,
        freeLimit,
        freeRemaining,
        freeUsed: Math.min(freeLimit, toSafeInteger(item.freeUsed, lifetimeCreated)),
        billingRequired: Boolean(item.billingRequired) || freeRemaining === 0,
      };
    });

  return {
    currency: data.currency === 'USDT' ? 'USDT' : '',
    scale,
    wallet: {
      balance: balance || '',
      balanceMinor: /^-?(?:0|[1-9]\d*)$/.test(balanceMinor) ? balanceMinor : '',
    },
    pricing,
    usage,
    supportedModes: Array.isArray(data.supportedModes)
      ? data.supportedModes.filter(mode => ['per_create', 'monthly'].includes(mode))
      : [],
    rechargeEnabled: data.rechargeEnabled === true,
    sharedAccount: data.sharedAccount === true,
  };
};

export const getResourceBillingState = (rawSummary, resource, quantity = 1) => {
  const summary = normalizeBillingSummary(rawSummary);
  const count = Math.max(1, toSafeInteger(quantity, 1));
  const usage = summary.usage.find(item => item.resource === resource);
  const pricing = summary.pricing.find(
    item => item.resource === resource && item.mode === 'per_create'
  );
  const meta = getResourceMeta(resource);

  if (summary.currency !== 'USDT') {
    return {
      allowed: false,
      kind: 'unavailable',
      title: '暂时无法确认计费状态',
      description: '服务端未返回有效的 USDT 计费信息，请刷新后再试。',
      resource,
      quantity: count,
      billableCount: 0,
      meta,
      usage: usage || null,
      pricing: pricing || null,
      totalPrice: '',
      totalPriceMinor: '',
    };
  }

  if (!usage) {
    return {
      allowed: false,
      kind: 'unavailable',
      title: '暂时无法确认计费状态',
      description: '未读取到免费额度，请刷新后再试。',
      resource,
      quantity: count,
      billableCount: 0,
      meta,
      usage: null,
      pricing: pricing || null,
      totalPrice: '',
      totalPriceMinor: '',
    };
  }

  const freeCovered = Math.min(usage.freeRemaining, count);
  const billableCount = count - freeCovered;
  const common = {
    resource,
    quantity: count,
    billableCount,
    meta,
    usage,
    pricing: pricing || null,
  };

  if (billableCount === 0) {
    return {
      ...common,
      allowed: true,
      kind: 'free',
      title: '本次创建免费',
      description: `免费额度已用 ${usage.freeUsed}/${usage.freeLimit}，本次后剩余 ${Math.max(0, usage.freeRemaining - count)} 次。删除后不返还额度。`,
      totalPrice: formatMinorAmount('0', summary.scale),
      totalPriceMinor: '0',
    };
  }

  if (
    !pricing ||
    pricing.status !== 'active' ||
    !pricing.unitPriceMinor ||
    pricing.unitPriceMinor === '0'
  ) {
    return {
      ...common,
      allowed: false,
      kind: 'pending',
      title: '超额计费尚未启用',
      description:
        freeCovered > 0
          ? `本次 ${count} 个中 ${freeCovered} 个可用免费额度，另 ${billableCount} 个需计费；当前超额计费尚未启用。`
          : `免费额度已用 ${usage.freeUsed}/${usage.freeLimit}，当前超额计费尚未启用，暂时不能继续创建。`,
      totalPrice: '',
      totalPriceMinor: '',
    };
  }

  const total = multiplyMinorAmount(pricing.unitPriceMinor, billableCount, summary.scale);
  if (!total) {
    return {
      ...common,
      allowed: false,
      kind: 'unavailable',
      title: '计费配置异常',
      description: '未读取到有效单价，请稍后重试。',
      totalPrice: '',
      totalPriceMinor: '',
    };
  }

  if (!summary.wallet.balanceMinor) {
    return {
      ...common,
      allowed: false,
      kind: 'unavailable',
      title: '暂时无法确认 USDT 余额',
      description: '未读取到有效余额，请刷新后再试。',
      totalPrice: total.amount,
      totalPriceMinor: total.minor,
    };
  }

  if (!hasEnoughBalance(summary.wallet.balanceMinor, total.minor)) {
    return {
      ...common,
      allowed: false,
      kind: 'insufficient',
      title: 'USDT 余额不足',
      description: `本次需支付 ${total.amount} USDT，当前余额 ${summary.wallet.balance || '—'} USDT，请充值后再试。`,
      totalPrice: total.amount,
      totalPriceMinor: total.minor,
    };
  }

  return {
    ...common,
    allowed: true,
    kind: 'paid',
    title: `本次创建将收取 ${total.amount} USDT`,
    description: `${billableCount} 个${meta.shortLabel}按次计费，余额将由服务端成交时扣减。`,
    totalPrice: total.amount,
    totalPriceMinor: total.minor,
  };
};

const BILLING_FAILURE_REASONS = new Set([
  'PRICE_NOT_CONFIGURED',
  'INSUFFICIENT_BALANCE',
  'FREE_QUOTA_EXCEEDED',
]);

/**
 * 将服务端创建计费错误转换为用户可直接理解的提示。
 * 价格、余额和充值建议只信任服务端结构化数据，不解析错误文案。
 */
export const getCreationBillingFailure = (error, { batch = false } = {}) => {
  const data = error?.apiData;
  if (!data || typeof data !== 'object' || !BILLING_FAILURE_REASONS.has(data.reason)) {
    return null;
  }

  const rejectedBatch = batch || data.batchRejected === true;
  const scope = rejectedBatch ? '本批次未执行' : '本次创建未执行';
  const requested = toSafeInteger(data.requested, 0);
  const freeRemaining = toSafeInteger(data.freeRemaining, 0);
  const quantityDetail =
    rejectedBatch && requested > 0
      ? `（净新增 ${requested} 条，剩余免费次数 ${freeRemaining}）`
      : '';

  if (data.reason === 'INSUFFICIENT_BALANCE') {
    return {
      reason: data.reason,
      type: 'error',
      rechargeRequired: true,
      message: `USDT 余额不足，${scope}${quantityDetail}，请充值后再试。`,
    };
  }

  if (data.reason === 'PRICE_NOT_CONFIGURED') {
    return {
      reason: data.reason,
      type: 'warning',
      rechargeRequired: false,
      message: `超额创建单价尚未配置，${scope}${quantityDetail}，请等待后台完成价格配置。`,
    };
  }

  const shouldRecharge = data.rechargeRequired === true || data.suggestedAction === 'RECHARGE';
  return {
    reason: data.reason,
    type: shouldRecharge ? 'error' : 'warning',
    rechargeRequired: shouldRecharge,
    message: shouldRecharge
      ? `免费创建次数不足，${scope}${quantityDetail}，请充值后再试。`
      : `免费创建次数不足，${scope}${quantityDetail}。`,
  };
};

export const normalizeBillSearch = source => {
  const data = source && typeof source === 'object' ? source : {};
  return {
    count: toSafeInteger(data.count),
    list: (Array.isArray(data.list) ? data.list : []).map(item => ({
      id: item?.id ?? '',
      entryNo: toStringOrEmpty(item?.entryNo),
      direction: ['credit', 'debit'].includes(item?.direction) ? item.direction : '',
      category: toStringOrEmpty(item?.category),
      amount: isDecimalString(item?.amount) ? item.amount.trim() : '',
      amountMinor: isIntegerString(item?.amountMinor) ? item.amountMinor.trim() : '',
      balanceAfter: isDecimalString(item?.balanceAfter) ? item.balanceAfter.trim() : '',
      balanceAfterMinor: isIntegerString(item?.balanceAfterMinor)
        ? item.balanceAfterMinor.trim()
        : '',
      description: toStringOrEmpty(item?.description),
      businessId: toStringOrEmpty(item?.businessId),
      createdAt: toStringOrEmpty(item?.createdAt),
    })),
  };
};
