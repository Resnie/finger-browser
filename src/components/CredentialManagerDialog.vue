<template>
  <el-dialog title="密码管理" v-model="visible" width="650px" :destroy-on-close="true">
    <el-table
      v-loading="loading"
      :data="credentialList"
      :empty-text="loading ? '正在加载...' : '暂无已保存的密码'"
      size="small"
      max-height="400"
      border
    >
      <el-table-column prop="domain" label="域名" min-width="180" show-overflow-tooltip />
      <el-table-column prop="username" label="用户名" min-width="150" show-overflow-tooltip />
      <el-table-column label="最后使用" width="160">
        <template #default="scope">
          {{ formatTime(scope.row.lastUsedTime) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="scope">
          <el-button
            size="small"
            type="danger"
            link
            :loading="deletingKey === getCredentialKey(scope.row)"
            :disabled="Boolean(deletingKey) && deletingKey !== getCredentialKey(scope.row)"
            @click="deleteCredential(scope.row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <el-button size="small" :disabled="Boolean(deletingKey)" @click="visible = false">
        关闭
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
  import { ref, watch } from 'vue';
  import { ElMessageBox } from 'element-plus';
import { ElMessage } from '@/utils/message';

  const props = defineProps({
    modelValue: { type: Boolean, default: false },
    instanceId: { type: [String, Number], default: '' },
  });
  const emit = defineEmits(['update:modelValue']);

  const visible = ref(false);
  const credentialList = ref([]);
  const loading = ref(false);
  const deletingKey = ref('');

  let latestRequestId = 0;

  const getErrorMessage = error => {
    if (typeof error === 'string') return error;
    return error?.message || '未知错误';
  };

  const getCredentialApi = method => {
    const api = window.ipcRenderer?.[method];
    if (typeof api !== 'function') {
      throw new Error('当前环境不支持密码管理');
    }
    if (!props.instanceId) {
      throw new Error('缺少浏览器窗口标识');
    }
    return api;
  };

  const loadCredentials = async () => {
    const requestId = ++latestRequestId;
    loading.value = true;

    try {
      const result = await getCredentialApi('getSavedCredentials')(props.instanceId);
      if (requestId === latestRequestId) {
        credentialList.value = Array.isArray(result) ? result : [];
      }
    } catch (error) {
      if (requestId === latestRequestId) {
        credentialList.value = [];
        ElMessage.error(`加载密码列表失败：${getErrorMessage(error)}`);
      }
    } finally {
      if (requestId === latestRequestId) {
        loading.value = false;
      }
    }
  };

  const getCredentialKey = row => `${row.domain || ''}\u0000${row.username || ''}`;

  const isConfirmCancel = error => {
    const action = error?.action || error;
    return action === 'cancel' || action === 'close';
  };

  const deleteCredential = async row => {
    if (deletingKey.value) return;

    const domain = row.domain || '未知域名';
    const username = row.username || '未知用户';

    try {
      await ElMessageBox.confirm(
        `确定删除「${domain}」下用户「${username}」的已保存密码吗？此操作不可恢复。`,
        '删除已保存的密码？',
        {
          confirmButtonText: '确定删除',
          cancelButtonText: '取消',
          type: 'warning',
          confirmButtonClass: 'el-button--danger',
        }
      );
    } catch (error) {
      if (!isConfirmCancel(error)) {
        ElMessage.error(`无法打开确认对话框：${getErrorMessage(error)}`);
      }
      return;
    }

    const key = getCredentialKey(row);
    deletingKey.value = key;

    try {
      const result = await getCredentialApi('deleteCredential')(
        props.instanceId,
        row.domain,
        row.username
      );
      if (result?.success === false) {
        throw new Error(result.message || '浏览器窗口未运行，无法删除该密码');
      }
      credentialList.value = credentialList.value.filter(item => getCredentialKey(item) !== key);
      ElMessage.success('已删除保存的密码');
    } catch (error) {
      ElMessage.error(`删除密码失败：${getErrorMessage(error)}`);
    } finally {
      deletingKey.value = '';
    }
  };

  const formatTime = timestamp => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN');
  };

  watch(
    [() => props.modelValue, () => props.instanceId],
    ([isVisible, instanceId], [wasVisible, previousInstanceId] = []) => {
      visible.value = isVisible;
      if (isVisible && instanceId && (!wasVisible || instanceId !== previousInstanceId)) {
        loadCredentials();
      }
    },
    { immediate: true }
  );

  watch(visible, value => {
    emit('update:modelValue', value);
    if (!value) {
      latestRequestId += 1;
      loading.value = false;
    }
  });
</script>
