import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeBase32, generateTotpToken } from '../electron/utils/totp.mjs';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('RFC 6238 SHA-1 公开向量全部一致', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [seconds, expected] of vectors) {
    assert.equal(generateTotpToken(RFC_SECRET, { timestamp: seconds * 1000, digits: 8 }), expected);
  }
});

test('默认生成 6 位 Google Auth 验证码', () => {
  assert.equal(generateTotpToken(RFC_SECRET, { timestamp: 59000 }), '287082');
});

test('Base32 密钥兼容空格、连字符与填充符', () => {
  const formatted = 'GEZD GNBV-GY3T QOJQ GEZD GNBV GY3T QOJQ====';
  assert.deepEqual(decodeBase32(formatted), decodeBase32(RFC_SECRET));
});

test('拒绝非 Base32 密钥和异常生成参数', () => {
  assert.throws(() => decodeBase32('not-valid-0189'), /Base32/);
  assert.throws(() => generateTotpToken(RFC_SECRET, { period: 0 }), /周期/);
  assert.throws(() => generateTotpToken(RFC_SECRET, { digits: 5 }), /位数/);
});
