import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findVerificationCode,
  normalizeVerificationText,
} from '../electron/utils/verificationCode.mjs';

test('提取币安绑定谷歌验证码邮件中的连续六位码', () => {
  const subject = '【币安】绑定谷歌验证码 - 2026-06-02 14:00:30(UTC)';
  const body = '<div>将谷歌双重身份验证(2FA)绑定到您的账户</div><p>您的验证码：<b>021019</b></p>';

  assert.equal(findVerificationCode(subject, body), '021019');
});

test('支持被 HTML 标签、空格和实体拆开的六位码', () => {
  const body = `
    <style>.code { color: red }</style>
    <p>您的验&#35777;码：</p>
    <span>0</span><span>&#50;</span><span>1</span>
    <span>&nbsp;0</span><span>1</span><span>9</span>
  `;

  assert.equal(findVerificationCode('绑定谷歌验证码', body), '021019');
});

test('优先提取验证码短语后的数字而不是正文中的订单号', () => {
  const body = '<p>订单号 123456</p><p>Verification code: <strong>654321</strong></p>';
  assert.equal(findVerificationCode('', body), '654321');
});

test('不会把七位或更长数字截成六位验证码', () => {
  assert.equal(findVerificationCode('安全提醒', '<p>参考编号 1234567</p>'), null);
  assert.equal(findVerificationCode('验证码邮件', '<p>1 2 3 4 5 6 7</p>'), null);
});

test('普通账单中的六位编号不会覆盖近期真正验证码', () => {
  assert.equal(findVerificationCode('账单已生成', '<p>订单号 123456</p>'), null);
});

test('验证邮件正文仅有数字时保留兼容提取', () => {
  assert.equal(findVerificationCode('Your verification code', '<b>654321</b>'), '654321');
});

test('正文规范化会移除脚本和零宽字符', () => {
  const normalized = normalizeVerificationText(
    '',
    '<script>验证码 999999</script><p>验证码 1\u200b2\u200b3\u200b4\u200b5\u200b6</p>'
  );
  assert.equal(normalized.includes('999999'), false);
  assert.equal(findVerificationCode('', normalized), '123456');
});
