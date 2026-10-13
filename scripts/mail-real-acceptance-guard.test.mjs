import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertAcceptanceDirectory,
  assertExpectedTestMailbox,
  planMailboxCreation,
} from './mail-real-acceptance-guard.mjs';

const expectedEmail = 'test-mail-real-20261012@example.test';

test('worker入口必须使用当前用户的0700独立临时目录', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'test-mail-real-guard-'));
  const linked = directory + '-link';
  try {
    fs.chmodSync(directory, 0o700);
    assert.equal(assertAcceptanceDirectory(directory), directory);
    assert.throws(() => assertAcceptanceDirectory(path.basename(directory)), /绝对路径/);
    fs.chmodSync(directory, 0o755);
    if (process.platform !== 'win32')
      assert.throws(() => assertAcceptanceDirectory(directory), /0700/);
    fs.chmodSync(directory, 0o700);
    fs.symlinkSync(directory, linked, 'dir');
    assert.throws(() => assertAcceptanceDirectory(linked), /符号链接/);
    const nested = path.join(directory, 'test-mail-real-nested');
    fs.mkdirSync(nested, { mode: 0o700 });
    assert.throws(() => assertAcceptanceDirectory(nested), /直接位于系统临时目录/);
  } finally {
    if (fs.existsSync(linked)) fs.unlinkSync(linked);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('detail邮件变更或非test邮箱不得建立代理/发送邮件', () => {
  assert.equal(
    assertExpectedTestMailbox({ email: expectedEmail, password: 'test-password' }, expectedEmail)
      .email,
    expectedEmail
  );
  assert.throws(
    () =>
      assertExpectedTestMailbox(
        { email: 'business@example.test', password: 'test-password' },
        expectedEmail
      ),
    /固定/
  );
  assert.throws(
    () =>
      assertExpectedTestMailbox(
        { email: 'business@example.test', password: 'test-password' },
        'business@example.test'
      ),
    /固定/
  );
  assert.throws(
    () => assertExpectedTestMailbox({ email: expectedEmail, password: 'x\r\nQUIT' }, expectedEmail),
    /凭据无效/
  );
});

test('修正入口后的失败重试需要明确flag，旧marker不能隐式被删除', () => {
  const records = [{ localPart: 'test-mail-real-20261012', attemptedAt: '2026-10-12T00:00:00Z' }];
  assert.throws(() => planMailboxCreation(records, { expectedEmail }), /retry-confirmed/);
  assert.deepEqual(planMailboxCreation(records, { expectedEmail, explicitRetry: true }), {
    mode: 'create',
    attempt: 2,
  });
  assert.deepEqual(planMailboxCreation([], { expectedEmail }), { mode: 'create', attempt: 1 });
});

test('任何成功记录都禁止创建，即使换目录/传重试flag；已有本地账号可以复用', () => {
  const records = [{ state: 'succeeded', email: expectedEmail, attempt: 2 }];
  assert.throws(
    () => planMailboxCreation(records, { expectedEmail, explicitRetry: true }),
    /成功创建/
  );
  assert.deepEqual(planMailboxCreation(records, { expectedEmail, existingAccountFound: true }), {
    mode: 'reuse',
  });
});

test('其他邮箱的创建记录不能作为当前固定test邮箱的重试许可', () => {
  assert.throws(
    () =>
      planMailboxCreation([{ email: 'other@example.test', state: 'failed' }], {
        expectedEmail,
        explicitRetry: true,
      }),
    /不一致/
  );
});
