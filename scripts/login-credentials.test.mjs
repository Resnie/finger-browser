import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Exercise the production class; Electron OS encryption/store adapters are isolated.
const source = fs.readFileSync(
  new URL('../electron/main/models/LoginCredentialManager.js', import.meta.url),
  'utf8'
);
const classSource = source.slice(
  source.indexOf('export class LoginCredentialManager'),
  source.indexOf('\nexport const loginCredentialManager')
);
const makeManager = ({ available = true } = {}) => {
  const values = new Map();
  class Store {
    constructor() {
      this.path = '/tmp/test-login-credentials.json';
    }
    set(key, value) {
      values.set(key, value);
    }
    get(key) {
      return values.get(key);
    }
    delete(key) {
      values.delete(key);
    }
  }
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`test-encrypted:${value}`),
    decryptString: value => {
      const text = value.toString();
      if (!text.startsWith('test-encrypted:')) throw new Error('test-unreadable');
      return text.slice('test-encrypted:'.length);
    },
  };
  const logger = { createContextLogger: () => ({ info() {}, warn() {}, error() {} }) };
  const Manager = new Function(
    'Store',
    'safeStorage',
    'logger',
    'fs',
    'process',
    'Buffer',
    'STORE_KEY',
    'ENCRYPTION_PREFIX',
    `${classSource.replace('export class ', 'class ')}; return LoginCredentialManager;`
  )(Store, safeStorage, logger, { existsSync: () => false }, process, Buffer, 'credentials', 'v1:');
  return { manager: new Manager(), values };
};

test('长于20字符的真实验收用户名能够保存并回填', () => {
  const { manager, values } = makeManager();
  const username = 'test-acceptance-20261012';
  manager.save(` ${username} `, 'test-login-password');
  assert.deepEqual(manager.load(), {
    scheme: 'plain',
    username,
    password: 'test-login-password',
  });
  assert.match(values.get('credentials'), /^v1:/);
  manager.clear();
  assert.equal(manager.load(), null);
});

test('用户名边界与页面和后端一致：3至100字符，101字符拒绝', () => {
  const { manager } = makeManager();
  for (const length of [3, 20, 21, 100]) {
    manager.save('t'.repeat(length), 'test-login-password');
    assert.equal(manager.load().username.length, length);
  }
  for (const length of [0, 2, 101])
    assert.throws(() => manager.save('t'.repeat(length), 'test-login-password'), /格式无效/);
});

test('旧MD5凭据仍能读取且规范为小写，不改变兼容协议', () => {
  const { manager } = makeManager();
  manager.save('test-legacy-login', 'A'.repeat(32), 'md5');
  assert.deepEqual(manager.load(), {
    scheme: 'md5',
    username: 'test-legacy-login',
    password: 'a'.repeat(32),
  });
});

test('扩大用户名范围不放宽密码边界或格式', () => {
  const { manager } = makeManager();
  for (const password of ['short', 'a'.repeat(51)])
    assert.throws(() => manager.save('test-login', password), /格式无效/);
  assert.throws(() => manager.save('test-login', 'not-a-digest', 'md5'), /格式无效/);
  assert.throws(() => manager.save('test-login', 'test-password', 'unknown'), /格式无效/);
});

test('系统安全存储不可用时不写入，密文损坏时不返回密码', () => {
  const unavailable = makeManager({ available: false });
  assert.throws(() => unavailable.manager.save('test-login', 'test-password'), /安全存储不可用/);
  assert.equal(unavailable.values.size, 0);
  const { manager, values } = makeManager();
  values.set('credentials', 'v1:' + Buffer.from('test-invalid').toString('base64'));
  assert.throws(() => manager.load(), /无法读取已保存/);
});
