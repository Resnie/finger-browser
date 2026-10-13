<template>
  <!-- 批量操作按钮已移至搜索栏（searchPane.vue） -->
  <el-table
    ref="browserTableRef"
    class="browser-table"
    size="small"
    :data="props.searchData"
    empty-text="暂无浏览器窗口，可从上方创建"
    @selection-change="handleSelectionChange"
    @cell-dblclick="cellDblclickHandle"
  >
    <el-table-column type="selection" :selectable="selectable" width="40" />
    <el-table-column type="index" width="50" label="序号" />
    <el-table-column size="small" prop="group" label="分组" width="80">
      <template #default="scope">
        <el-button size="small" type="primary" link @click="showSelectGroupClick(scope.row)">{{
          scope.row.group || '未分组'
        }}</el-button>
      </template>
    </el-table-column>
    <el-table-column size="small" prop="config.base.name" label="名称" min-width="110">
      <template #default="scope">
        <el-tooltip :content="getBrowserAccountTooltip(scope.row)" placement="top">
          <span class="browser-name">{{ scope.row.config?.base?.name || '未命名窗口' }}</span>
        </el-tooltip>
      </template>
    </el-table-column>
    <el-table-column label="状态" width="132">
      <template #default="scope">
        <span class="status-badge" :class="`is-${scope.row.runtimeActive ? 'started' : getBrowserState(scope.row.browser_id)}`">
          <span class="status-badge__dot"></span>
          {{ getBrowserState(scope.row.browser_id) !== 'closed' ? '运行中' : scope.row.runtimeActive ? (scope.row.runtimeDevice === 'darwin' ? 'Mac 运行中' : scope.row.runtimeDevice === 'win32' ? 'Windows 运行中' : '另一端运行中') : scope.row.runtimeLocked ? '待原设备关闭' : '已关闭' }}
        </span>
      </template>
    </el-table-column>
    <el-table-column size="small" label="代理IP" min-width="80" show-overflow-tooltip>
      <template #default="scope">
        {{ scope.row.config?.proxy?.enabled ? scope.row.config.proxy.host || '待获取' : '未设置' }}
      </template>
    </el-table-column>
    <el-table-column size="small" prop="created_at" label="创建时间" width="135">
      <template #default="scope">
        {{ formatDate(scope.row.created_at) }}
      </template>
    </el-table-column>
    <el-table-column size="small" prop="updated_at" label="最后活动时间" width="135">
      <template #default="scope">
        {{ formatDate(scope.row.updated_at) }}
      </template>
    </el-table-column>
    <el-table-column
      size="small"
      prop="config.base.remark"
      label="备注"
      min-width="120"
      show-overflow-tooltip
    ></el-table-column>
    <el-table-column size="small" label="操作" width="300" fixed="right">
      <template #default="scope">
        <div class="action-buttons">
          <template v-if="isInstanceDownloading(scope.row.browser_id, scope.row)">
            <div class="download-status">
              <el-progress
                size="small"
                style="flex: 1; min-width: 80px"
                :text-inside="true"
                :stroke-width="18"
                :percentage="getInstanceProgress(scope.row.browser_id, scope.row)"
                :format="p => `${p}%`"
              />
              <span
                v-if="getInstanceSpeed(scope.row.browser_id, scope.row)"
                class="download-speed"
                >{{ formatSpeed(getInstanceSpeed(scope.row.browser_id, scope.row)) }}</span
              >
              <el-button
                type="warning"
                size="small"
                @click="cancelInstanceDownload(scope.row.browser_id, scope.row)"
                >取消</el-button
              >
            </div>
          </template>
          <template v-else-if="getBrowserState(scope.row.browser_id) === 'closed'">
            <el-button
              size="small"
              type="primary"
              :loading="getOperation(scope.row.browser_id) === 'opening'"
              :disabled="isOperating(scope.row.browser_id)"
              @click="restoreInstance(scope.row)"
            >
              打开
            </el-button>
          </template>
          <template v-else>
            <el-button
              size="small"
              :loading="getOperation(scope.row.browser_id) === 'restarting'"
              :disabled="isOperating(scope.row.browser_id)"
              @click="restartInstance(scope.row)"
              >重开</el-button
            >
          </template>
          <el-button
            size="small"
            :disabled="isOperating(scope.row.browser_id)"
            @click="editInstance(scope.row)"
            >编辑</el-button
          >
          <el-button
            size="small"
            :disabled="isOperating(scope.row.browser_id)"
            @click="cloneInstance(scope.row)"
            >克隆</el-button
          >
          <el-dropdown @command="command => handleMoreCommand(command, scope.row)">
            <el-button size="small">
              <el-icon v-if="hasRunningCodeAction(scope.row)" class="code-action-spinner">
                <Loading />
              </el-icon>
              更多
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="history">浏览历史</el-dropdown-item>
                <el-dropdown-item command="credentials">密码管理</el-dropdown-item>
                <el-dropdown-item
                  command="email-code"
                  :disabled="
                    !hasUsableLinkedAccount(scope.row) || isCodeActionRunning(scope.row, 'email')
                  "
                  divided
                >
                  {{ getCodeActionLabel(scope.row, 'email', '读取邮箱验证码') }}
                </el-dropdown-item>
                <el-dropdown-item
                  command="google-code"
                  :disabled="
                    !hasUsableLinkedAccount(scope.row) || isCodeActionRunning(scope.row, 'google')
                  "
                >
                  {{ getCodeActionLabel(scope.row, 'google', '获取谷歌验证码') }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button
            size="small"
            type="danger"
            :loading="getOperation(scope.row.browser_id) === 'deleting'"
            :disabled="isOperating(scope.row.browser_id)"
            @click="removeInstance(scope.row)"
          >
            删除
          </el-button>
        </div>
      </template>
    </el-table-column>
  </el-table>
  <el-dialog
    title="选择分组"
    v-model="showSelectGroupDialog"
    :close-on-click-modal="!groupUpdating"
    :close-on-press-escape="!groupUpdating"
    :destroy-on-close="true"
    width="420px"
    @closed="resetGroupTarget"
  >
    <div v-loading="groupUpdating">
      <SelectBrowserGroupPane @confirmGroup="confirmGroupHandle" />
    </div>
  </el-dialog>
  <el-dialog
    :title="dialogTitle"
    v-model="showCreateDialog"
    width="min(880px, calc(100vw - 48px))"
    :before-close="handleClose"
    :destroy-on-close="true"
  >
    <CreateAndEditPane
      :mode="createMode"
      :initialData="editInitialData"
      @resetForm="handleResetForm"
      @refreshData="() => emit('refreshData')"
    />
  </el-dialog>
  <BrowserHistoryDialog v-model="historyDialogVisible" :instance-id="detailInstanceId" />
  <CredentialManagerDialog v-model="credentialDialogVisible" :instance-id="detailInstanceId" />
  <BrowserCodeDialog
    v-model="codeDialogVisible"
    :result="codeResult"
    :refreshing="googleCodeRefreshing"
    @refresh="refreshGoogleCode"
    @closed="handleCodeDialogClosed"
  />
</template>

<script setup>
  import { computed, reactive, ref, toRaw } from 'vue';
  import { Loading } from '@element-plus/icons-vue';
  import { updateBrowserGroup } from '@/api/browser';
  import { getCloudGoogleAuthCode, getEmailDetail, getSystemConfig } from '@/api/email';
  import { useUserStore } from '@/store';
  import { useEmailStore } from '@/store/emailStore';
  import { useMessage, useConfirm } from '@/composables/useGlobalProperties';
  import { getEmailServerConfig } from '@/constants/email';
  import { formatDate } from '@/utils/date';
  import { formatSpeed } from '@/utils/format';
  import { getBrowserAccountTooltip, hasUsableLinkedAccount } from '@/utils/browserAccount.mjs';
  import { ElMessageBox } from 'element-plus';
  import BrowserCodeDialog from '@/components/BrowserCodeDialog.vue';
  import BrowserHistoryDialog from '@/components/BrowserHistoryDialog.vue';
  import CredentialManagerDialog from '@/components/CredentialManagerDialog.vue';

  const userStore = useUserStore();
  const emailStore = useEmailStore();

  // 使用 composable 获取消息提示与确认弹窗
  const message = useMessage();
  const { confirm } = useConfirm();

  // 接收并处理表格数据
  const props = defineProps({
    searchData: {
      type: Array,
      default: () => [],
    },
  });

  const operationStates = reactive({});
  const historyDialogVisible = ref(false);
  const credentialDialogVisible = ref(false);
  const detailInstanceId = ref('');
  const runningCodeActions = reactive(new Set());
  const codeDialogVisible = ref(false);
  const codeResult = ref(null);
  const googleCodeRefreshing = ref(false);
  let latestCodeRequest = 0;
  const getOperation = id => operationStates[id] || '';
  const isOperating = id => Boolean(getOperation(id));
  const setOperation = (id, operation = '') => {
    if (operation) operationStates[id] = operation;
    else delete operationStates[id];
  };

  const codeActionKey = (row, action) => `${row.browser_id}:${action}`;
  const isCodeActionRunning = (row, action) => runningCodeActions.has(codeActionKey(row, action));
  const hasRunningCodeAction = row =>
    isCodeActionRunning(row, 'email') || isCodeActionRunning(row, 'google');
  const getCodeActionLabel = (row, action, label) => {
    if (!hasUsableLinkedAccount(row)) {
      return `${label}（${row.email_uuid ? '账号不可用' : '未关联'}）`;
    }
    return isCodeActionRunning(row, action) ? `${label}中…` : label;
  };

  const handleMoreCommand = async (command, row) => {
    if (command === 'history' || command === 'credentials') {
      detailInstanceId.value = row.browser_id;
    }
    if (command === 'history') historyDialogVisible.value = true;
    if (command === 'credentials') credentialDialogVisible.value = true;
    if (command === 'email-code') await handleEmailCode(row);
    if (command === 'google-code') await handleGoogleCode(row);
  };

  const fetchLinkedAccountDetail = async row => {
    if (!hasUsableLinkedAccount(row)) {
      throw new Error('该浏览器未关联可用账号');
    }

    const detail = await getEmailDetail({ uuid: row.email_uuid });
    if (!detail || typeof detail !== 'object') throw new Error('账号详情为空');

    const email = typeof detail.email === 'string' ? detail.email.trim() : '';
    if (!email) throw new Error('关联账号没有可用邮箱地址');

    return {
      email,
      mailPassword: typeof detail.mailPassword === 'string' ? detail.mailPassword : '',
      accountName:
        typeof detail.apiName === 'string' && detail.apiName.trim()
          ? detail.apiName.trim()
          : row.account_name || '未命名账号',
    };
  };

  const syncLatestEmail = async detail => {
    if (!detail.mailPassword) {
      return { success: false, reason: '该账号未保存邮箱密码' };
    }

    let systemConfig;
    try {
      systemConfig = await getSystemConfig();
      emailStore.setSystemConfig(systemConfig || {});
    } catch {
      return { success: false, reason: '无法读取邮件同步配置' };
    }

    const syncType = emailStore.systemConfig.emailSyncType === 'pop3' ? 'pop3' : 'imap';
    const serverConfig = getEmailServerConfig(detail.email, syncType);
    if (!serverConfig) {
      return { success: false, reason: '无法识别该邮箱的服务器配置' };
    }

    const fetchData = {
      email: detail.email,
      password: detail.mailPassword,
      host: serverConfig.host,
      port: serverConfig.port,
      tls: serverConfig.tls,
      verifyCertificate: serverConfig.verifyCertificate,
    };

    try {
      const result =
        syncType === 'pop3'
          ? await window.ipcRenderer.fetchEmailsViaPop3(fetchData)
          : await window.ipcRenderer.fetchEmailsViaImap(fetchData);
      if (result?.success !== true) {
        return { success: false, reason: '邮箱实时同步失败' };
      }
      return { success: true, syncType };
    } catch {
      return { success: false, reason: '邮箱无法连接或认证失败' };
    }
  };

  const confirmCachedLookup = async reason => {
    try {
      await ElMessageBox.confirm(
        `${reason}，不能保证获取到最新邮件。是否仅查看最近 30 分钟的本地缓存？`,
        '实时同步未成功',
        {
          confirmButtonText: '仅查看缓存',
          cancelButtonText: '取消',
          type: 'warning',
        }
      );
      return true;
    } catch {
      return false;
    }
  };

  const handleEmailCode = async row => {
    const key = codeActionKey(row, 'email');
    if (runningCodeActions.has(key)) return;
    if (!hasUsableLinkedAccount(row)) {
      message.info('请先编辑浏览器并关联账号');
      return;
    }

    const requestId = ++latestCodeRequest;
    runningCodeActions.add(key);
    try {
      let detail;
      try {
        detail = await fetchLinkedAccountDetail(row);
      } catch (error) {
        if (requestId === latestCodeRequest && !error?.isNotified) {
          message.error(error?.message || '读取账号详情失败');
        }
        return;
      }
      if (requestId !== latestCodeRequest) return;

      const syncResult = await syncLatestEmail(detail);
      if (requestId !== latestCodeRequest) return;
      const cacheOnly = !syncResult.success;
      if (cacheOnly && !(await confirmCachedLookup(syncResult.reason))) return;
      if (requestId !== latestCodeRequest) return;

      let result;
      try {
        result = await window.ipcRenderer.extractVerificationCode({
          email: detail.email,
          maxAgeMs: 30 * 60 * 1000,
        });
      } catch {
        if (requestId === latestCodeRequest) {
          message.error('验证码提取失败，请稍后重试');
        }
        return;
      }
      if (requestId !== latestCodeRequest) return;

      if (!result?.success || !result.code) {
        message.warning(
          cacheOnly ? '最近 30 分钟的本地缓存中未找到验证码' : '已同步最新邮件，但未找到验证码'
        );
        return;
      }

      codeResult.value = {
        type: 'email',
        code: String(result.code),
        accountName: detail.accountName,
        email: detail.email,
        emailTime: result.emailTime || null,
        subject: result.subject || '',
        cacheOnly,
        source: cacheOnly
          ? '最近 30 分钟本地缓存'
          : `已实时同步（${syncResult.syncType === 'pop3' ? 'POP3' : 'IMAP'}）`,
      };
      codeDialogVisible.value = true;
    } finally {
      runningCodeActions.delete(key);
    }
  };

  const resolveGoogleAuthCode = async row => {
    if (!emailStore.systemConfigLoaded) {
      try {
        const systemConfig = await getSystemConfig();
        emailStore.setSystemConfig(systemConfig || {});
      } catch {
        return {
          success: false,
          message: '无法确认服务端 Google Auth 恢复能力，请刷新后重试',
        };
      }
    }

    if (emailStore.systemConfig.cloudRecoveryVersion >= 1) {
      if (!row.email_uuid) {
        return { success: false, message: '账号缺少 UUID，无法从云端生成验证码' };
      }
      try {
        const cloudResult = await getCloudGoogleAuthCode({ uuid: row.email_uuid });
        const code = String(cloudResult?.code || '');
        if (!/^\d{6}$/.test(code)) {
          return { success: false, message: '云端未返回有效验证码' };
        }
        return {
          success: true,
          code,
          source: '云端加密密钥',
        };
      } catch (error) {
        return { success: false, message: error?.message || '云端验证码生成失败' };
      }
    }

    try {
      const localResult = await window.ipcRenderer.getGoogleAuthCode({
        uuid: row.email_uuid,
        email: row.account_email,
      });
      return localResult?.success ? { ...localResult, source: '本机系统加密缓存' } : localResult;
    } catch (error) {
      return { success: false, message: error?.message || '本地验证码生成失败' };
    }
  };

  const handleGoogleCode = async row => {
    const key = codeActionKey(row, 'google');
    if (runningCodeActions.has(key)) return;
    if (!hasUsableLinkedAccount(row)) {
      message.info('请先编辑浏览器并关联账号');
      return;
    }

    const requestId = ++latestCodeRequest;
    runningCodeActions.add(key);
    try {
      const result = await resolveGoogleAuthCode(row);
      if (requestId !== latestCodeRequest) return;

      if (!result?.success || !result.code) {
        message.warning(result?.message || '谷歌验证密钥不可用，请前往账号管理重新录入');
        return;
      }

      codeResult.value = {
        type: 'google',
        code: String(result.code),
        accountName: row.account_name || '未命名账号',
        email: row.account_email,
        uuid: row.email_uuid,
        generatedAt: new Date().toISOString(),
        cacheOnly: false,
        source: result.source,
      };
      codeDialogVisible.value = true;
    } finally {
      runningCodeActions.delete(key);
    }
  };

  const refreshGoogleCode = async () => {
    const current = codeResult.value;
    if (
      googleCodeRefreshing.value ||
      !codeDialogVisible.value ||
      current?.type !== 'google' ||
      !current.email
    ) {
      return;
    }

    const targetEmail = current.email;
    googleCodeRefreshing.value = true;
    try {
      const result = await resolveGoogleAuthCode({
        email_uuid: current.uuid,
        account_email: targetEmail,
      });
      if (
        !codeDialogVisible.value ||
        codeResult.value?.type !== 'google' ||
        codeResult.value?.email !== targetEmail
      ) {
        return;
      }
      if (!result?.success || !result.code) {
        message.warning(result?.message || '谷歌验证码刷新失败');
        return;
      }
      codeResult.value = {
        ...codeResult.value,
        code: String(result.code),
        generatedAt: new Date().toISOString(),
        source: result.source,
      };
    } catch {
      if (codeDialogVisible.value) message.warning('谷歌验证码刷新失败，请稍后重试');
    } finally {
      googleCodeRefreshing.value = false;
    }
  };

  const handleCodeDialogClosed = () => {
    codeResult.value = null;
    googleCodeRefreshing.value = false;
  };

  const openInstance = async rowData => {
    await window.ipcRenderer.restoreInstance({
      id: rowData.browser_id,
      config: rowData.config,
      cloudRecoveryVersion: emailStore.systemConfig.cloudRecoveryVersion,
    });
  };

  /**
   * 恢复窗口操作（支持并发下载）
   * @param row 表格行数据
   */
  const restoreInstance = async row => {
    const rowData = toRaw(row);
    if (isOperating(rowData.browser_id)) return;
    setOperation(rowData.browser_id, 'opening');
    try {
      await openInstance(rowData);
    } catch (error) {
      message.error(error, '打开窗口失败，请稍后重试');
      // 清理下载状态（失败）
      const version = rowData.config?.base?.browserVersion;
      if (version) userStore.clearVersionDownload(version);
    } finally {
      setOperation(rowData.browser_id);
    }
  };

  const restartInstance = async row => {
    const rowData = toRaw(row);
    if (isOperating(rowData.browser_id)) return;
    setOperation(rowData.browser_id, 'restarting');
    try {
      await window.ipcRenderer.removeInstance(rowData.browser_id);
      await openInstance(rowData);
    } catch (error) {
      message.error(error, '重开窗口失败，请稍后重试');
    } finally {
      setOperation(rowData.browser_id);
    }
  };

  // 工具：按 browser_id 获取下载状态（两级查找：先查映射，再查行数据的 browserVersion）
  const getDownloadState = (id, row) => {
    // 1. 通过 browserIdToVersion 映射查
    const byId = userStore.getDownloadByBrowserId(id);
    if (byId) return byId;
    // 2. 通过行数据中的 browserVersion 查
    const version = row?.config?.base?.browserVersion;
    if (version && userStore.versionDownloads[version]) {
      return userStore.versionDownloads[version];
    }
    return null;
  };
  const isInstanceDownloading = (id, row) => {
    const dl = getDownloadState(id, row);
    return dl && dl.isDownloading;
  };
  const getInstanceProgress = (id, row) => {
    const dl = getDownloadState(id, row);
    return (dl && dl.progress) || 0;
  };
  const getInstanceSpeed = (id, row) => {
    const dl = getDownloadState(id, row);
    return (dl && dl.speed) || 0;
  };
  const getInstanceVersion = (id, row) => {
    const v = userStore.getVersionByBrowserId(id);
    if (v) return v;
    return row?.config?.base?.browserVersion || '';
  };
  const cancelInstanceDownload = async (id, row) => {
    const version = getInstanceVersion(id, row);
    if (!version) return;
    try {
      await ElMessageBox.confirm(
        `确定要取消下载浏览器内核版本 ${version} 吗？这会影响所有等待该版本的浏览器实例。`,
        '取消下载',
        {
          confirmButtonText: '确定',
          cancelButtonText: '继续下载',
          type: 'warning',
        }
      );
      await window.ipcRenderer.cancelBrowserDownload(version);
      userStore.clearVersionDownload(version);
      message.info(`版本 ${version} 下载已取消`);
    } catch {
      // 用户点击"继续下载"，不做处理
    }
  };
  /**
   * 删除窗口操作，并抛出刷新事件更新表格数据
   * @param instanceId 窗口ID
   */
  const emit = defineEmits(['refreshData']);
  const removeInstance = async row => {
    const instanceId = row.browser_id;
    if (isOperating(instanceId)) return;
    try {
      await confirm(`删除窗口「${row.config?.base?.name || instanceId}」？`, '确认删除', {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      });
      setOperation(instanceId, 'deleting');
      if (getBrowserState(instanceId) !== 'closed') {
        await window.ipcRenderer.removeInstance(instanceId);
      }
      await window.ipcRenderer.deleteBrowserAndCleanup(instanceId);
      message.success('窗口已删除');
      emit('refreshData');
    } catch (error) {
      if (error !== 'cancel' && error !== 'close' && !error?.isNotified) {
        message.error(`删除窗口失败：${error.message || '未知错误'}`);
      }
    } finally {
      setOperation(instanceId);
    }
  };

  import SelectBrowserGroupPane from '@/components/SelectBrowserGroupPane.vue';
  const showSelectGroupDialog = ref(false);
  const groupTargetIds = ref([]);
  const groupUpdating = ref(false);
  // 点击分组按钮
  const showSelectGroupClick = row => {
    groupTargetIds.value = [row.browser_id];
    showSelectGroupDialog.value = true;
  };

  const resetGroupTarget = () => {
    if (!groupUpdating.value) groupTargetIds.value = [];
  };

  const confirmGroupHandle = async group => {
    const ids = [...groupTargetIds.value];
    if (ids.length === 0) {
      message.info('未选择任何窗口');
      return;
    }
    if (group === '' || group === null || group === undefined) {
      message.info('请先选择目标分组');
      return;
    }

    groupUpdating.value = true;
    try {
      await Promise.all(ids.map(id => updateBrowserGroup({ id, group_id: group })));
      groupTargetIds.value = [];
      showSelectGroupDialog.value = false;
      browserTableRef.value?.clearSelection();
      message.success(ids.length > 1 ? `已更新 ${ids.length} 个窗口的分组` : '分组已更新');
      emit('refreshData');
    } catch (error) {
      if (!error?.isNotified) message.error(`分组更新失败：${error.message || '未知错误'}`);
    } finally {
      groupUpdating.value = false;
    }
  };

  // 编辑窗口
  const handleResetForm = () => {
    handleClose();
  };

  import CreateAndEditPane from './createAndEditPane.vue';

  const showCreateDialog = ref(false);
  // 编辑模式与初始数据
  const createMode = ref('create');
  const editInitialData = ref(null);
  const dialogTitle = computed(() => {
    if (createMode.value === 'clone') return '克隆窗口';
    if (createMode.value === 'edit') return '编辑窗口';
    return '创建窗口';
  });
  const handleClose = () => {
    showCreateDialog.value = false;
  };
  // 编辑窗口：打开弹窗并注入初始数据
  const editInstance = row => {
    createMode.value = 'edit';
    // 传入原始对象以便子组件读取 browser_id 与 config
    editInitialData.value = toRaw(row);
    showCreateDialog.value = true;
  };

  const cloneInstance = row => {
    createMode.value = 'clone';
    editInitialData.value = toRaw(row);
    showCreateDialog.value = true;
  };

  const multipleSelection = ref([]);
  const browserTableRef = ref(null);
  const handleSelectionChange = val => {
    multipleSelection.value = val;
  };

  // 行选择控制：下载中的行不可选择
  const selectable = row => {
    return !isInstanceDownloading(row.browser_id, row) && !isOperating(row.browser_id);
  };

  const editInstances = () => {
    if (multipleSelection.value.length == 0) {
      message.info('请选择至少一个窗口进行编辑');
      return;
    }
    groupTargetIds.value = multipleSelection.value.map(item => item.browser_id);
    showSelectGroupDialog.value = true;
  };
  const deleteInstances = () => {
    if (multipleSelection.value.length == 0) {
      message.info('请选择至少一个窗口进行删除');
      return;
    }
    confirm('确定要删除选中的窗口吗?', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
      .then(async () => {
        const ids = multipleSelection.value.map(i => i.browser_id);
        try {
          ids.forEach(id => setOperation(id, 'deleting'));
          await Promise.all(
            ids.map(async id => {
              if (getBrowserState(id) !== 'closed') {
                await window.ipcRenderer.removeInstance(id);
              }
              await window.ipcRenderer.deleteBrowserAndCleanup(id);
            })
          );
          message.success('选中窗口已删除');
          multipleSelection.value = [];
          emit('refreshData');
        } catch (err) {
          if (!err?.isNotified) message.error(`批量删除失败：${err.message || '未知错误'}`);
        } finally {
          ids.forEach(id => setOperation(id));
        }
      })
      .catch(() => {});
  };
  const cellDblclickHandle = (row, column) => {
    // 双击行时，打开编辑窗口
    if (column.label === '备注') {
      editInstance(row);
    }
  };

  //
  // 工具：按 browser_id 获取下载状态
  const getBrowserState = id => {
    return userStore.browserInstances[id] || 'closed';
  };

  // 对外暴露批量操作方法，供父组件调用
  defineExpose({
    editInstances,
    deleteInstances,
  });
</script>

<style scoped>
  .browser-table {
    width: 100%;
    margin-top: 16px;
  }

  .action-buttons {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 4px;
  }

  .action-buttons :deep(.el-button + .el-button) {
    margin-left: 0;
  }

  .browser-name {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: help;
  }

  .code-action-spinner {
    margin-right: 4px;
    animation: rotating 1.5s linear infinite;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #16a34a;
    font-size: 12px;
    white-space: nowrap;
  }

  .status-badge.is-closed {
    color: #667085;
  }

  .status-badge__dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);
  }

  .download-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .download-speed {
    font-size: 12px;
    color: #909399;
    white-space: nowrap;
  }
</style>
