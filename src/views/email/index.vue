<template>
  <Main>
    <MainTablePane>
      <template #search>
        <SearchPane
          @searchData="handleSearchData"
          @pageChange="handlePageChange"
          @batchDelete="onBatchDelete"
          :initialGroupId="initialGroupId"
          ref="searchPaneRef"
        />
      </template>
      <TablePane
        ref="tablePaneRef"
        :searchData="searchData"
        @refreshData="handleRefreshData"
        @showEmailDetail="handleShowEmailDetail"
      />
      <template #page>
        <PagePane
          :total="total"
          :page="currentPage"
          :page-size="pageSize"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </template>
    </MainTablePane>
    <EmailDetailDialog
      v-model="showDetailDialog"
      :email="detailEmail"
      :mailPassword="detailMailPassword"
    />
  </Main>
</template>

<script setup>
  import { getUserFacingErrorMessage } from '@/utils/error.mjs';
  import MainTablePane from '@/components/MainTablePane.vue';
  import TablePane from './tablePane.vue';
  import SearchPane from './searchPane.vue';
  import EmailDetailDialog from './emailDetailDialog.vue';
  import Main from '@/views/home/Main.vue';
  import PagePane from '@/components/pagePane.vue';
  import { ref, onMounted, onUnmounted, watch } from 'vue';
  import { useRoute } from 'vue-router';
  import { useEmailStore } from '@/store/emailStore';
  import { searchEmails } from '@/api/email';

  const route = useRoute();
  const emailStore = useEmailStore();

  // 从路由 query 获取初始分组 ID（从分组页面详情跳转）
  const initialGroupId = route.query.group_id ? Number(route.query.group_id) : null;

  const total = ref(0);
  const currentPage = ref(1);
  const pageSize = ref(20);
  const searchData = ref([]);
  const searchPaneRef = ref(null);
  const tablePaneRef = ref(null);
  let localAuthFlagSequence = 0;

  const mergeLocalAuthFlags = async rows => {
    const sequence = ++localAuthFlagSequence;
    try {
      const localAuthEmails = await window.ipcRenderer.listAllAuthEmails();
      if (sequence !== localAuthFlagSequence || searchData.value !== rows) return;
      const localEmailSet = new Set(Array.isArray(localAuthEmails) ? localAuthEmails : []);
      searchData.value = rows.map(row => ({
        ...row,
        hasGoogleAuth: Boolean(row.hasGoogleAuth || localEmailSet.has(row.email)),
      }));
    } catch {
      // 本地密钥状态读取失败不影响账号列表展示。
    }
  };

  const handleSearchData = data => {
    total.value = data.count || 0;
    if ((data.apikeyList || []).length === 0 && total.value > 0 && currentPage.value > 1) {
      currentPage.value -= 1;
      searchPaneRef.value?.handleSearch(null, {
        page: currentPage.value,
        size: pageSize.value,
      });
      return;
    }
    const rows = data.apikeyList || [];
    searchData.value = rows;
    void mergeLocalAuthFlags(searchData.value);
  };

  const handlePageChange = pageData => {
    currentPage.value = pageData.page;
    pageSize.value = pageData.size;
  };

  const handleRefreshData = () => {
    searchPaneRef.value?.handleSearch(null, {
      page: currentPage.value,
      size: pageSize.value,
    });
  };

  const onBatchDelete = () => {
    if (tablePaneRef.value?.deleteSelected) {
      tablePaneRef.value.deleteSelected();
    }
  };

  const handleSizeChange = pageData => {
    searchPaneRef.value?.handleSearch(null, pageData);
  };

  const handleCurrentChange = pageData => {
    searchPaneRef.value?.handleSearch(null, pageData);
  };

  // 邮件详情弹窗
  const showDetailDialog = ref(false);
  const detailEmail = ref('');
  const detailMailPassword = ref('');

  const handleShowEmailDetail = row => {
    detailEmail.value = row.email || '';
    detailMailPassword.value = row.mailPassword || '';
    showDetailDialog.value = true;
  };

  watch(showDetailDialog, visible => {
    if (visible) return;
    detailEmail.value = '';
    detailMailPassword.value = '';
  });

  // 监听邮件读取事件
  let cleanupProgress = null;
  let cleanupComplete = null;
  let cleanupError = null;

  onMounted(() => {
    cleanupProgress = window.ipcRenderer.onEmailFetchProgress(data => {
      emailStore.setFetchProgress(data.email, data);
    });
    cleanupComplete = window.ipcRenderer.onEmailFetchComplete(data => {
      emailStore.clearFetchProgress(data.email);
    });
    cleanupError = window.ipcRenderer.onEmailFetchError(data => {
      emailStore.setFetchProgress(data.email, { status: 'error', message: getUserFacingErrorMessage(data, '邮件读取失败，请重试') });
    });
  });

  onUnmounted(() => {
    localAuthFlagSequence += 1;
    cleanupProgress?.();
    cleanupComplete?.();
    cleanupError?.();
    detailEmail.value = '';
    detailMailPassword.value = '';
  });
</script>
