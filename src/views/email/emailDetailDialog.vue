<template>
  <el-dialog title="邮件详情" v-model="visible" width="80%" :destroy-on-close="true" top="5vh">
    <div class="email-detail-container">
      <!-- 左侧邮件列表 -->
      <div class="email-list">
        <div class="email-list-header">
          <span>邮件列表 ({{ emailList.length }})</span>
          <div>
            <el-button
              size="small"
              type="primary"
              link
              :loading="fetching"
              @click="fetchLatestEmails"
            >
              {{ fetching ? '读取中' : '刷新' }}
            </el-button>
          </div>
        </div>
        <div v-if="fetching && emailList.length === 0" class="fetch-tip">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>正在读取最新邮件...</span>
        </div>
        <div class="email-list-content">
          <div
            v-for="(item, index) in emailList"
            :key="index"
            class="email-item"
            :class="{ active: selectedIndex === index }"
            @click="selectEmail(index)"
          >
            <div class="email-subject">{{ item.subject || '(无主题)' }}</div>
            <div class="email-meta">
              <span class="email-from">{{ item.boxName || '' }}</span>
              <span class="email-date">{{ formatEmailDate(item.emailTime) }}</span>
            </div>
          </div>
          <div v-if="!fetching && emailList.length === 0" class="empty-tip">暂无邮件</div>
        </div>
      </div>

      <!-- 右侧邮件正文 -->
      <div class="email-body">
        <div v-if="selectedIndex >= 0 && emailList[selectedIndex]" class="email-body-header">
          <div class="email-body-header__copy">
            <h3>{{ emailList[selectedIndex].subject }}</h3>
            <p>
              <strong>收件箱:</strong> {{ emailList[selectedIndex].boxName || 'INBOX' }}
              <strong style="margin-left: 20px">时间:</strong>
              {{ formatEmailDate(emailList[selectedIndex].emailTime) }}
            </p>
          </div>
          <el-button size="small" @click="allowExternalImages = !allowExternalImages">
            {{ allowExternalImages ? '已允许外部图片' : '加载外部图片' }}
          </el-button>
        </div>
        <!-- 邮件正文为不可信内容（任何人都能发邮件），用空 sandbox 的 iframe 隔离：
             禁止脚本执行、表单提交、同源访问，嵌入脚本无法触达父窗口或 IPC 桥 -->
        <iframe
          class="email-body-content"
          sandbox=""
          referrerpolicy="no-referrer"
          :srcdoc="emailBodyDocument"
        ></iframe>
      </div>
    </div>
  </el-dialog>
</template>

<script setup>
  import { computed, ref, watch } from 'vue';
  import { Loading } from '@element-plus/icons-vue';
  import { ElMessage } from '@/utils/message';
  import { useEmailStore } from '@/store/emailStore';
  import { getEmailServerConfig } from '@/constants/email';

  const emailStore = useEmailStore();

  const props = defineProps({
    modelValue: { type: Boolean, default: false },
    email: { type: String, default: '' },
    mailPassword: { type: String, default: '' },
  });

  const emit = defineEmits(['update:modelValue']);

  const visible = ref(false);
  const emailList = ref([]);
  const selectedIndex = ref(-1);
  const emailBodyHtml = ref('<p>请选择一封邮件查看</p>');
  const allowExternalImages = ref(false);
  const fetching = ref(false);
  let accountLoadRequestId = 0;
  let bodyLoadRequestId = 0;

  const resetEmailSelection = () => {
    selectedIndex.value = -1;
    allowExternalImages.value = false;
    emailBodyHtml.value = '<p>请选择一封邮件查看</p>';
  };

  const emailBodyDocument = computed(() => {
    const imageSources = allowExternalImages.value ? 'data: http: https:' : 'data:';
    const policy = `default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'`;
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>body{margin:16px;color:#172033;font:14px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${emailBodyHtml.value}</body></html>`;
  });

  const invalidatePendingLoads = () => {
    accountLoadRequestId += 1;
    bodyLoadRequestId += 1;
    fetching.value = false;
  };

  const isCurrentAccountRequest = (requestId, email) => {
    return requestId === accountLoadRequestId && visible.value && props.email === email;
  };

  const isCurrentBodyRequest = (requestId, accountRequestId, email) => {
    return (
      requestId === bodyLoadRequestId &&
      accountRequestId === accountLoadRequestId &&
      visible.value &&
      props.email === email
    );
  };

  watch(
    () => [props.modelValue, props.email, props.mailPassword],
    ([isOpen, email, mailPassword]) => {
      visible.value = isOpen;
      if (isOpen && email) {
        loadAccount(email, mailPassword);
      } else if (isOpen) {
        invalidatePendingLoads();
        emailList.value = [];
        resetEmailSelection();
      }
    }
  );

  watch(visible, val => {
    if (!val) {
      invalidatePendingLoads();
      emailList.value = [];
      resetEmailSelection();
    }
    emit('update:modelValue', val);
  });

  // 加载本地缓存邮件
  const loadLocalCache = async (email, requestId) => {
    if (!email) return;
    bodyLoadRequestId += 1;
    try {
      const cachedEmails = await window.ipcRenderer.listLocalEmailCache(email);
      if (!isCurrentAccountRequest(requestId, email)) return;
      emailList.value = Array.isArray(cachedEmails) ? cachedEmails : [];
      resetEmailSelection();
    } catch (err) {
      if (!isCurrentAccountRequest(requestId, email)) return;
      emailList.value = [];
      resetEmailSelection();
    }
  };

  const fetchLatestEmailsForAccount = async (email, mailPassword, requestId) => {
    if (!email || !mailPassword || !isCurrentAccountRequest(requestId, email)) return;
    const syncType = emailStore.systemConfig.emailSyncType || 'imap';
    const serverConfig = getEmailServerConfig(email, syncType);
    if (!serverConfig) return;

    const fetchData = {
      email,
      password: mailPassword,
      host: serverConfig.host,
      port: serverConfig.port,
      tls: serverConfig.tls,
      verifyCertificate: serverConfig.verifyCertificate,
    };

    fetching.value = true;
    try {
      if (syncType === 'imap') {
        await window.ipcRenderer.fetchEmailsViaImap(fetchData);
      } else {
        await window.ipcRenderer.fetchEmailsViaPop3(fetchData);
      }
      // 拉取完成后刷新本地缓存列表
      if (isCurrentAccountRequest(requestId, email)) {
        await loadLocalCache(email, requestId);
      }
    } catch (err) {
      if (isCurrentAccountRequest(requestId, email)) {
        ElMessage.error(`读取最新邮件失败：${err?.message || '请检查密码和网络'}`);
      }
    } finally {
      if (isCurrentAccountRequest(requestId, email)) {
        fetching.value = false;
      }
    }
  };

  const loadAccount = async (email, mailPassword) => {
    const requestId = ++accountLoadRequestId;
    bodyLoadRequestId += 1;
    fetching.value = false;
    emailList.value = [];
    resetEmailSelection();

    await loadLocalCache(email, requestId);
    if (!isCurrentAccountRequest(requestId, email)) return;
    await fetchLatestEmailsForAccount(email, mailPassword, requestId);
  };

  // 拉取最新邮件后刷新列表
  const fetchLatestEmails = async () => {
    if (fetching.value) return;
    if (!props.email || !props.mailPassword) {
      ElMessage.warning('缺少邮箱地址或密码，无法同步');
      return;
    }
    const email = props.email;
    const mailPassword = props.mailPassword;
    const requestId = ++accountLoadRequestId;
    await fetchLatestEmailsForAccount(email, mailPassword, requestId);
  };

  const selectEmail = async index => {
    const requestId = ++bodyLoadRequestId;
    const accountRequestId = accountLoadRequestId;
    const accountEmail = props.email;
    selectedIndex.value = index;
    allowExternalImages.value = false;
    const mail = emailList.value[index];
    if (!mail?.bodyPath) {
      emailBodyHtml.value = '<p>邮件正文不可用</p>';
      return;
    }
    const bodyPath = mail.bodyPath;
    try {
      const bodyHtml = await window.ipcRenderer.readLocalEmailBody(bodyPath);
      if (
        isCurrentBodyRequest(requestId, accountRequestId, accountEmail) &&
        selectedIndex.value === index &&
        emailList.value[index]?.bodyPath === bodyPath
      ) {
        emailBodyHtml.value = bodyHtml;
      }
    } catch (err) {
      if (isCurrentBodyRequest(requestId, accountRequestId, accountEmail)) {
        emailBodyHtml.value = '<p>读取邮件正文失败</p>';
      }
    }
  };

  const formatEmailDate = dateVal => {
    if (!dateVal) return '';
    try {
      const d = typeof dateVal === 'number' ? new Date(dateVal) : new Date(dateVal);
      return d.toLocaleString('zh-CN');
    } catch {
      return dateVal + '';
    }
  };
</script>

<style scoped>
  .email-detail-container {
    display: flex;
    height: 60vh;
    gap: 12px;
  }
  .email-list {
    width: 300px;
    flex-shrink: 0;
    border: 1px solid #e4e7ed;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
  }
  .email-list-header {
    padding: 8px 12px;
    border-bottom: 1px solid #e4e7ed;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 14px;
    font-weight: bold;
  }
  .email-list-content {
    flex: 1;
    overflow-y: auto;
  }
  .email-item {
    padding: 8px 12px;
    border-bottom: 1px solid #f0f0f0;
    cursor: pointer;
  }
  .email-item:hover {
    background-color: #f5f7fa;
  }
  .email-item.active {
    background-color: #ecf5ff;
  }
  .email-subject {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .email-meta {
    font-size: 11px;
    color: #909399;
    margin-top: 4px;
    display: flex;
    justify-content: space-between;
  }
  .email-from {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 150px;
  }
  .email-body {
    flex: 1;
    border: 1px solid #e4e7ed;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .email-body-header {
    padding: 8px 12px;
    border-bottom: 1px solid #e4e7ed;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .email-body-header__copy {
    min-width: 0;
  }
  .email-body-header h3 {
    margin: 0 0 4px 0;
    font-size: 14px;
  }
  .email-body-header p {
    margin: 0;
    font-size: 12px;
    color: #606266;
  }
  .email-body-content {
    flex: 1;
    width: 100%;
    border: none;
    background-color: #fff;
  }
  .empty-tip {
    text-align: center;
    padding: 20px;
    color: #909399;
    font-size: 13px;
  }
  .fetch-tip {
    text-align: center;
    padding: 20px;
    color: #409eff;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
</style>
