import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBrowserAccountTooltip,
  hasUsableLinkedAccount,
  mergeAccountOptions,
  normalizeAccountSearchResponse,
} from '../src/utils/browserAccount.mjs';

test('账号选项只保留列表需要的安全字段', () => {
  const [option] = normalizeAccountSearchResponse({
    apikeyList: [
      {
        uuid: 'account-1',
        apiName: '主账号',
        email: 'one@example.com',
        mailPassword: 'must-not-leak',
        googleAuth: 'must-not-leak',
      },
    ],
  });

  assert.deepEqual(option, {
    uuid: 'account-1',
    name: '主账号',
    email: 'one@example.com',
    label: '主账号 · one@example.com',
  });
  assert.equal(JSON.stringify(option).includes('must-not-leak'), false);
});

test('同名账号通过邮箱区分，已有账号全部保留并按 uuid 去重', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    uuid: `account-${index}`,
    apiName: '同名账号',
    email: `${index}@example.com`,
  }));
  rows.push({ uuid: 'account-0', apiName: '重复数据', email: 'duplicate@example.com' });
  const options = normalizeAccountSearchResponse({ apikeyList: rows });

  assert.equal(options.length, 12);
  assert.notEqual(options[0].label, options[1].label);
});

test('编辑时已关联账号不在首页列表也能回显', () => {
  const options = normalizeAccountSearchResponse({
    apikeyList: [{ uuid: 'account-1', apiName: '账号一', email: 'one@example.com' }],
  });
  const merged = mergeAccountOptions(options, {
    email_uuid: 'account-2',
    account_name: '账号二',
    account_email: 'two@example.com',
  });

  assert.equal(merged[0].uuid, 'account-2');
  assert.equal(merged[0].email, 'two@example.com');
});

test('浏览器行只读取统一关联字段', () => {
  const linked = {
    email_uuid: 'account-1',
    account_name: '主账号',
    account_email: 'linked@example.com',
    email: 'wrong@example.com',
  };

  assert.equal(getBrowserAccountTooltip(linked), 'linked@example.com');
  assert.equal(hasUsableLinkedAccount(linked), true);
  assert.equal(getBrowserAccountTooltip({ email: 'wrong@example.com' }), '未关联账号');
  assert.equal(hasUsableLinkedAccount({ email_uuid: 'account-1' }), false);
  assert.equal(getBrowserAccountTooltip({ email_uuid: 'account-1' }), '关联账号不可用');
});
