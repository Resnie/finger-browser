import fs from 'node:fs';
import Store from 'electron-store';
import { safeStorage } from 'electron';
import { logger } from '../../utils/logger.js';

const STORE_KEY = 'credentials';
const ENCRYPTION_PREFIX = 'v1:';

/**
 * 使用操作系统安全存储保护登录账号和原始密码。
 * electron-store 中只保存整份 JSON 加密后的密文。
 */
export class LoginCredentialManager {
  constructor() {
    // 从首次原子写入开始就限制权限，避免先按默认权限落盘再 chmod 的短暂窗口。
    this.store = new Store({ name: 'login-credentials', configFileMode: 0o600 });
    this.logger = logger.createContextLogger('LoginCredential');
    this._restrictStorePermissions();
  }

  _assertEncryptionAvailable() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法安全保存账号密码');
    }
  }

  _validateCredentials(username, password, scheme) {
    const normalizedUsername = typeof username === 'string' ? username.trim() : '';
    const isUsernameValid = normalizedUsername.length >= 3 && normalizedUsername.length <= 100;
    const isPasswordValid =
      typeof password === 'string' &&
      ((scheme === 'plain' && password.length >= 6 && password.length <= 50) ||
        (scheme === 'md5' && /^[a-f0-9]{32}$/i.test(password)));

    if (!isUsernameValid || !isPasswordValid) {
      throw new Error('登录凭据格式无效');
    }
  }

  _restrictStorePermissions() {
    if (process.platform === 'win32' || !fs.existsSync(this.store.path)) return;

    try {
      fs.chmodSync(this.store.path, 0o600);
    } catch (error) {
      this.logger.warn(`收紧登录凭据文件权限失败: ${error.message}`);
    }
  }

  save(username, password, scheme = 'plain') {
    this._validateCredentials(username, password, scheme);
    this._assertEncryptionAvailable();

    const normalizedUsername = username.trim();
    const normalizedPassword = scheme === 'md5' ? password.toLowerCase() : password;
    const plaintext = JSON.stringify({
      version: 1,
      scheme,
      username: normalizedUsername,
      password: normalizedPassword,
    });
    const ciphertext = safeStorage.encryptString(plaintext).toString('base64');

    this.store.set(STORE_KEY, `${ENCRYPTION_PREFIX}${ciphertext}`);
    this._restrictStorePermissions();
    this.logger.info('登录凭据已使用系统安全存储保存');
  }

  load() {
    const storedValue = this.store.get(STORE_KEY);
    if (storedValue === undefined) return null;
    if (typeof storedValue !== 'string' || !storedValue.startsWith(ENCRYPTION_PREFIX)) {
      throw new Error('已保存的登录凭据格式无效');
    }

    this._assertEncryptionAvailable();

    try {
      const ciphertext = Buffer.from(storedValue.slice(ENCRYPTION_PREFIX.length), 'base64');
      const credentials = JSON.parse(safeStorage.decryptString(ciphertext));
      if (credentials?.version !== 1) {
        throw new Error('不支持的登录凭据版本');
      }
      const scheme = credentials.scheme;
      this._validateCredentials(credentials.username, credentials.password, scheme);
      return {
        scheme,
        username: credentials.username.trim(),
        password: scheme === 'md5' ? credentials.password.toLowerCase() : credentials.password,
      };
    } catch {
      this.logger.error('解密登录凭据失败');
      throw new Error('无法读取已保存的账号密码');
    }
  }

  clear() {
    this.store.delete(STORE_KEY);
    this._restrictStorePermissions();
    this.logger.info('已清除保存的登录凭据');
  }
}

export const loginCredentialManager = new LoginCredentialManager();
