import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatMinorAmount,
  getCreationBillingFailure,
  getResourceBillingState,
  normalizeBillingSummary,
  normalizeBillSearch,
} from '../src/utils/billing.mjs';
import {
  getAccountBatchSizeError,
  MAX_ACCOUNT_BATCH_ITEMS,
  parseFastAddAccountRows,
} from '../src/utils/accountBatch.mjs';

test('快速添加保留重复账号并交给服务端裁决净新增数', () => {
  const content = [
    'same@example.com----password-1',
    'same@example.com----password-2',
  ].join('\n');
  const result = parseFastAddAccountRows(content);

  assert.equal(result.invalidRows.length, 0);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].email, result.rows[1].email);
  assert.equal(getAccountBatchSizeError(result.rows), '');
});

test('快速添加仅做基础格式校验', () => {
  const result = parseFastAddAccountRows('invalid-email----password\nmissing@example.com');

  assert.equal(result.rows.length, 0);
  assert.equal(result.invalidRows.length, 2);
});

test('批量账号请求保留 500 条上限', () => {
  assert.equal(getAccountBatchSizeError(Array(MAX_ACCOUNT_BATCH_ITEMS).fill({})), '');
  assert.match(
    getAccountBatchSizeError(Array(MAX_ACCOUNT_BATCH_ITEMS + 1).fill({})),
    /500/
  );
});

test('批量余额不足时明确提示整批未执行并充值', () => {
  const result = getCreationBillingFailure(
    {
      apiData: {
        reason: 'INSUFFICIENT_BALANCE',
        batchRejected: true,
        requested: 3,
        freeRemaining: 1,
        suggestedAction: 'RECHARGE',
        rechargeRequired: true,
      },
    },
    { batch: true }
  );

  assert.equal(result.type, 'error');
  assert.equal(result.rechargeRequired, true);
  assert.match(result.message, /本批次未执行/);
  assert.match(result.message, /请充值/);
});

test('数据库价格占位时提示等待配置而不是误导充值', () => {
  const result = getCreationBillingFailure({
    apiData: {
      reason: 'PRICE_NOT_CONFIGURED',
      batchRejected: true,
      requested: 2,
      freeRemaining: 0,
      suggestedAction: 'WAIT_FOR_PRICING',
      rechargeRequired: false,
    },
  });

  assert.equal(result.type, 'warning');
  assert.equal(result.rechargeRequired, false);
  assert.match(result.message, /单价尚未配置/);
  assert.doesNotMatch(result.message, /请充值/);
});

test('非计费错误不被错误提示转换', () => {
  assert.equal(getCreationBillingFailure({ apiData: { reason: 'VALIDATION_FAILED' } }), null);
});

const summary = overrides => ({
  currency: 'USDT',
  scale: 6,
  wallet: { balance: '12.500000', balanceMinor: '12500000' },
  pricing: [
    {
      resource: 'browser',
      mode: 'per_create',
      status: 'pending',
      unitPrice: null,
      unitPriceMinor: null,
    },
    {
      resource: 'account',
      mode: 'per_create',
      status: 'active',
      unitPrice: '1.250000',
      unitPriceMinor: '1250000',
    },
  ],
  usage: [
    {
      resource: 'browser',
      lifetimeCreated: 8,
      freeLimit: 10,
      freeRemaining: 2,
      billingRequired: false,
    },
    {
      resource: 'account',
      lifetimeCreated: 10,
      freeLimit: 10,
      freeRemaining: 0,
      billingRequired: true,
    },
  ],
  supportedModes: ['per_create', 'monthly'],
  rechargeEnabled: false,
  ...overrides,
});

test('金额从 minor 单位精确格式化，不经过浮点计算', () => {
  assert.equal(formatMinorAmount('1', 6), '0.000001');
  assert.equal(formatMinorAmount('12345678901234567890', 6), '12345678901234.567890');
  assert.equal(formatMinorAmount('1.2', 6), '');
});

test('免费额度可覆盖本次数量时允许创建', () => {
  const state = getResourceBillingState(summary(), 'browser', 2);
  assert.equal(state.allowed, true);
  assert.equal(state.kind, 'free');
  assert.equal(state.billableCount, 0);
});

test('价格未启用时禁止超额创建，不猜测金额', () => {
  const state = getResourceBillingState(summary(), 'browser', 3);
  assert.equal(state.allowed, false);
  assert.equal(state.kind, 'pending');
  assert.equal(state.billableCount, 1);
  assert.equal(state.totalPrice, '');
});

test('按次计价使用 BigInt 精确计算多个资源总价', () => {
  const state = getResourceBillingState(summary(), 'account', 3);
  assert.equal(state.allowed, true);
  assert.equal(state.kind, 'paid');
  assert.equal(state.totalPrice, '3.750000');
  assert.equal(state.totalPriceMinor, '3750000');
});

test('余额不足时禁止创建', () => {
  const lowBalance = summary({
    wallet: { balance: '1.000000', balanceMinor: '1000000' },
  });
  const state = getResourceBillingState(lowBalance, 'account', 1);
  assert.equal(state.allowed, false);
  assert.equal(state.kind, 'insufficient');
});

test('同一资源存在月套餐时仍只使用按次价格', () => {
  const mixedPricing = summary({
    pricing: [
      {
        resource: 'account',
        mode: 'monthly',
        status: 'active',
        unitPrice: '99.000000',
        unitPriceMinor: '99000000',
      },
      {
        resource: 'account',
        mode: 'per_create',
        status: 'active',
        unitPrice: '1.250000',
        unitPriceMinor: '1250000',
      },
    ],
  });
  const state = getResourceBillingState(mixedPricing, 'account', 1);
  assert.equal(state.totalPrice, '1.250000');
});

test('未知计费模式不会被当成按次价格', () => {
  const unknownMode = summary({
    pricing: [
      {
        resource: 'account',
        mode: 'unknown',
        status: 'active',
        unitPrice: '1.000000',
        unitPriceMinor: '1000000',
      },
    ],
  });
  const state = getResourceBillingState(unknownMode, 'account', 1);
  assert.equal(state.allowed, false);
  assert.equal(state.kind, 'pending');
  assert.equal(state.totalPrice, '');
});

test('服务端返回非 USDT 币种时禁止创建', () => {
  const wrongCurrency = summary({ currency: 'CNY' });
  const state = getResourceBillingState(wrongCurrency, 'account', 1);
  assert.equal(state.allowed, false);
  assert.equal(state.kind, 'unavailable');
});

test('激活状态的零单价仍视为配置异常', () => {
  const zeroPrice = summary({
    pricing: [
      {
        resource: 'account',
        mode: 'per_create',
        status: 'active',
        unitPrice: '0.000000',
        unitPriceMinor: '0',
      },
    ],
  });
  const state = getResourceBillingState(zeroPrice, 'account', 1);
  assert.equal(state.allowed, false);
  assert.equal(state.kind, 'pending');
});

test('账单列表保留服务端金额字符串', () => {
  const result = normalizeBillSearch({
    count: 1,
    list: [
      {
        id: 1,
        entryNo: 'test-bill-1',
        direction: 'debit',
        category: 'browser_create',
        amount: '0.123456',
        amountMinor: '123456',
        balanceAfter: '9.876544',
        balanceAfterMinor: '9876544',
        description: '测试账单',
        createdAt: '2026-08-16T10:00:00+08:00',
      },
    ],
  });
  assert.equal(result.count, 1);
  assert.equal(result.list[0].amount, '0.123456');
  assert.equal(result.list[0].balanceAfter, '9.876544');
});

test('摘要异常金额不显示猜测值', () => {
  const normalized = normalizeBillingSummary({
    wallet: { balance: 12.5, balanceMinor: 'invalid' },
  });
  assert.equal(normalized.wallet.balance, '');
  assert.equal(normalized.wallet.balanceMinor, '');
});
