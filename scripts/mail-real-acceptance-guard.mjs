import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function validateAcceptanceDirectoryLocation(directory, temporaryRoot = os.tmpdir()) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw new Error('验收目录必须是绝对路径');
  const resolved = path.resolve(directory);
  if (!/^test-mail-real-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(path.basename(resolved)))
    throw new Error('验收目录必须使用 test-mail-real- 前缀');
  if (fs.realpathSync(path.dirname(resolved)) !== fs.realpathSync(temporaryRoot))
    throw new Error('验收目录必须直接位于系统临时目录');
  return resolved;
}

export function assertAcceptanceDirectory(directory, temporaryRoot = os.tmpdir()) {
  const resolved = validateAcceptanceDirectoryLocation(directory, temporaryRoot);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('验收目录不得是符号链接');
  if (path.dirname(fs.realpathSync(resolved)) !== fs.realpathSync(temporaryRoot))
    throw new Error('验收目录必须直接位于系统临时目录');
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o777) !== 0o700) throw new Error('验收目录权限必须是 0700');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      throw new Error('验收目录必须属于当前用户');
  }
  return resolved;
}

export function assertExpectedTestMailbox(credentials, expectedEmail) {
  const localPart = expectedEmail?.split('@')[0];
  if (
    !/^test-mail-real-[A-Za-z0-9._+-]+$/.test(localPart || '') ||
    credentials?.email !== expectedEmail
  ) {
    throw new Error('验收凭据必须属于固定的 test- 邮箱');
  }
  if (
    typeof credentials.password !== 'string' ||
    !credentials.password ||
    /[\r\n\0]/.test(credentials.password)
  ) {
    throw new Error('测试邮箱凭据无效');
  }
  return credentials;
}

export function planMailboxCreation(
  records,
  { existingAccountFound, explicitRetry, expectedEmail }
) {
  for (const record of records) {
    if (record.email && record.email !== expectedEmail) throw new Error('创建记录与固定邮箱不一致');
  }
  if (existingAccountFound) return { mode: 'reuse' };
  if (records.some(record => record.state === 'succeeded'))
    throw new Error('此 test- 邮箱已经成功创建，禁止重复注册；请恢复原凭据');
  if (records.length && !explicitRetry)
    throw new Error('已有创建尝试记录；核对未创建后才可显式 --retry-confirmed-not-created');
  const attempt =
    records.reduce((maximum, record) => Math.max(maximum, Number(record.attempt) || 1), 0) + 1;
  return { mode: 'create', attempt };
}
