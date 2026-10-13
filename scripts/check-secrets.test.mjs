import assert from 'node:assert/strict';
import test from 'node:test';

import { findSecretKinds } from './check-secrets.mjs';

test('识别两类 GitHub Token 且不回显内容', () => {
  const classic = `g${'hp_'}${'a'.repeat(36)}`;
  const fineGrained = `github_${'pat_'}${'b'.repeat(82)}`;

  assert.deepEqual(findSecretKinds(`token=${classic}`), ['GitHub classic PAT']);
  assert.deepEqual(findSecretKinds(`token=${fineGrained}`), ['GitHub fine-grained PAT']);
});

test('识别私钥块与真实敏感赋值', () => {
  const privateKey = [
    ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''),
    'A'.repeat(64),
    ['-----END RSA ', 'PRIVATE KEY-----'].join(''),
  ].join('\n');
  assert.deepEqual(findSecretKinds(privateKey), ['private key block']);
  assert.deepEqual(findSecretKinds('DB_PASSWORD=actual-secret-value'), [
    'non-placeholder sensitive assignment',
  ]);
});

test('允许空值、环境变量引用和明确占位符', () => {
  assert.deepEqual(findSecretKinds('SENSITIVE_DATA_KEY='), []);
  assert.deepEqual(findSecretKinds('DB_PASSWORD=${DB_PASSWORD}'), []);
  assert.deepEqual(findSecretKinds('MAIL_API_KEY=change-me'), []);
  assert.deepEqual(findSecretKinds('GITHUB_TOKEN=[REDACTED]'), []);
});
