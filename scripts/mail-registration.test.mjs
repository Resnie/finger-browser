import test from 'node:test';
import assert from 'node:assert/strict';

import { getMailboxRegistrationState } from '../src/utils/mailRegistration.mjs';

test('注册邮箱使用服务端返回的动态域名', () => {
  const state = getMailboxRegistrationState({
    mailDomain: ' mail.example.com ',
    isMailboxRegistrationConfigured: true,
  });

  assert.deepEqual(state, {
    available: true,
    domain: 'mail.example.com',
    suffix: '@mail.example.com',
    reason: '',
  });
});

test('邮箱域名未配置时禁用注册', () => {
  const state = getMailboxRegistrationState({
    mailDomain: '',
    isMailboxRegistrationConfigured: true,
  });

  assert.equal(state.available, false);
  assert.match(state.reason, /域名未配置/);
});

test('邮箱创建服务未配置完整时禁用注册', () => {
  const state = getMailboxRegistrationState({
    mailDomain: 'example.com',
    isMailboxRegistrationConfigured: false,
  });

  assert.equal(state.available, false);
  assert.equal(state.suffix, '@example.com');
  assert.match(state.reason, /未配置完整/);
});
