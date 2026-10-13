<template>
  <div class="search-pane">
    <el-input
      size="small"
      style="width: 200px"
      v-model="searchText"
      placeholder="账号名称或邮箱地址"
      clearable
      @keyup.enter="handleSearch"
    ></el-input>
    <el-select
      size="small"
      style="margin-left: 10px; width: 200px"
      v-model="selectGroup"
      filterable
      clearable
      placeholder="选择分组"
      @change="handleGroupChange"
    >
      <el-option
        v-for="item in groupOptions"
        :key="item.value"
        :label="item.label"
        :value="item.value"
      />
    </el-select>
    <el-button size="small" type="primary" :loading="searchLoading" @click="handleSearch">
      搜索
    </el-button>
    <el-button size="small" type="success" @click="showAddDialog = true">添加账号</el-button>
    <el-button size="small" type="primary" @click="handleFastAdd">快速添加</el-button>
    <el-button size="small" type="warning" @click="handleImportExcel">导入</el-button>
    <el-button size="small" type="info" @click="handleExportTemplate">模板下载</el-button>
    <el-button size="small" type="danger" @click="emit('batchDelete')">批量删除</el-button>
    <el-tooltip
      :content="mailboxRegistrationState.reason"
      :disabled="mailboxRegistrationState.available"
      placement="bottom"
    >
      <span>
        <el-button
          size="small"
          type="primary"
          :disabled="!mailboxRegistrationState.available"
          @click="handleOpenRegisterDialog"
        >
          注册邮箱
        </el-button>
      </span>
    </el-tooltip>

    <!-- 添加账号弹窗 -->
    <el-dialog
      title="添加账号"
      v-model="showAddDialog"
      width="500px"
      :destroy-on-close="true"
      @closed="resetAddForm"
    >
      <BillingCreationStatus resource="account" @state-change="handleAddBillingState" />
      <el-form :model="addForm" label-width="100px">
        <el-form-item label="账号名称">
          <el-input v-model="addForm.apiName" placeholder="留空时默认使用邮箱地址" />
        </el-form-item>
        <el-form-item label="邮箱地址">
          <el-input v-model="addForm.email" placeholder="请输入邮箱地址" />
        </el-form-item>
        <el-form-item label="邮箱密码">
          <el-input
            v-model="addForm.mailPassword"
            type="password"
            show-password
            placeholder="邮箱密码或授权码"
          />
        </el-form-item>
        <el-form-item label="账号密码">
          <el-input
            v-model="addForm.bianPassword"
            type="password"
            show-password
            placeholder="账号密码（可选）"
          />
        </el-form-item>
        <el-form-item label="分组">
          <SelectEmailGroup v-model="addForm.groupId" />
        </el-form-item>
        <el-form-item label="谷歌验证密钥">
          <el-input v-model="addForm.googleAuth" placeholder="2FA密钥（可选，提交后将加密保存）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button
          type="primary"
          :loading="addLoading"
          :disabled="!addBillingAllowed"
          @click="handleAddEmail"
        >
          确定
        </el-button>
      </template>
    </el-dialog>

    <!-- 快速添加弹窗 -->
    <el-dialog
      title="快速添加账号"
      v-model="showFastAddDialog"
      width="560px"
      :destroy-on-close="true"
      @closed="resetFastAddForm"
    >
      <el-alert
        class="batch-billing-notice"
        type="info"
        :closable="false"
        show-icon
        title="额度和计费由服务端按净新增账号数核算，批内重复或已有账号不重复计数。"
      />
      <el-form :model="fastAddForm" label-width="100px">
        <el-form-item label="账号列表">
          <el-input
            v-model="fastAddForm.content"
            type="textarea"
            :rows="6"
            placeholder="每行一个：邮箱地址----邮箱密码----2FA 密钥----账号密码----账号名称\n后三项可留空，账号名称留空时默认使用邮箱地址"
          />
        </el-form-item>
        <el-form-item label="分组">
          <SelectEmailGroup v-model="fastAddForm.groupId" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showFastAddDialog = false">取消</el-button>
        <el-button
          type="primary"
          :loading="fastAddLoading"
          :disabled="fastAddLoading"
          @click="handleFastAddSubmit"
          >确定</el-button
        >
      </template>
    </el-dialog>

    <!-- 注册邮箱弹窗 -->
    <el-dialog title="注册邮箱" v-model="showRegisterDialog" width="500px" :destroy-on-close="true">
      <BillingCreationStatus
        resource="account"
        :quantity="registerQuantity"
        @state-change="handleRegisterBillingState"
      />
      <el-form :model="registerForm" label-width="100px">
        <el-form-item label="模式">
          <el-radio-group v-model="registerMode">
            <el-radio value="single">单独注册</el-radio>
            <el-radio value="batch">批量注册</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="registerMode === 'single'" label="邮箱前缀">
          <el-input v-model="registerForm.localPart" placeholder="请输入邮箱前缀">
            <template #append>{{ mailboxRegistrationState.suffix }}</template>
          </el-input>
        </el-form-item>
        <el-form-item v-if="registerMode === 'batch'" label="数量">
          <el-input-number
            v-model="registerForm.count"
            :min="1"
            :max="10"
            controls-position="right"
          />
          <span class="register-limit-tip">每次最多注册 10 个</span>
        </el-form-item>
        <el-form-item label="分组">
          <SelectEmailGroup v-model="registerForm.groupId" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showRegisterDialog = false">取消</el-button>
        <el-button
          type="primary"
          :loading="registerLoading"
          :disabled="!registerBillingAllowed"
          @click="handleRegister"
        >
          注册
        </el-button>
      </template>
    </el-dialog>

    <!-- 注册结果弹窗 -->
    <el-dialog title="邮箱注册结果" v-model="showResultDialog" width="600px">
      <p class="register-result-summary">
        已创建 {{ registerResults.length }} 个邮箱，其中 {{ savedRegisterCount }} 个已保存到账号列表
      </p>
      <el-alert
        v-if="unsavedRegisterCount > 0"
        class="register-result-alert"
        type="warning"
        :closable="false"
        show-icon
        title="部分邮箱未保存到账号列表"
        :description="`${unsavedRegisterCount} 个邮箱已在邮件服务器创建，请立即复制凭据并通过“添加账号”补录。`"
      />
      <el-table :data="registerResults" border size="small" max-height="400">
        <el-table-column prop="email" label="邮箱地址" />
        <el-table-column prop="password" label="邮箱密码" width="150" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.saved === false ? 'warning' : 'success'" effect="light">
              {{ row.saved === false ? '待手动添加' : '已保存' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column
          v-if="unsavedRegisterCount > 0"
          prop="message"
          :formatter="row => row.message ? getUserFacingErrorMessage(row.message) : ''"
          label="说明"
          min-width="210"
          show-overflow-tooltip
        />
      </el-table>
      <template #footer>
        <el-button :disabled="registerResults.length === 0" @click="handleCopyAll">
          复制全部
        </el-button>
        <el-button type="primary" @click="showResultDialog = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
  import { getUserFacingErrorMessage } from '@/utils/error.mjs';
  import { computed, onMounted, ref, reactive } from 'vue';
  import {
    searchEmails,
    addEmail,
    fastAddEmails,
    importEmails,
    createMailbox,
    getSystemConfig,
    getUserGroup,
  } from '@/api/email';
  import SelectEmailGroup from '@/components/SelectEmailGroup.vue';
  import BillingCreationStatus from '@/components/BillingCreationStatus.vue';
  import { useEmailStore } from '@/store/emailStore';
  import { useMessage } from '@/composables/useGlobalProperties';
  import { getCreationBillingFailure } from '@/utils/billing.mjs';
  import { getMailboxRegistrationState } from '@/utils/mailRegistration.mjs';
  import { getAccountBatchSizeError, parseFastAddAccountRows } from '@/utils/accountBatch.mjs';

  const emit = defineEmits(['searchData', 'pageChange', 'batchDelete']);
  const props = defineProps({
    initialGroupId: { type: Number, default: null },
  });
  const message = useMessage();
  const emailStore = useEmailStore();
  const mailboxRegistrationState = computed(() =>
    getMailboxRegistrationState(emailStore.systemConfig)
  );

  const showCreationError = (error, fallback, batch = false) => {
    const billingFailure = getCreationBillingFailure(error, { batch });
    if (billingFailure) {
      message[billingFailure.type](billingFailure.message);
      return;
    }
    if (!error?.isNotified) message.error(error?.message || fallback);
  };

  const searchText = ref('');
  const selectGroup = ref('');
  const groupOptions = ref([]);
  const searchLoading = ref(false);
  let searchSequence = 0;

  const handleGroupChange = value => {
    selectGroup.value = value;
  };

  // 加载分组和系统配置
  onMounted(async () => {
    try {
      const groupData = await getUserGroup();
      groupOptions.value = (groupData || []).map(item => ({
        value: item.id,
        label: item.name,
      }));
    } catch (err) {
      message.error('加载分组失败');
    }

    // 从路由 query 预设分组筛选
    if (props.initialGroupId) {
      selectGroup.value = props.initialGroupId;
    }

    try {
      const config = await getSystemConfig();
      if (config) {
        emailStore.setSystemConfig(config);
      }
    } catch (err) {
      // 静默处理
    }

    handleSearch();
  });

  // pageSize / current 与旧接口保持一致
  const handleSearch = async (event = null, pageData = { page: 1, size: 20 }) => {
    const sequence = ++searchSequence;
    emit('pageChange', pageData);
    const payload = {
      groupId: selectGroup.value === '' ? 0 : selectGroup.value,
      apiName: searchText.value,
      pageSize: pageData.size,
      current: pageData.page,
    };
    searchLoading.value = true;
    try {
      const response = await searchEmails(payload);
      if (sequence === searchSequence) emit('searchData', response);
    } catch (error) {
      if (sequence === searchSequence && !error?.isNotified) message.error('搜索失败');
    } finally {
      if (sequence === searchSequence) searchLoading.value = false;
    }
  };

  defineExpose({ handleSearch });

  // 添加邮箱
  const showAddDialog = ref(false);
  const addForm = reactive({
    apiName: '',
    email: '',
    mailPassword: '',
    bianPassword: '',
    groupId: '',
    googleAuth: '',
  });
  const addLoading = ref(false);
  const addBillingAllowed = ref(false);

  const getGoogleAuthPreparationOptions = () => ({
    isGoAuthCloud: emailStore.systemConfig.isGoAuthCloud,
    cloudRecoveryVersion: emailStore.systemConfig.cloudRecoveryVersion,
    cloudRecoveryCapabilityKnown: emailStore.systemConfigLoaded,
  });

  const commitLocalGoogleAuthSecrets = async entries => {
    const validEntries = entries.filter(item => item?.secret && (item.email || item.uuid));
    if (validEntries.length === 0) return;
    const results = await Promise.allSettled(
      validEntries.map(item => window.ipcRenderer.commitLocalAuthSecret(item))
    );
    if (results.some(result => result.status === 'rejected')) {
      message.warning('账号已保存到服务端，但部分本地 Google Auth 缓存写入失败');
    }
  };

  const handleAddBillingState = state => {
    addBillingAllowed.value = state?.allowed === true;
  };

  const resetAddForm = () => {
    Object.assign(addForm, {
      apiName: '',
      email: '',
      mailPassword: '',
      bianPassword: '',
      groupId: '',
      googleAuth: '',
    });
  };

  const handleAddEmail = async () => {
    if (addLoading.value) return;
    if (!addBillingAllowed.value) {
      message.warning('当前无法确认免费额度或超额计费未启用');
      return;
    }
    const email = addForm.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      message.warning('请输入有效的邮箱地址');
      return;
    }
    if (!addForm.mailPassword) {
      message.warning('请输入邮箱密码或授权码');
      return;
    }
    addLoading.value = true;
    try {
      const rawGoogleAuth = addForm.googleAuth.trim();
      // 先在主进程做 RSA 加密处理
      const prepared = await window.ipcRenderer.prepareEmailForImport(
        { ...addForm, apiName: addForm.apiName.trim() || email, email },
        getGoogleAuthPreparationOptions()
      );
      await addEmail(prepared);
      await commitLocalGoogleAuthSecrets([{ email, secret: rawGoogleAuth }]);
      message.success('账号添加成功');
      showAddDialog.value = false;
      resetAddForm();
      handleSearch();
    } catch (err) {
      showCreationError(err, '账号添加失败');
    } finally {
      addLoading.value = false;
    }
  };

  // 快速添加
  const showFastAddDialog = ref(false);
  const fastAddForm = reactive({ content: '', groupId: '' });
  const fastAddLoading = ref(false);

  const resetFastAddForm = () => {
    fastAddForm.content = '';
    fastAddForm.groupId = '';
  };

  const handleFastAdd = () => {
    showFastAddDialog.value = true;
  };

  const handleFastAddSubmit = async () => {
    if (fastAddLoading.value) return;

    if (!fastAddForm.content.trim()) {
      message.warning('请输入账号列表');
      return;
    }

    const { rows: parsedRows, invalidRows } = parseFastAddAccountRows(fastAddForm.content);

    if (invalidRows.length > 0) {
      const preview = invalidRows.slice(0, 3).join('；');
      const remaining = invalidRows.length > 3 ? `；另有 ${invalidRows.length - 3} 行有误` : '';
      message.warning(`${preview}${remaining}`);
      return;
    }

    const sizeError = getAccountBatchSizeError(parsedRows);
    if (sizeError) {
      message.warning(sizeError);
      return;
    }

    fastAddLoading.value = true;
    try {
      const emails = [];
      for (const emailData of parsedRows) {
        const prepared = await window.ipcRenderer.prepareEmailForImport(
          emailData,
          getGoogleAuthPreparationOptions()
        );
        emails.push(prepared);
      }

      const result = await fastAddEmails({
        emailList: emails,
        groupId: fastAddForm.groupId || 0,
      });
      const addedCount = Array.isArray(result?.insertCount)
        ? result.insertCount.length
        : emails.length;

      const rawByEmail = new Map(
        parsedRows.map(item => [
          String(item.email || '')
            .trim()
            .toLowerCase(),
          item.googleAuth || '',
        ])
      );
      const successfulItems = Array.isArray(result?.insertCount) ? result.insertCount : [];
      await commitLocalGoogleAuthSecrets(
        successfulItems.map(item => {
          const email = String(item?.email || item?.Email || '').trim();
          return {
            uuid: item?.uuid || item?.Uuid,
            email,
            secret: rawByEmail.get(email.toLowerCase()) || '',
          };
        })
      );

      if (addedCount === 0) {
        message.warning('未添加新账号，请检查邮箱地址是否已存在');
      } else {
        message.success(`成功添加 ${addedCount} 个账号`);
        if (addedCount < emails.length) {
          message.warning(`${emails.length - addedCount} 条数据重复或未能添加`);
        }
      }

      showFastAddDialog.value = false;
      resetFastAddForm();
      handleSearch();
    } catch (err) {
      showCreationError(err, '快速添加失败', true);
    } finally {
      fastAddLoading.value = false;
    }
  };

  // 导入 Excel
  const handleImportExcel = async () => {
    try {
      const rows = await window.ipcRenderer.parseExcelImportFile();
      if (!rows || rows.length === 0) {
        message.warning('未解析到数据');
        return;
      }
      const sizeError = getAccountBatchSizeError(rows);
      if (sizeError) {
        message.warning(sizeError);
        return;
      }
      const prepared = [];
      for (const row of rows) {
        const item = await window.ipcRenderer.prepareEmailForImport(
          row,
          getGoogleAuthPreparationOptions()
        );
        prepared.push(item);
      }
      const result = await importEmails(prepared);
      const insertedCount = Array.isArray(result?.insertCount) ? result.insertCount.length : 0;
      const updatedCount = Array.isArray(result?.updateCount) ? result.updateCount.length : 0;
      const failedRows = Array.isArray(result?.failedRows) ? result.failedRows : [];
      const successCount = insertedCount + updatedCount;
      const rawByEmail = new Map(
        rows.map(item => [
          String(item.email || '')
            .trim()
            .toLowerCase(),
          item.googleAuth || '',
        ])
      );
      await commitLocalGoogleAuthSecrets(
        [...(result?.insertCount || []), ...(result?.updateCount || [])].map(item => {
          const email = String(item?.email || '').trim();
          return {
            uuid: item?.uuid,
            email,
            secret: rawByEmail.get(email.toLowerCase()) || '',
          };
        })
      );

      if (successCount > 0) {
        message.success(`导入完成：新增 ${insertedCount} 条，更新 ${updatedCount} 条`);
        handleSearch();
      }

      if (failedRows.length > 0) {
        const preview = failedRows
          .slice(0, 2)
          .map(item => `第 ${item.row} 行${item.email ? `（${item.email}）` : ''}：${item.reason}`)
          .join('；');
        const detail =
          failedRows.length > 2 ? `${preview}；另有 ${failedRows.length - 2} 条失败` : preview;
        const notify = successCount > 0 ? message.warning : message.error;
        notify(`${failedRows.length} 条数据未能导入${detail ? `：${detail}` : ''}`);
      } else if (successCount === 0) {
        message.warning('没有可导入的数据');
      }
    } catch (err) {
      if (err?.message !== '用户取消') showCreationError(err, '导入失败', true);
    }
  };

  // 导出模板
  const handleExportTemplate = async () => {
    try {
      const result = await window.ipcRenderer.exportImportTemplate();
      if (result.success) {
        message.success('模板下载成功');
      } else if (result.message !== '用户取消') {
        message.error(result.message || '模板下载失败');
      }
    } catch (err) {
      message.error(err?.message || '模板下载失败');
    }
  };

  // 注册邮箱
  const showRegisterDialog = ref(false);
  const registerMode = ref('single');
  const registerForm = reactive({ localPart: '', count: 10, groupId: '' });
  const registerLoading = ref(false);
  const registerBillingAllowed = ref(false);
  const registerQuantity = computed(() =>
    registerMode.value === 'batch' ? Number(registerForm.count) || 1 : 1
  );
  const handleRegisterBillingState = state => {
    registerBillingAllowed.value = state?.allowed === true;
  };
  const showResultDialog = ref(false);
  const registerResults = ref([]);
  const unsavedRegisterCount = computed(
    () => registerResults.value.filter(item => item.saved === false).length
  );
  const savedRegisterCount = computed(
    () => registerResults.value.length - unsavedRegisterCount.value
  );

  const handleOpenRegisterDialog = () => {
    if (!mailboxRegistrationState.value.available) {
      message.warning(mailboxRegistrationState.value.reason);
      return;
    }
    showRegisterDialog.value = true;
  };

  const handleRegister = async () => {
    if (!mailboxRegistrationState.value.available) {
      message.warning(mailboxRegistrationState.value.reason);
      return;
    }
    if (!registerBillingAllowed.value) {
      message.warning('当前无法确认免费额度或超额计费未启用');
      return;
    }
    if (registerMode.value === 'single' && !registerForm.localPart) {
      message.warning('请输入邮箱前缀');
      return;
    }
    if (
      registerMode.value === 'batch' &&
      (!Number.isInteger(Number(registerForm.count)) ||
        Number(registerForm.count) < 1 ||
        Number(registerForm.count) > 10)
    ) {
      message.warning('批量注册数量必须是 1 到 10 的整数');
      return;
    }
    registerLoading.value = true;
    try {
      const payload = {};
      if (registerMode.value === 'single') {
        payload.localPart = registerForm.localPart;
      } else {
        payload.count = registerForm.count;
      }
      payload.groupId = registerForm.groupId || 0;

      const data = await createMailbox(payload);
      registerResults.value = Array.isArray(data) ? data : [];
      showRegisterDialog.value = false;
      showResultDialog.value = true;
      // 重置表单
      registerForm.localPart = '';
      registerForm.count = 10;
      registerForm.groupId = '';
      if (savedRegisterCount.value > 0) {
        handleSearch();
      }
      if (unsavedRegisterCount.value > 0) {
        message.warning('部分邮箱未保存到账号列表，请先复制注册结果');
      }
    } catch (err) {
      showCreationError(err, '注册邮箱失败', registerMode.value === 'batch');
    } finally {
      registerLoading.value = false;
    }
  };

  const handleCopyAll = () => {
    const text = registerResults.value.map(item => `${item.email}----${item.password}`).join('\n');
    navigator.clipboard
      .writeText(text)
      .then(() => {
        message.success('已复制到剪贴板');
      })
      .catch(() => {
        message.error('复制失败');
      });
  };
</script>

<style scoped>
  .search-pane {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }

  .register-result-summary {
    margin: 0 0 12px;
    color: var(--app-text-primary);
  }

  .register-result-alert {
    margin-bottom: 12px;
  }

  .register-limit-tip {
    margin-left: 10px;
    color: var(--app-text-secondary);
    font-size: 12px;
  }

  .batch-billing-notice {
    margin-bottom: 16px;
  }
</style>
