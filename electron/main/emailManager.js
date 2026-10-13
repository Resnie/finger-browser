import { logger } from '../utils/logger.js';
import { ipcRegistry } from './ipc/registry.js';
import axios from 'axios';
import { getApiBaseUrl } from '../utils/config.js';
import { createGoogleAuthMigration } from '../utils/googleAuthMigration.mjs';
import {
  rsaEncrypt,
  saveAuthSecret,
  saveLocalAuthSecret,
  deleteAuthSecret,
  getGoogleAuthCode,
  listAllAuthEmails,
  generateTotpFromRawSecret,
  readAuthSecret,
  decryptLocalAuthSecretForMigration,
  deleteLocalAuthSecretIfUnchanged,
} from '../utils/googleAuth.js';
import {
  fetchEmailsViaImap,
  fetchEmailsViaPop3,
  listLocalEmailCache,
  readLocalEmailBody,
  scanEmailAuthStatus,
  extractVerificationCode,
  parseExcelImportFile,
  exportImportTemplate,
  prepareEmailForImport,
} from '../utils/email.js';

const emailLogger = logger.createContextLogger('EmailManager');

const authMigration = createGoogleAuthMigration({
  post: async (endpoint, data, session) => {
    try {
      const response = await axios.post(`${getApiBaseUrl()}${endpoint}`, data, {
        timeout: 10_000,
        headers: { 'Content-Type': 'application/json', Authorization: session.token },
      });
      if (response.data?.code !== 0) {
        throw new Error(response.data?.message || '服务端拒绝迁移谷歌密钥');
      }
      return response.data.data;
    } catch (error) {
      if (error.response?.status === 404 || error.response?.status === 405) {
        throw new Error('当前后端尚不支持安全迁移，请升级后端后再试');
      }
      // 只返回业务消息，不向 renderer 或日志传递带请求密钥的 Axios 对象。
      throw new Error(error.response?.data?.message || error.message || '谷歌密钥迁移请求失败');
    }
  },
  readLocalEntry: readAuthSecret,
  decryptLocalEntry: decryptLocalAuthSecretForMigration,
  deleteLocalEntryIfUnchanged: deleteLocalAuthSecretIfUnchanged,
});

const getMigrationSession = async event => ({
  senderId: event.sender.id,
  token: await event.sender.executeJavaScript('localStorage.getItem("token") || ""', true),
});

/**
 * 注册邮箱管理和谷歌验证 IPC 处理器
 */
export const registerEmailHandlers = () => {
  emailLogger.info('注册邮箱管理 IPC 处理器');

  ipcRegistry.registerHandlers([
    // ==================== Google Auth 处理器 ====================
    {
      channel: 'google-auth:prepare-migration',
      handler: async (event, input) =>
        authMigration.prepare(input, await getMigrationSession(event)),
      description: '检查谷歌密钥迁移状态',
    },
    {
      channel: 'google-auth:commit-migration',
      handler: async (event, input) =>
        authMigration.commit(input, await getMigrationSession(event)),
      description: '确认并验证一次性谷歌密钥迁移',
    },
    {
      channel: 'google-auth:get-code',
      handler: async (event, email) => {
        return getGoogleAuthCode(email);
      },
      description: '获取谷歌验证码',
    },
    {
      channel: 'google-auth:generate-totp',
      handler: async (event, secret) => {
        return generateTotpFromRawSecret(secret);
      },
      description: '从明文密钥生成 TOTP',
    },
    {
      channel: 'google-auth:save-secret',
      handler: async (event, { email, authCode }) => {
        saveAuthSecret(email, authCode);
        return { success: true };
      },
      description: '保存谷歌验证密钥',
    },
    {
      channel: 'google-auth:commit-local-secret',
      handler: async (event, { uuid, email, secret }) => {
        saveLocalAuthSecret({ uuid, email }, secret);
        return { success: true };
      },
      description: 'API 成功后提交本地谷歌验证密钥',
    },
    {
      channel: 'google-auth:delete-secret',
      handler: async (event, email) => {
        return { success: true, deleted: deleteAuthSecret(email) };
      },
      description: '删除谷歌验证密钥',
    },
    {
      channel: 'google-auth:list-all',
      handler: async () => {
        return listAllAuthEmails();
      },
      description: '列出所有谷歌验证邮箱',
    },
    {
      channel: 'google-auth:rsa-encrypt',
      handler: async (event, data) => {
        return rsaEncrypt(data);
      },
      description: 'RSA 加密',
    },

    // ==================== Email 处理器 ====================
    {
      channel: 'email:fetch-imap',
      handler: async (event, data) => {
        return await fetchEmailsViaImap(data);
      },
      description: 'IMAP 读取邮件',
    },
    {
      channel: 'email:fetch-pop3',
      handler: async (event, data) => {
        return await fetchEmailsViaPop3(data);
      },
      description: 'POP3 读取邮件',
    },
    {
      channel: 'email:list-local-cache',
      handler: async (event, email) => {
        return listLocalEmailCache(email);
      },
      description: '列出本地邮件缓存',
    },
    {
      channel: 'email:read-local-body',
      handler: async (event, filePath) => {
        return readLocalEmailBody(filePath);
      },
      description: '读取本地邮件正文',
    },
    {
      channel: 'email:scan-auth-status',
      handler: async (event, data) => {
        return scanEmailAuthStatus(data);
      },
      description: '扫描邮件认证状态',
    },
    {
      channel: 'email:extract-code',
      handler: async (event, data) => {
        return extractVerificationCode(data);
      },
      description: '提取验证码',
    },
    {
      channel: 'email:parse-excel',
      handler: async () => {
        return await parseExcelImportFile();
      },
      description: '解析 Excel 导入文件',
    },
    {
      channel: 'email:export-template',
      handler: async () => {
        return await exportImportTemplate();
      },
      description: '导出邮箱导入模板',
    },
    {
      channel: 'email:prepare-import',
      handler: async (event, { emailData, isGoAuthCloud }) => {
        return prepareEmailForImport(emailData, isGoAuthCloud);
      },
      description: '准备邮箱导入数据',
    },
  ]);
};
