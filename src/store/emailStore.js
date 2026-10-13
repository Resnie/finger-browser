import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useEmailStore = defineStore('email', () => {
  // 邮件读取进度跟踪 { [email]: { status, message, current, total } }
  const fetchingEmails = ref({});

  // 系统配置缓存
  const systemConfig = ref({
    isGoAuthCloud: 0,
    isEmailCloud: 0,
    emailSyncType: 'imap',
    mailDomain: '',
    isMailboxRegistrationConfigured: false,
    cloudRecoveryVersion: 0,
  });
  // false 表示尚未收到服务端成功响应，不等同于已确认的旧后端 v0。
  const systemConfigLoaded = ref(false);

  // 更新邮件读取进度
  const setFetchProgress = (email, data) => {
    fetchingEmails.value[email] = { ...fetchingEmails.value[email], ...data };
  };

  // 清除邮件读取进度
  const clearFetchProgress = email => {
    delete fetchingEmails.value[email];
  };

  // 设置系统配置
  const setSystemConfig = config => {
    const normalized = { ...config };
    // 后端 emailSyncType 可能是 int，前端使用 string ('imap'/'pop3')
    if (typeof normalized.emailSyncType === 'number') {
      normalized.emailSyncType = normalized.emailSyncType === 1 ? 'pop3' : 'imap';
    }
    const recoveryVersion = Number(normalized.cloudRecoveryVersion);
    normalized.cloudRecoveryVersion =
      Number.isSafeInteger(recoveryVersion) && recoveryVersion >= 1 ? 1 : 0;
    systemConfig.value = { ...systemConfig.value, ...normalized };
    systemConfigLoaded.value = true;
  };

  return {
    fetchingEmails,
    systemConfig,
    systemConfigLoaded,
    setFetchProgress,
    clearFetchProgress,
    setSystemConfig,
  };
});
