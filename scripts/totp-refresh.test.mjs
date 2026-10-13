import assert from 'node:assert/strict';
import test from 'node:test';

import {
  didTOTPWindowChange,
  getTOTPRemainingSeconds,
  getTOTPWindow,
} from '../src/utils/totpRefresh.mjs';

test('TOTP 窗口按 30 秒边界切换', () => {
  assert.equal(getTOTPWindow(0), 0);
  assert.equal(getTOTPWindow(29_999), 0);
  assert.equal(getTOTPWindow(30_000), 1);
  assert.equal(didTOTPWindowChange(0, 30_000), true);
  assert.equal(didTOTPWindowChange(1, 30_001), false);
});

test('TOTP 剩余秒数始终在 1 到 30 之间', () => {
  assert.equal(getTOTPRemainingSeconds(0), 30);
  assert.equal(getTOTPRemainingSeconds(1), 30);
  assert.equal(getTOTPRemainingSeconds(29_000), 1);
  assert.equal(getTOTPRemainingSeconds(30_000), 30);
});

test('TOTP 刷新工具拒绝非法时间戳', () => {
  assert.throws(() => getTOTPWindow(-1), RangeError);
  assert.throws(() => getTOTPRemainingSeconds(Number.NaN), RangeError);
});
