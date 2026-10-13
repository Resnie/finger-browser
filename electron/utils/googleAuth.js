import NodeRSA from 'node-rsa';
import { safeStorage } from 'electron';
import store from './store.js';
import { logger } from './logger.js';
import { getRsaPublicKey, getRsaPrivateKey } from './config.js';
import { generateTotpToken } from './totp.mjs';
import { normalizeGoogleAuthSecret } from './googleAuthProtocol.mjs';

const authLogger = logger.createContextLogger('GoogleAuth');
const AUTH_STORE_KEY = 'googleAuth';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeAuthIdentity = identity => {
  const value =
    typeof identity === 'string'
      ? { email: identity }
      : identity && typeof identity === 'object'
        ? identity
        : {};
  const uuid =
    typeof value.uuid === 'string' && UUID_PATTERN.test(value.uuid.trim())
      ? value.uuid.trim().toLowerCase()
      : '';
  const email =
    typeof value.email === 'string' && value.email.trim() && value.email.length <= 320
      ? value.email.trim().toLowerCase()
      : '';
  if (!uuid && !email) throw new Error('账号标识格式无效');
  return {
    uuid,
    email,
    primaryKey: uuid ? `uuid:${uuid}` : email,
    candidateKeys: [...new Set([uuid ? `uuid:${uuid}` : '', email].filter(Boolean))],
  };
};

const validateAuthInput = (identity, value) => {
  const normalizedIdentity = normalizeAuthIdentity(identity);
  if (!normalizedIdentity.primaryKey) {
    throw new Error('账号标识格式无效');
  }
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw new Error('Google Auth 密钥格式无效');
  }
  return normalizedIdentity;
};

// 兼容旧版 electron-store 的点路径结构，并迁移为以完整邮箱为键的平面对象。
const flattenAuthEntries = (value, prefix = '', result = {}) => {
  if (typeof value === 'string') {
    if (prefix) result[prefix] = value;
    return result;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    flattenAuthEntries(child, prefix ? `${prefix}.${key}` : key, result);
  }
  return result;
};

const readAllAuthEntries = () => flattenAuthEntries(store.get(AUTH_STORE_KEY, {}));

const writeAuthEntry = (identity, value) => {
  const normalizedIdentity = normalizeAuthIdentity(identity);
  const entries = readAllAuthEntries();
  // 清理旧版未做大小写规范化的邮箱键，避免同一账号残留多份密钥。
  if (normalizedIdentity.email) {
    for (const key of Object.keys(entries)) {
      if (
        key !== normalizedIdentity.primaryKey &&
        !key.startsWith('uuid:') &&
        key.trim().toLowerCase() === normalizedIdentity.email
      ) {
        delete entries[key];
      }
    }
  }
  entries[normalizedIdentity.primaryKey] = value;
  store.set(AUTH_STORE_KEY, entries);
};

const encryptLocalSecret = secret => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法安全保存 Google Auth 密钥');
  }
  return `v2:${safeStorage.encryptString(secret).toString('base64')}`;
};

const decryptStoredSecret = storedValue => {
  if (storedValue.startsWith('v2:')) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储当前不可用');
    }
    return safeStorage.decryptString(Buffer.from(storedValue.slice(3), 'base64'));
  }
  return rsaDecrypt(storedValue);
};

// 仅供主进程一次性迁移使用，不能通过 IPC 返回明文。
export const decryptLocalAuthSecretForMigration = storedValue =>
  normalizeGoogleAuthSecret(decryptStoredSecret(storedValue));

export const deleteLocalAuthSecretIfUnchanged = (identity, expectedValue) => {
  const normalizedIdentity = normalizeAuthIdentity(identity);
  const entries = readAllAuthEntries();
  let deleted = false;
  for (const [key, value] of Object.entries(entries)) {
    const matchesIdentity =
      normalizedIdentity.candidateKeys.includes(key) ||
      (normalizedIdentity.email &&
        !key.startsWith('uuid:') &&
        key.trim().toLowerCase() === normalizedIdentity.email);
    // 旧邮箱别名可能已被另一个旧客户端更新，只清理本次成功验证的副本。
    if (matchesIdentity && value === expectedValue) {
      delete entries[key];
      deleted = true;
    }
  }
  if (deleted) store.set(AUTH_STORE_KEY, entries);
  return deleted;
};

/**
 * RSA 加密
 * @param {string} plaintext - 明文
 * @returns {string} 密文
 */
export const rsaEncrypt = plaintext => {
  try {
    const publicKey = getRsaPublicKey();
    if (!publicKey) throw new Error('RSA 公钥未配置');
    const key = new NodeRSA(publicKey);
    key.setOptions({ encryptionScheme: 'pkcs1' });
    return key.encrypt(plaintext, 'base64');
  } catch (error) {
    authLogger.error(`RSA 加密失败: ${error.message}`);
    throw new Error('RSA 加密失败，请检查 RSA 密钥配置是否正确');
  }
};

/**
 * RSA 解密
 * @param {string} ciphertext - 密文
 * @returns {string} 明文
 */
export const rsaDecrypt = ciphertext => {
  try {
    const privateKey = getRsaPrivateKey();
    if (!privateKey) throw new Error('RSA 私钥未配置');
    const key = new NodeRSA(privateKey);
    key.setOptions({ encryptionScheme: 'pkcs1' });
    return key.decrypt(ciphertext, 'utf8');
  } catch (error) {
    authLogger.error(`RSA 解密失败: ${error.message}`);
    throw new Error('RSA 解密失败，请检查 RSA 密钥配置是否正确');
  }
};

/**
 * 保存 Google Auth 密钥到 electron-store
 * @param {string|{uuid?: string, email?: string}} email - 兼容旧邮箱键的账号标识
 * @param {string} encryptedCode - RSA 加密后的密钥
 */
export const saveAuthSecret = (email, encryptedCode) => {
  try {
    validateAuthInput(email, encryptedCode);
    const newValue = encryptedCode.trim();
    const existingValue = readAuthSecret(email);
    if (existingValue?.startsWith('v2:') && !newValue.startsWith('v2:')) {
      authLogger.info('已保留操作系统安全存储中的 Google Auth 密钥');
      return false;
    }
    writeAuthEntry(email, newValue);
    authLogger.info('已保存 Google Auth 密钥');
    return true;
  } catch (error) {
    authLogger.error(`保存 Google Auth 密钥失败: ${error.message}`);
    throw error;
  }
};

/**
 * 使用操作系统安全存储保存明文 TOTP 密钥。
 */
export const saveLocalAuthSecret = (email, secret) => {
  validateAuthInput(email, secret);
  const normalizedSecret = normalizeGoogleAuthSecret(secret);
  writeAuthEntry(email, encryptLocalSecret(normalizedSecret));
  authLogger.info('已使用系统安全存储保存 Google Auth 密钥');
};

/**
 * 删除邮箱对应的本地 Google Auth 密钥。
 * @returns {boolean} 是否存在并删除了密钥
 */
export const deleteAuthSecret = email => {
  let identity;
  try {
    identity = normalizeAuthIdentity(email);
  } catch {
    return false;
  }
  const entries = readAllAuthEntries();
  let deleted = false;
  for (const key of Object.keys(entries)) {
    const isCandidate = identity.candidateKeys.includes(key);
    const isLegacyEmailCase =
      identity.email && !key.startsWith('uuid:') && key.trim().toLowerCase() === identity.email;
    if (isCandidate || isLegacyEmailCase) {
      delete entries[key];
      deleted = true;
    }
  }
  if (!deleted) return false;
  store.set(AUTH_STORE_KEY, entries);
  authLogger.info('已删除 Google Auth 密钥');
  return true;
};

/**
 * 读取 Google Auth 密钥
 * @param {string|{uuid?: string, email?: string}} email - 账号标识
 * @returns {string|null} 加密后的密钥
 */
export const readAuthSecret = email => {
  try {
    const identity = normalizeAuthIdentity(email);
    const entries = readAllAuthEntries();
    for (const key of identity.candidateKeys) {
      if (typeof entries[key] !== 'string' || !entries[key]) continue;
      const storedSecret = entries[key];
      if (key !== identity.primaryKey) {
        entries[identity.primaryKey] = storedSecret;
        delete entries[key];
        store.set(AUTH_STORE_KEY, entries);
        authLogger.info('已将旧邮箱键迁移为账号 UUID 键');
      }
      return storedSecret;
    }

    // 兼容旧版未做小写规范化的邮箱键，包括新调用方传入 {uuid,email} 的情况。
    if (identity.email) {
      const legacyKey = Object.keys(entries).find(
        key =>
          !key.startsWith('uuid:') && key.trim().toLowerCase() === identity.email && entries[key]
      );
      if (legacyKey && typeof entries[legacyKey] === 'string') {
        const storedSecret = entries[legacyKey];
        entries[identity.primaryKey] = storedSecret;
        if (legacyKey !== identity.primaryKey) delete entries[legacyKey];
        store.set(AUTH_STORE_KEY, entries);
        authLogger.info('已迁移旧版大小写邮箱键');
        return storedSecret;
      }
    }
    return null;
  } catch (error) {
    authLogger.error(`读取 Google Auth 密钥失败: ${error.message}`);
    return null;
  }
};

/**
 * 生成 TOTP
 * @param {string} secret - Base32 编码的密钥
 * @returns {string|null} 6 位验证码
 */
export const generateTotp = secret => {
  try {
    return generateTotpToken(secret);
  } catch (error) {
    authLogger.error(`生成 TOTP 失败: ${error.message}`);
    return null;
  }
};

/**
 * 获取 Google Auth 验证码（完整流程：读取 → 解密 → 生成）
 * @param {string|{uuid?: string, email?: string}} email - 账号标识
 * @returns {{ success: boolean, code?: string, message?: string }}
 */
export const getGoogleAuthCode = email => {
  try {
    const storedSecret = readAuthSecret(email);
    if (!storedSecret) {
      return { success: false, message: '本机未保存 Google 密钥，请编辑账号重新录入' };
    }

    let secret;
    try {
      secret = decryptStoredSecret(storedSecret);
    } catch (error) {
      if (!storedSecret.startsWith('v2:')) {
        return {
          success: false,
          message: '旧密钥无法解密，请编辑账号重新录入 Google 密钥',
        };
      }
      throw error;
    }
    if (!secret) {
      return { success: false, message: '解密 Google Auth 密钥失败' };
    }

    // 成功读取旧版 RSA 密文后自动迁移到操作系统安全存储。
    if (!storedSecret.startsWith('v2:') && safeStorage.isEncryptionAvailable()) {
      saveLocalAuthSecret(email, secret);
    }

    const code = generateTotp(secret);
    if (!code) {
      return { success: false, message: '生成验证码失败' };
    }

    authLogger.info('已生成 Google Auth 验证码');
    return { success: true, code };
  } catch (error) {
    authLogger.error(`获取 Google Auth 验证码失败: ${error.message}`);
    return { success: false, message: error.message };
  }
};

/**
 * 列出所有保存了 Google Auth 密钥的邮箱
 * @returns {string[]} 邮箱列表
 */
export const listAllAuthEmails = () => {
  try {
    return Object.keys(readAllAuthEntries())
      .filter(key => !key.startsWith('uuid:'))
      .sort();
  } catch (error) {
    authLogger.error(`列出 Google Auth 邮箱失败: ${error.message}`);
    return [];
  }
};

/**
 * 直接从明文密钥生成 TOTP（不经过 store 读取）
 * @param {string} secret - Base32 编码的密钥
 * @returns {{ success: boolean, code?: string, message?: string }}
 */
export const generateTotpFromRawSecret = secret => {
  try {
    const code = generateTotp(secret);
    if (!code) {
      return { success: false, message: '生成验证码失败' };
    }

    return { success: true, code };
  } catch (error) {
    authLogger.error(`从明文密钥生成 TOTP 失败: ${error.message}`);
    return { success: false, message: error.message };
  }
};
