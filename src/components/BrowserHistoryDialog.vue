<template>
  <el-dialog title="浏览历史" v-model="visible" width="700px" :destroy-on-close="true">
    <div class="history-toolbar">
      <el-input
        v-model="searchQuery"
        placeholder="搜索标题或 URL"
        size="small"
        clearable
        :disabled="clearing"
        @input="scheduleSearch"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
    </div>

    <el-table
      v-loading="loading"
      :data="historyList"
      :empty-text="emptyText"
      size="small"
      max-height="400"
      border
    >
      <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
      <el-table-column prop="url" label="URL" min-width="250" show-overflow-tooltip />
      <el-table-column prop="visitCount" label="访问次数" width="80" />
      <el-table-column label="最后访问" width="160">
        <template #default="scope">
          {{ formatTime(scope.row.lastVisitTime) }}
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <el-button
        size="small"
        type="danger"
        :loading="clearing"
        :disabled="loading || !hasHistory"
        @click="clearHistory"
      >
        清除全部历史
      </el-button>
      <el-button size="small" :disabled="clearing" @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
  import { computed, onBeforeUnmount, ref, watch } from 'vue';
  import { Search } from '@element-plus/icons-vue';
  import { ElMessageBox } from 'element-plus';
import { ElMessage } from '@/utils/message';

  const props = defineProps({
    modelValue: { type: Boolean, default: false },
    instanceId: { type: [String, Number], default: '' },
  });
  const emit = defineEmits(['update:modelValue']);

  const visible = ref(false);
  const searchQuery = ref('');
  const historyList = ref([]);
  const hasHistory = ref(false);
  const loading = ref(false);
  const clearing = ref(false);

  let searchTimer = null;
  let latestRequestId = 0;

  const emptyText = computed(() => {
    if (loading.value) return '正在加载...';
    return searchQuery.value.trim() ? '没有匹配的历史记录' : '暂无浏览历史';
  });

  const getErrorMessage = error => {
    if (typeof error === 'string') return error;
    return error?.message || '未知错误';
  };

  const getHistoryApi = method => {
    const api = window.ipcRenderer?.[method];
    if (typeof api !== 'function') {
      throw new Error('当前环境不支持浏览历史管理');
    }
    if (!props.instanceId) {
      throw new Error('缺少浏览器窗口标识');
    }
    return api;
  };

  const runHistoryQuery = async query => {
    const requestId = ++latestRequestId;
    loading.value = true;

    try {
      const result = query
        ? await getHistoryApi('searchBrowserHistory')(
            props.instanceId,
            query,
            200
          )
        : await getHistoryApi('getBrowserHistory')(props.instanceId, 200);

      if (requestId === latestRequestId) {
        historyList.value = Array.isArray(result) ? result : [];
        if (!query) hasHistory.value = historyList.value.length > 0;
      }
    } catch (error) {
      if (requestId === latestRequestId) {
        historyList.value = [];
        if (!query) hasHistory.value = false;
        ElMessage.error(`加载浏览历史失败：${getErrorMessage(error)}`);
      }
    } finally {
      if (requestId === latestRequestId) {
        loading.value = false;
      }
    }
  };

  const loadHistory = () => runHistoryQuery('');

  const scheduleSearch = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      runHistoryQuery(searchQuery.value.trim());
    }, 250);
  };

  const isConfirmCancel = error => {
    const action = error?.action || error;
    return action === 'cancel' || action === 'close';
  };

  const clearHistory = async () => {
    if (clearing.value || !hasHistory.value) return;

    try {
      await ElMessageBox.confirm(
        '确定清除当前窗口的全部浏览历史吗？此操作不可恢复。',
        '清除全部历史？',
        {
          confirmButtonText: '确定清除',
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

    clearing.value = true;
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    latestRequestId += 1;
    loading.value = false;

    try {
      const result = await getHistoryApi('clearBrowserHistory')(props.instanceId);
      if (result?.success === false) {
        throw new Error(result.message || '主进程未能清除历史记录');
      }
      historyList.value = [];
      hasHistory.value = false;
      searchQuery.value = '';
      ElMessage.success('浏览历史已清除');
    } catch (error) {
      ElMessage.error(`清除浏览历史失败：${getErrorMessage(error)}`);
    } finally {
      clearing.value = false;
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
        searchQuery.value = '';
        loadHistory();
      }
    },
    { immediate: true }
  );

  watch(visible, value => {
    emit('update:modelValue', value);
    if (!value) {
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      latestRequestId += 1;
      loading.value = false;
    }
  });

  onBeforeUnmount(() => {
    if (searchTimer) clearTimeout(searchTimer);
    latestRequestId += 1;
  });
</script>

<style scoped>
  .history-toolbar {
    margin-bottom: 12px;
  }
</style>
