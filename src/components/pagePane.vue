<template>
  <div class="page-pane">
    <el-pagination
      v-model:current-page="localPage"
      v-model:page-size="localPageSize"
      :page-sizes="props.pageSizes"
      :layout="props.layout"
      :total="props.total"
      :disabled="props.disabled"
      :hide-on-single-page="props.hideOnSinglePage"
      size="small"
      background
      @size-change="handleSizeChange"
      @current-change="handleCurrentChange"
    />
  </div>
</template>

<script setup>
  import { ref, watch } from 'vue';

  const props = defineProps({
    total: {
      type: Number,
      default: 0,
    },
    page: {
      type: Number,
      default: 1,
    },
    pageSize: {
      type: Number,
      default: 20,
    },
    pageSizes: {
      type: Array,
      default: () => [10, 20, 30, 40],
    },
    layout: {
      type: String,
      default: 'total, sizes, prev, pager, next, jumper',
    },
    disabled: {
      type: Boolean,
      default: false,
    },
    hideOnSinglePage: {
      type: Boolean,
      default: false,
    },
  });

  const emit = defineEmits(['update:page', 'update:pageSize', 'size-change', 'current-change']);

  const normalizePage = value => Math.max(1, Number(value) || 1);
  const normalizePageSize = value => Math.max(1, Number(value) || 20);

  const localPage = ref(normalizePage(props.page));
  const localPageSize = ref(normalizePageSize(props.pageSize));

  watch(
    () => props.page,
    value => {
      localPage.value = normalizePage(value);
    }
  );

  watch(
    () => props.pageSize,
    value => {
      localPageSize.value = normalizePageSize(value);
    }
  );

  const handleSizeChange = value => {
    localPageSize.value = value;
    localPage.value = 1;
    emit('update:pageSize', value);
    emit('update:page', 1);
    emit('size-change', {
      page: 1,
      size: value,
    });
  };

  const handleCurrentChange = value => {
    localPage.value = value;
    emit('update:page', value);
    emit('current-change', {
      page: value,
      size: localPageSize.value,
    });
  };
</script>

<style scoped>
  .page-pane {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    width: 100%;
    min-width: max-content;
  }

  @media (max-width: 1100px) {
    .page-pane :deep(.el-pagination__jump) {
      display: none;
    }
  }
</style>
