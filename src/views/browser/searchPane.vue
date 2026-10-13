<template>
  <div class="search-pane">
    <el-input
      size="small"
      style="width: 200px"
      v-model="searchText"
      placeholder="窗口名称"
      clearable
      @keyup.enter="handleSearch"
    ></el-input>
    <el-select
      size="small"
      style="margin-left: 10px; width: 250px"
      v-model="selectGroup"
      filterable
      multiple
      collapse-tags
      collapse-tags-tooltip
      placeholder="选择分组"
      @change="handleChange"
    >
      <el-option
        v-for="item in groupOptions"
        :key="item.value"
        :label="item.label"
        :value="item.value"
      />
    </el-select>
    <el-button size="small" :loading="searchLoading" @click="handleSearch">搜索</el-button>
    <el-button size="small" type="primary" @click="showCreatePane"> 创建新窗口 </el-button>
    <el-button size="small" @click="onBatchEdit">批量分组</el-button>
    <el-button size="small" type="danger" plain @click="onBatchDelete">批量删除</el-button>
    <el-dialog
      title="创建新窗口"
      v-model="showCreateDialog"
      width="min(880px, calc(100vw - 48px))"
      :destroy-on-close="true"
    >
      <CreateAndEditPane @resetForm="handleResetForm" @refreshData="handleSearch" />
    </el-dialog>
  </div>
</template>
<script setup>
  import { onMounted, ref } from 'vue';
  import CreateAndEditPane from './createAndEditPane.vue';
  import { searchBrowserInstanceList } from '@/api/browser';
  import { searchGroup } from '@/api/group';
  import { useRoute } from 'vue-router';
  import { PAGINATION } from '@/constants';
  import { useMessage } from '@/composables/useGlobalProperties';

  const emit = defineEmits(['searchData', 'pageChange', 'batchEdit', 'batchDelete']);
  const message = useMessage();

  const searchText = ref('');
  const selectGroup = ref(null);
  const groupOptions = ref([]);
  const handleChange = value => (selectGroup.value = value);

  const route = useRoute();
  const searchLoading = ref(false);
  let searchSequence = 0;

  onMounted(async () => {
    try {
      const data = await searchGroup();
      groupOptions.value = (data || []).map(item => ({
        value: item.id,
        label: item.name,
      }));
      const groupId = Number(route.query.group_id);
      if (Number.isInteger(groupId) && groupId > 0) {
        selectGroup.value = [groupId];
      }
    } catch (error) {
      message.error('加载分组失败，仍可按名称搜索');
    } finally {
      handleSearch();
    }
  });

  const handleSearch = async (
    event = null,
    pageData = {
      page: PAGINATION.DEFAULT_PAGE,
      size: PAGINATION.DEFAULT_SIZE,
    }
  ) => {
    const sequence = ++searchSequence;
    emit('pageChange', pageData);
    const payload = {
      name: searchText.value,
      group_id: selectGroup.value,
      page: pageData.page,
      size: pageData.size,
      includeRecovery: false,
    };
    searchLoading.value = true;
    try {
      const response = await searchBrowserInstanceList(payload);
      if (sequence === searchSequence) emit('searchData', response);
    } catch (error) {
      if (!error?.isNotified) message.error('搜索失败');
    } finally {
      if (sequence === searchSequence) searchLoading.value = false;
    }
  };

  const showCreateDialog = ref(false);

  const handleClose = () => (showCreateDialog.value = false);

  const handleResetForm = () => {
    handleClose();
  };
  defineExpose({
    handleSearch,
  });

  const showCreatePane = () => {
    showCreateDialog.value = true;
  };

  const onBatchEdit = () => {
    emit('batchEdit');
  };

  const onBatchDelete = () => {
    emit('batchDelete');
  };
</script>

<style scoped>
  .search-pane {
    display: flex;
    align-items: center;
  }
</style>
