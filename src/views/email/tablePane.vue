<template>
  <el-table
    size="small"
    :data="props.searchData"
    border
    @selection-change="handleSelectionChange"
    style="width: 100%; margin-top: 20px"
  >
    <el-table-column type="selection" width="55" />
    <el-table-column type="index" width="50" label="序号" />
    <el-table-column label="账号" min-width="250">
      <template #default="scope">
        <div class="account-cell">
          <span class="account-cell__name">{{ scope.row.apiName || scope.row.email }}</span>
          <span
            v-if="scope.row.apiName && scope.row.apiName !== scope.row.email"
            class="account-cell__email"
          >
            {{ scope.row.email }}
          </span>
          <div class="account-cell__status">
            <el-tag v-if="scope.row.hasMailPassword" size="small" effect="plain">邮箱密码</el-tag>
            <el-tag v-if="scope.row.hasAccountPassword" size="small" effect="plain" type="info">
              账号密码
            </el-tag>
            <el-tag v-if="scope.row.hasGoogleAuth" size="small" effect="plain" type="warning">
              2FA
            </el-tag>
          </div>
        </div>
      </template>
    </el-table-column>
    <el-table-column prop="groupName" label="分组" width="90">
      <template #default="scope">
        <el-button size="small" type="primary" link @click="showGroupDialog(scope.row)">
          {{ scope.row.groupName || '未分组' }}
        </el-button>
      </template>
    </el-table-column>
    <el-table-column label="认证状态" width="100">
      <template #default="scope">
        <el-tag :type="AUTH_STATUS_TYPES[scope.row.authState] || 'info'" size="small">
          {{ AUTH_STATUS_LABELS[scope.row.authState] || '未检测' }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column label="创建时间" width="100">
      <template #default="scope">
        <el-tooltip :content="formatFullCreateTime(scope.row.createTime)" placement="top">
          <span>{{ formatCreateDay(scope.row.createTime) }}</span>
        </el-tooltip>
      </template>
    </el-table-column>
    <el-table-column prop="beizhu" label="备注" width="150" show-overflow-tooltip>
      <template #default="scope">
        <el-input
          v-if="editingBeizhu === scope.row.uuid"
          v-model="scope.row.beizhu"
          size="small"
          @blur="handleBeizhuBlur(scope.row)"
          @keyup.enter="handleBeizhuBlur(scope.row)"
          autofocus
        />
        <span
          v-else
          @dblclick="startRemarkEdit(scope.row)"
          style="cursor: pointer"
          title="双击编辑备注"
        >
          {{ scope.row.beizhu || '-' }}
        </span>
      </template>
    </el-table-column>
    <el-table-column label="操作" min-width="420">
      <template #default="scope">
        <el-button
          size="small"
          type="success"
          :loading="isActionRunning(scope.row, 'edit')"
          @click="handleEditEmail(scope.row)"
        >
          编辑
        </el-button>
        <el-button
          size="small"
          type="primary"
          :loading="isActionRunning(scope.row, 'mail')"
          @click="handleViewEmail(scope.row)"
        >
          查看邮件
        </el-button>
        <el-button
          size="small"
          type="success"
          :loading="isActionRunning(scope.row, 'code')"
          @click="handleExtractCode(scope.row)"
        >
          验证码
        </el-button>
        <el-button
          size="small"
          type="warning"
          :loading="isActionRunning(scope.row, 'google')"
          @click="handleGetGoogleCode(scope.row)"
        >
          谷歌码
        </el-button>
        <el-button
          size="small"
          type="info"
          :loading="isActionRunning(scope.row, 'auth')"
          @click="handleScanAuth(scope.row)"
        >
          实名
        </el-button>
        <el-button
          size="small"
          type="danger"
          :loading="deletingIds.has(scope.row.uuid)"
          :disabled="batchDeleting || deletingIds.has(scope.row.uuid)"
          @click="handleDelete(scope.row)"
        >
          删除
        </el-button>
      </template>
    </el-table-column>
  </el-table>

  <el-dialog title="选择分组" v-model="showSelectGroup" width="400px" :destroy-on-close="true">
    <SelectEmailGroup v-model="selectedGroupId" style="width: 100%" />
    <template #footer>
      <el-button @click="showSelectGroup = false">取消</el-button>
      <el-button type="primary" :loading="groupUpdating" @click="handleGroupUpdate">确定</el-button>
    </template>
  </el-dialog>

  <el-dialog
    title="编辑账号"
    v-model="showEditDialog"
    width="520px"
    :destroy-on-close="true"
    @closed="resetEditForm"
  >
    <el-form ref="editFormRef" :model="editForm" :rules="editRules" label-width="100px">
      <el-form-item label="账号名称">
        <el-input v-model="editForm.apiName" placeholder="留空时默认使用邮箱地址" />
      </el-form-item>
      <el-form-item label="邮箱地址" prop="email">
        <el-input v-model="editForm.email" placeholder="邮箱地址" />
      </el-form-item>
      <el-form-item label="邮箱密码" prop="mailPassword">
        <el-input
          v-model="editForm.mailPassword"
          type="password"
          show-password
          placeholder="邮箱密码或授权码"
        />
      </el-form-item>
      <el-form-item label="账号密码">
        <el-input
          v-model="editForm.bianPassword"
          type="password"
          show-password
          placeholder="账号密码（可选）"
        />
      </el-form-item>
      <el-form-item label="分组">
        <SelectEmailGroup v-model="editForm.groupId" />
      </el-form-item>
      <el-form-item label="谷歌验证密钥">
        <el-input
          v-model="editForm.googleAuth"
          type="password"
          :placeholder="googleAuthPlaceholder"
        />
        <el-button
          v-if="
            emailStore.systemConfig.cloudRecoveryVersion >= 1 &&
            editCloudGoogleAuthStatus !== 'ready'
          "
          type="warning"
          link
          :loading="authMigrationPreparing"
          :disabled="editLoading"
          @click="prepareAuthMigration(editForm)"
        >
          迁移旧密钥或重新录入
        </el-button>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="editForm.beizhu" type="textarea" :rows="2" placeholder="备注" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="showEditDialog = false">取消</el-button>
      <el-button type="primary" :loading="editLoading" @click="handleEditSubmit">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog
    :title="codeDialog.title"
    v-model="showCodeDialog"
    width="460px"
    :destroy-on-close="true"
    @closed="resetCodeDialog"
  >
    <div class="code-account">
      <strong>{{ codeDialog.accountName }}</strong>
      <span v-if="codeDialog.email">{{ codeDialog.email }}</span>
    </div>

    <div v-if="codeDialog.loading" class="code-loading">
      <el-skeleton :rows="2" animated />
    </div>
    <div v-else-if="codeDialog.code" class="code-result">
      <span class="code-result__value">{{ codeDialog.code }}</span>
      <el-button type="primary" @click="copyCurrentCode">复制</el-button>
    </div>
    <el-empty v-else :image-size="72" :description="codeDialog.message || '未找到验证码'" />

    <el-alert
      v-if="!codeDialog.loading && codeDialog.notice"
      class="code-notice"
      :type="codeDialog.code ? 'info' : 'warning'"
      :closable="false"
      show-icon
      :title="codeDialog.notice"
    />
    <div v-if="codeDialog.code && (codeDialog.subject || codeDialog.emailTime)" class="code-source">
      <span v-if="codeDialog.subject">来源：{{ codeDialog.subject }}</span>
      <span v-if="codeDialog.emailTime"
        >时间：{{ formatFullCreateTime(codeDialog.emailTime) }}</span
      >
    </div>

    <template #footer>
      <el-button
        v-if="codeDialog.kind === 'google' && !codeDialog.loading && !codeDialog.code"
        type="warning"
        :loading="authMigrationPreparing"
        @click="prepareAuthMigration(currentCodeRow)"
      >
        迁移旧密钥或重新录入
      </el-button>
      <el-button :loading="codeDialog.loading" @click="refreshCurrentCode">刷新</el-button>
      <el-button v-if="codeDialog.code" type="primary" @click="copyCurrentCode">
        复制验证码
      </el-button>
      <el-button @click="showCodeDialog = false">关闭</el-button>
    </template>
  </el-dialog>

  <el-dialog
    title="恢复谷歌验证密钥"
    v-model="showAuthMigrationDialog"
    width="500px"
    :destroy-on-close="true"
    :close-on-click-modal="false"
    :close-on-press-escape="!authMigrationLoading"
    :show-close="!authMigrationLoading"
    @closed="resetAuthMigration"
  >
    <p>{{ authMigration.email }}</p>
    <el-alert :title="authMigration.message" type="info" :closable="false" show-icon />
    <el-radio-group
      v-model="authMigration.source"
      class="auth-migration-source"
      :disabled="authMigrationLoading"
    >
      <el-radio v-if="authMigration.localStatus === 'available'" value="local">
        使用本机加密保存的密钥
      </el-radio>
      <el-radio value="manual">重新输入密钥</el-radio>
    </el-radio-group>
    <el-input
      v-if="authMigration.source === 'manual'"
      v-model="authMigration.secret"
      type="password"
      maxlength="256"
      autocomplete="off"
      placeholder="输入原有谷歌验证密钥（Base32）"
      :disabled="authMigrationLoading"
    />
    <p class="auth-migration-notice">
      确认后密钥会加密保存到云端，并验证验证码。完成后换电脑登录即可使用。
      云端已有可用密钥时会保留云端密钥。
    </p>
    <template #footer>
      <el-button :disabled="authMigrationLoading" @click="showAuthMigrationDialog = false"
        >取消</el-button
      >
      <el-button type="primary" :loading="authMigrationLoading" @click="commitAuthMigration">
        确认保存并验证
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
  import { getUserFacingErrorMessage } from '@/utils/error.mjs';
  import { onUnmounted, reactive, ref } from 'vue';
  import {
    deleteEmails,
    editEmail,
    getCloudGoogleAuthCode,
    getEmailDetail,
    updateEmailField,
    updateEmailGroup,
  } from '@/api/email';
  import { useMessage, useConfirm } from '@/composables/useGlobalProperties';
  import { AUTH_STATUS_LABELS, AUTH_STATUS_TYPES, getEmailServerConfig } from '@/constants/email';
  import SelectEmailGroup from '@/components/SelectEmailGroup.vue';
  import { useEmailStore } from '@/store/emailStore';

  const message = useMessage();
  const { confirm } = useConfirm();
  const emailStore = useEmailStore();

  const props = defineProps({
    searchData: {
      type: Array,
      default: () => [],
    },
  });

  const emit = defineEmits(['refreshData', 'showEmailDetail']);
  const multipleSelection = ref([]);
  const deletingIds = ref(new Set());
  const batchDeleting = ref(false);
  const runningActions = reactive(new Set());
  const actionKey = (row, action) => `${row.uuid}:${action}`;
  const isActionRunning = (row, action) => runningActions.has(actionKey(row, action));

  const showAuthMigrationDialog = ref(false);
  const authMigrationPreparing = ref(false);
  const authMigrationLoading = ref(false);
  const authMigration = reactive({
    uuid: '',
    ticket: '',
    email: '',
    localStatus: '',
    message: '',
    source: 'manual',
    secret: '',
  });
  let authMigrationSequence = 0;

  const resetAuthMigration = () => {
    authMigrationSequence += 1;
    Object.assign(authMigration, {
      uuid: '',
      ticket: '',
      email: '',
      localStatus: '',
      message: '',
      source: 'manual',
      secret: '',
    });
  };

  const prepareAuthMigration = async row => {
    if (!row?.uuid || authMigrationPreparing.value || authMigrationLoading.value) return;
    if (!emailStore.systemConfigLoaded || emailStore.systemConfig.cloudRecoveryVersion < 1) {
      message.info('当前后端尚不支持云端密钥恢复，请更新后端后再试');
      return;
    }
    authMigrationPreparing.value = true;
    const requestId = ++authMigrationSequence;
    try {
      const result = await window.ipcRenderer.prepareGoogleAuthMigration({ uuid: row.uuid });
      if (requestId !== authMigrationSequence) return;
      if (result.status === 'ready') {
        message.info(result.message);
        emit('refreshData');
        return;
      }
      Object.assign(authMigration, {
        uuid: row.uuid,
        ticket: result.ticket,
        email: result.email,
        localStatus: result.localStatus,
        message: result.message,
        source: result.localStatus === 'available' ? 'local' : 'manual',
        secret: '',
      });
      showAuthMigrationDialog.value = true;
    } catch (err) {
      if (requestId === authMigrationSequence) message.error(err?.message || '检查旧密钥失败');
    } finally {
      authMigrationPreparing.value = false;
    }
  };

  const commitAuthMigration = async () => {
    if (!authMigration.ticket || authMigrationLoading.value) return;
    if (authMigration.source === 'manual' && !authMigration.secret.trim()) {
      message.warning('请输入谷歌验证密钥');
      return;
    }
    authMigrationLoading.value = true;
    const uuid = authMigration.uuid;
    try {
      const result = await window.ipcRenderer.commitGoogleAuthMigration({
        ticket: authMigration.ticket,
        confirmed: true,
        source: authMigration.source,
        ...(authMigration.source === 'manual' ? { secret: authMigration.secret } : {}),
      });
      authMigration.secret = '';
      if (result.success) {
        message.success(result.message);
        if (editForm.uuid === uuid) {
          editForm.googleAuth = '';
          editHasGoogleAuth.value = true;
          editCloudGoogleAuthStatus.value = 'ready';
          googleAuthPlaceholder.value = '已设置，留空保持不变；输入新密钥则更新';
        }
        if (currentCodeRow.value?.uuid === uuid && codeDialog.kind === 'google') {
          codeRequestSequence += 1;
          codeDialog.code = result.code || '';
          codeDialog.message = '';
          codeDialog.notice = '来源：云端加密密钥，已完成迁移验证';
          codeDialog.loading = false;
        }
      } else {
        message.warning(result.message || '迁移尚未验证成功');
      }
      showAuthMigrationDialog.value = false;
      emit('refreshData');
    } catch (err) {
      // 新确认需要重新读取云端状态，旧票据不能重复提交。
      authMigration.secret = '';
      showAuthMigrationDialog.value = false;
      message.error(err?.message || '密钥迁移失败，请重新打开迁移窗口');
    } finally {
      authMigrationLoading.value = false;
    }
  };

  const normalizeDate = value => {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric <= 0) return null;
    const normalizedValue = Number.isFinite(numeric)
      ? numeric > 0 && numeric < 1_000_000_000_000
        ? numeric * 1000
        : numeric
      : value;
    const date = new Date(normalizedValue);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const padDatePart = value => String(value).padStart(2, '0');

  const formatCreateDay = value => {
    const date = normalizeDate(value);
    if (!date) return '--';
    return `${padDatePart(date.getMonth() + 1)}月${padDatePart(date.getDate())}日`;
  };

  const formatFullCreateTime = value => {
    const date = normalizeDate(value);
    if (!date) return '暂无创建时间';
    return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(
      date.getDate()
    )} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(
      date.getSeconds()
    )}`;
  };

  const fetchAccountDetail = async row => {
    if (!row?.uuid) throw new Error('账号标识为空');
    const detail = await getEmailDetail({ uuid: row.uuid });
    if (!detail || typeof detail !== 'object') throw new Error('账号详情为空');
    const merged = { ...row, ...detail };
    merged.uuid = detail.uuid || row.uuid;
    merged.email = detail.email || row.email || '';
    merged.apiName = detail.apiName || row.apiName || merged.email;
    return merged;
  };

  const cleanupLocalAuthSecrets = async rows => {
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    const results = await Promise.allSettled(
      rows.map(row => window.ipcRenderer.deleteAuthSecret({ uuid: row?.uuid, email: row?.email }))
    );
    return results.filter(result => result.status === 'rejected').length;
  };

  const handleSelectionChange = val => {
    multipleSelection.value = val;
  };

  const handleViewEmail = async row => {
    const key = actionKey(row, 'mail');
    if (runningActions.has(key)) return;
    runningActions.add(key);
    try {
      const detail = await fetchAccountDetail(row);
      if (!detail.email) {
        message.warning('邮箱地址为空');
        return;
      }
      if (!detail.mailPassword) {
        message.info('未保存邮箱密码，将只显示本地缓存邮件');
      }
      emit('showEmailDetail', detail);
    } catch (err) {
      if (!err?.isNotified) message.error(err?.message || '读取账号详情失败');
    } finally {
      runningActions.delete(key);
    }
  };

  const showCodeDialog = ref(false);
  const currentCodeRow = ref(null);
  const codeDialog = reactive({
    title: '验证码',
    kind: 'email',
    accountName: '',
    email: '',
    code: '',
    message: '',
    notice: '',
    subject: '',
    emailTime: null,
    loading: false,
  });
  let codeRequestSequence = 0;

  const openCodeDialog = (row, kind) => {
    codeRequestSequence += 1;
    currentCodeRow.value = row;
    Object.assign(codeDialog, {
      title: kind === 'google' ? '谷歌验证码' : '邮件验证码',
      kind,
      accountName: row.apiName || row.email || '未命名账号',
      email: row.email || '',
      code: '',
      message: kind === 'google' ? '正在生成谷歌验证码…' : '正在同步并读取最近邮件…',
      notice: '',
      subject: '',
      emailTime: null,
      loading: true,
    });
    showCodeDialog.value = true;
    return codeRequestSequence;
  };

  const resetCodeDialog = () => {
    codeRequestSequence += 1;
    currentCodeRow.value = null;
    Object.assign(codeDialog, {
      code: '',
      message: '',
      notice: '',
      subject: '',
      emailTime: null,
      loading: false,
    });
  };

  const syncLatestEmails = async detail => {
    if (!detail.mailPassword) return '未保存邮箱密码，已从本地缓存查找验证码';

    const syncType = emailStore.systemConfig.emailSyncType || 'imap';
    const serverConfig = getEmailServerConfig(detail.email, syncType);
    if (!serverConfig) return '无法识别邮件服务器，已从本地缓存查找验证码';

    const fetchData = {
      email: detail.email,
      password: detail.mailPassword,
      host: serverConfig.host,
      port: serverConfig.port,
      tls: serverConfig.tls,
      verifyCertificate: serverConfig.verifyCertificate,
    };

    try {
      if (syncType === 'pop3') {
        await window.ipcRenderer.fetchEmailsViaPop3(fetchData);
      } else {
        await window.ipcRenderer.fetchEmailsViaImap(fetchData);
      }
      return '已同步最新邮件';
    } catch (err) {
      return `已读取本地缓存。${getUserFacingErrorMessage(err, '邮件同步失败，请检查密码和网络')}`;
    }
  };

  const handleExtractCode = async row => {
    const key = actionKey(row, 'code');
    if (runningActions.has(key)) return;
    runningActions.add(key);
    const requestId = openCodeDialog(row, 'email');

    try {
      let detail = { ...row };
      let syncNotice = '';
      try {
        detail = await fetchAccountDetail(row);
        syncNotice = await syncLatestEmails(detail);
      } catch (err) {
        syncNotice = `已读取本地缓存。${getUserFacingErrorMessage(err, '账号详情读取失败，请重试')}`;
      }

      const result = await window.ipcRenderer.extractVerificationCode({
        email: detail.email || row.email,
        maxAgeMs: 30 * 60 * 1000,
      });
      if (requestId !== codeRequestSequence || !showCodeDialog.value) return;

      codeDialog.notice = syncNotice;
      if (result.success) {
        codeDialog.code = result.code || '';
        codeDialog.message = '';
        codeDialog.subject = result.subject || '';
        codeDialog.emailTime = result.emailTime || null;
      } else {
        codeDialog.code = '';
        codeDialog.message = getUserFacingErrorMessage(result, '最近邮件中未找到验证码');
      }
    } catch (err) {
      if (requestId === codeRequestSequence && showCodeDialog.value) {
        codeDialog.message = getUserFacingErrorMessage(err, '提取验证码失败，请重试');
      }
    } finally {
      if (requestId === codeRequestSequence) codeDialog.loading = false;
      runningActions.delete(key);
    }
  };

  const handleGetGoogleCode = async row => {
    const key = actionKey(row, 'google');
    if (runningActions.has(key)) return;
    runningActions.add(key);
    const requestId = openCodeDialog(row, 'google');

    try {
      if (!emailStore.systemConfigLoaded) {
        throw new Error('无法确认服务端 Google Auth 恢复能力，请刷新后重试');
      }

      let result;
      let source;
      if (emailStore.systemConfig.cloudRecoveryVersion >= 1) {
        if (!row.uuid) throw new Error('账号缺少 UUID，无法从云端生成验证码');
        const cloudResult = await getCloudGoogleAuthCode({ uuid: row.uuid });
        const cloudCode = String(cloudResult?.code || '');
        if (!/^\d{6}$/.test(cloudCode)) throw new Error('云端未返回有效验证码');
        result = { success: true, code: cloudCode };
        source = '云端加密密钥';
      } else {
        result = await window.ipcRenderer.getGoogleAuthCode({ uuid: row.uuid, email: row.email });
        source = '本机系统加密密钥';
      }
      if (requestId !== codeRequestSequence || !showCodeDialog.value) return;
      if (result.success) {
        codeDialog.code = result.code || '';
        codeDialog.message = '';
        codeDialog.notice = `来源：${source}`;
      } else {
        codeDialog.code = '';
        codeDialog.message = getUserFacingErrorMessage(result, '未找到谷歌验证密钥');
      }
    } catch (err) {
      if (requestId === codeRequestSequence && showCodeDialog.value) {
        codeDialog.message = getUserFacingErrorMessage(err, '获取谷歌验证码失败，请重试');
      }
    } finally {
      if (requestId === codeRequestSequence) codeDialog.loading = false;
      runningActions.delete(key);
    }
  };

  const refreshCurrentCode = () => {
    const row = currentCodeRow.value;
    if (!row || codeDialog.loading) return;
    if (codeDialog.kind === 'google') {
      handleGetGoogleCode(row);
    } else {
      handleExtractCode(row);
    }
  };

  const copyCurrentCode = async () => {
    if (!codeDialog.code) return;
    try {
      await navigator.clipboard.writeText(codeDialog.code);
      message.success('验证码已复制到剪贴板');
    } catch {
      message.error('复制失败，请手动选择验证码');
    }
  };

  const handleScanAuth = async row => {
    const key = actionKey(row, 'auth');
    if (runningActions.has(key)) return;
    runningActions.add(key);
    try {
      const result = await window.ipcRenderer.scanEmailAuthStatus({ email: row.email });

      await updateEmailField({
        uuid: row.uuid,
        changeField: 'authState',
        authState: result.authState,
      });

      row.authState = result.authState;

      if (result.authState === 1 || result.authState === 3) {
        message.success('已实名');
      } else if (result.authState === 2 || result.authState === 4) {
        message.warning('未实名或认证失败');
      } else {
        message.info('未检测到实名认证信息');
      }
    } catch (err) {
      message.error('验实名失败');
    } finally {
      runningActions.delete(key);
    }
  };

  const handleDelete = async row => {
    if (!row.uuid || batchDeleting.value || deletingIds.value.has(row.uuid)) return;

    deletingIds.value.add(row.uuid);
    try {
      await confirm('确定要删除这个账号吗？');
      await deleteEmails({ uuidData: [row.uuid] });
      message.success('账号删除成功');
      if ((await cleanupLocalAuthSecrets([row])) > 0) {
        message.warning('账号已删除，但本地 Google Auth 密钥清理失败');
      }
      emit('refreshData');
    } catch (err) {
      if (err !== 'cancel' && err !== 'close' && !err?.isNotified) {
        message.error('删除失败');
      }
    } finally {
      deletingIds.value.delete(row.uuid);
    }
  };

  const deleteSelected = async () => {
    if (batchDeleting.value) return;
    if (deletingIds.value.size > 0) {
      message.info('请等待当前删除操作完成');
      return;
    }
    if (multipleSelection.value.length === 0) {
      message.info('请选择至少一个账号');
      return;
    }

    const uuids = multipleSelection.value.map(item => item.uuid).filter(Boolean);
    batchDeleting.value = true;
    uuids.forEach(uuid => deletingIds.value.add(uuid));
    try {
      await confirm(`确定要删除选中的 ${uuids.length} 个账号吗？`);
      await deleteEmails({ uuidData: uuids });
      message.success('批量删除成功');
      const cleanupFailures = await cleanupLocalAuthSecrets(multipleSelection.value);
      if (cleanupFailures > 0) {
        message.warning(`账号已删除，但有 ${cleanupFailures} 个本地 Google Auth 密钥清理失败`);
      }
      multipleSelection.value = [];
      emit('refreshData');
    } catch (err) {
      if (err !== 'cancel' && err !== 'close' && !err?.isNotified) {
        message.error('批量删除失败');
      }
    } finally {
      uuids.forEach(uuid => deletingIds.value.delete(uuid));
      batchDeleting.value = false;
    }
  };

  const showSelectGroup = ref(false);
  const selectedGroupId = ref('');
  const currentEditRow = ref(null);
  const groupUpdating = ref(false);

  const showGroupDialog = row => {
    currentEditRow.value = row;
    selectedGroupId.value = row.groupId || '';
    showSelectGroup.value = true;
  };

  const handleGroupUpdate = async () => {
    if (!currentEditRow.value || groupUpdating.value) return;
    groupUpdating.value = true;
    try {
      await updateEmailGroup({
        group: [currentEditRow.value.uuid],
        groupId: selectedGroupId.value,
      });
      message.success('分组已更新');
      showSelectGroup.value = false;
      emit('refreshData');
    } catch (err) {
      if (!err?.isNotified) message.error('更新分组失败');
    } finally {
      groupUpdating.value = false;
    }
  };

  const editingBeizhu = ref(null);
  const originalRemarks = new Map();
  const savingRemarks = new Set();

  const startRemarkEdit = row => {
    originalRemarks.set(row.uuid, row.beizhu || '');
    editingBeizhu.value = row.uuid;
  };

  const handleBeizhuBlur = async row => {
    if (savingRemarks.has(row.uuid)) return;
    editingBeizhu.value = null;
    const original = originalRemarks.get(row.uuid) || '';
    const nextValue = row.beizhu || '';
    if (nextValue === original) {
      originalRemarks.delete(row.uuid);
      return;
    }
    savingRemarks.add(row.uuid);
    try {
      await updateEmailField({
        uuid: row.uuid,
        changeField: 'beizhu',
        beizhu: row.beizhu + '',
      });
    } catch (err) {
      row.beizhu = original;
      if (!err?.isNotified) message.error('更新备注失败');
    } finally {
      originalRemarks.delete(row.uuid);
      savingRemarks.delete(row.uuid);
    }
  };

  const showEditDialog = ref(false);
  const editForm = reactive({
    uuid: '',
    apiName: '',
    email: '',
    mailPassword: '',
    bianPassword: '',
    groupId: '',
    googleAuth: '',
    beizhu: '',
  });
  const editOriginalEmail = ref('');
  const editHasGoogleAuth = ref(false);
  const editCloudGoogleAuthStatus = ref('');
  const googleAuthPlaceholder = ref('2FA 密钥（可选，提交后将加密保存）');
  const editFormRef = ref(null);
  const editLoading = ref(false);
  const editRules = {
    email: [
      { required: true, message: '请输入邮箱地址', trigger: 'blur' },
      { type: 'email', message: '邮箱格式不正确', trigger: 'blur' },
    ],
    mailPassword: [{ required: true, message: '请输入邮箱密码或授权码', trigger: 'blur' }],
  };

  const resetEditForm = () => {
    editFormRef.value?.clearValidate();
    Object.assign(editForm, {
      uuid: '',
      apiName: '',
      email: '',
      mailPassword: '',
      bianPassword: '',
      groupId: '',
      googleAuth: '',
      beizhu: '',
    });
    editOriginalEmail.value = '';
    editHasGoogleAuth.value = false;
    editCloudGoogleAuthStatus.value = '';
    googleAuthPlaceholder.value = '2FA 密钥（可选，提交后将加密保存）';
  };

  const handleEditEmail = async row => {
    const key = actionKey(row, 'edit');
    if (runningActions.has(key)) return;
    runningActions.add(key);
    try {
      const detail = await fetchAccountDetail(row);
      let hasLocalGoogleAuth = false;
      try {
        const localAuthEmails = await window.ipcRenderer.listAllAuthEmails();
        hasLocalGoogleAuth =
          Array.isArray(localAuthEmails) && localAuthEmails.includes(detail.email);
      } catch {
        // 本地列表读取失败不阻塞账号编辑。
      }

      resetEditForm();
      editForm.uuid = detail.uuid;
      editForm.apiName = detail.apiName || detail.email || '';
      editForm.email = detail.email || '';
      editForm.mailPassword = detail.mailPassword || '';
      editForm.bianPassword = detail.bianPassword || '';
      editForm.groupId = detail.groupId || '';
      editForm.googleAuth = '';
      editForm.beizhu = detail.beizhu || '';
      editOriginalEmail.value = detail.email || '';
      editHasGoogleAuth.value = Boolean(
        detail.hasGoogleAuth || row.hasGoogleAuth || hasLocalGoogleAuth
      );
      editCloudGoogleAuthStatus.value = detail.googleAuthStatus || '';
      googleAuthPlaceholder.value = editHasGoogleAuth.value
        ? '已设置，留空保持不变；输入新密钥则更新'
        : '2FA 密钥（可选，提交后将加密保存）';
      showEditDialog.value = true;
    } catch (err) {
      if (!err?.isNotified) message.error(err?.message || '读取账号详情失败');
    } finally {
      runningActions.delete(key);
    }
  };

  const handleEditSubmit = async () => {
    if (!editForm.uuid || editLoading.value) return;
    const valid = await editFormRef.value?.validate().catch(() => false);
    if (!valid) return;

    const email = editForm.email.trim();
    const newGoogleAuth = (editForm.googleAuth || '').trim();
    const changedEmail = email !== editOriginalEmail.value;
    if (
      changedEmail &&
      editHasGoogleAuth.value &&
      !newGoogleAuth &&
      editCloudGoogleAuthStatus.value !== 'ready'
    ) {
      message.warning('修改邮箱地址时请重新输入谷歌验证密钥，以便安全迁移本地密钥');
      return;
    }

    editLoading.value = true;
    try {
      const payload = {
        uuid: editForm.uuid,
        apiName: editForm.apiName.trim() || email,
        email,
        mailPassword: editForm.mailPassword,
        bianPassword: editForm.bianPassword,
        beizhu: editForm.beizhu,
        groupId: editForm.groupId === '' ? 0 : editForm.groupId,
      };

      if (newGoogleAuth) {
        const prepared = await window.ipcRenderer.prepareEmailForImport(
          { email, googleAuth: newGoogleAuth },
          {
            isGoAuthCloud: emailStore.systemConfig.isGoAuthCloud,
            cloudRecoveryVersion: emailStore.systemConfig.cloudRecoveryVersion,
            cloudRecoveryCapabilityKnown: emailStore.systemConfigLoaded,
          }
        );
        if (prepared.googleAuth) payload.googleAuth = prepared.googleAuth;
      }

      await editEmail(payload);
      if (newGoogleAuth) {
        try {
          await window.ipcRenderer.commitLocalAuthSecret({
            uuid: editForm.uuid,
            email,
            secret: newGoogleAuth,
          });
        } catch {
          message.warning('账号已更新，但本地 Google Auth 缓存写入失败');
        }
      }
      if (changedEmail && newGoogleAuth && editOriginalEmail.value) {
        try {
          await window.ipcRenderer.deleteAuthSecret(editOriginalEmail.value);
        } catch {
          message.warning('账号已更新，但旧邮箱对应的本地 Google Auth 密钥清理失败');
        }
      }
      message.success('账号编辑成功');
      showEditDialog.value = false;
      emit('refreshData');
    } catch (err) {
      if (!err?.isNotified) message.error(err?.message || '账号编辑失败');
    } finally {
      editLoading.value = false;
    }
  };

  onUnmounted(() => {
    resetAuthMigration();
    resetCodeDialog();
    resetEditForm();
  });

  defineExpose({ deleteSelected });
</script>

<style scoped>
  .auth-migration-source {
    display: flex;
    margin: 16px 0;
  }

  .auth-migration-notice {
    color: var(--el-text-color-secondary);
    font-size: 13px;
    line-height: 1.6;
  }

  .account-cell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 3px;
  }

  .account-cell__name,
  .account-cell__email {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-cell__name {
    color: var(--app-text-primary);
    font-weight: 600;
  }

  .account-cell__email {
    color: var(--app-text-secondary);
    font-size: 12px;
  }

  .account-cell__status {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .code-account {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 18px;
    color: var(--app-text-secondary);
  }

  .code-account strong {
    color: var(--app-text-primary);
  }

  .code-loading {
    min-height: 112px;
  }

  .code-result {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    min-height: 112px;
    padding: 8px 0;
  }

  .code-result__value {
    color: var(--el-color-primary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 36px;
    font-weight: 700;
    letter-spacing: 8px;
    user-select: all;
  }

  .code-notice {
    margin-top: 12px;
  }

  .code-source {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 12px;
    color: var(--app-text-secondary);
    font-size: 12px;
  }
</style>
