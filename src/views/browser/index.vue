<template>
  <Main>
    <MainTablePane>
      <template #search>
        <SearchPane
          @searchData="handleSearchData"
          @pageChange="handlePageChange"
          @batchEdit="onBatchEdit"
          @batchDelete="onBatchDelete"
          ref="searchPaneRef"
        />
      </template>
      <TablePane ref="tablePaneRef" :searchData="searchData" @refreshData="handleRefreshData" />
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
  </Main>
</template>

<script setup>
  import MainTablePane from '@/components/MainTablePane.vue';
  import TablePane from './tablePane.vue';
  import SearchPane from './searchPane.vue';
  import Main from '@/views/home/Main.vue';
  import { ref } from 'vue';
  import { useIpcListener } from '@/composables/useIpcListener';
  import { parseBrowserTableData } from '@/utils/json';

  import PagePane from '@/components/pagePane.vue';

  const total = ref(0);
  const currentPage = ref(1);
  const pageSize = ref(20);
  const searchData = ref([]);
  const handleSearchData = data => {
    total.value = data.total || 0;
    if ((data.list || []).length === 0 && total.value > 0 && currentPage.value > 1) {
      currentPage.value -= 1;
      searchPaneRef.value?.handleSearch(null, {
        page: currentPage.value,
        size: pageSize.value,
      });
      return;
    }
    searchData.value = parseBrowserTableData(data.list);
  };
  const handlePageChange = pageData => {
    currentPage.value = pageData.page;
    pageSize.value = pageData.size;
  };

  // 调用搜索组件内部的搜索
  const searchPaneRef = ref(null);
  const tablePaneRef = ref(null);
  const handleRefreshData = () => {
    searchPaneRef.value?.handleSearch(null, {
      page: currentPage.value,
      size: pageSize.value,
    });
  };

  // 监听主进程推送的状态变更，仅同步本地表格数据（后端持久化由主进程直接完成）
  useIpcListener('save-browser-state', data => {
    const row = searchData.value.find(r => r.browser_id === data.id);
    if (row) {
      row.config = data.config;
    }
  });

  const onBatchEdit = () => {
    if (tablePaneRef.value && tablePaneRef.value.editInstances) {
      tablePaneRef.value.editInstances();
    }
  };

  const onBatchDelete = () => {
    if (tablePaneRef.value && tablePaneRef.value.deleteInstances) {
      tablePaneRef.value.deleteInstances();
    }
  };

  const handleSizeChange = pageData => {
    searchPaneRef.value?.handleSearch(null, pageData);
  };
  const handleCurrentChange = pageData => {
    searchPaneRef.value?.handleSearch(null, pageData);
  };
</script>
