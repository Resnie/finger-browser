<template>
  <el-select
    :model-value="modelValue"
    filterable
    clearable
    :loading="loading"
    :placeholder="loading ? '正在读取账号…' : '搜索并选择关联账号'"
    style="width: 100%"
    @update:model-value="value => emit('update:modelValue', value || '')"
    @visible-change="visible => visible && loadAccounts()"
  >
    <el-option
      v-for="account in displayOptions"
      :key="account.uuid"
      :label="account.label"
      :value="account.uuid"
    >
      <div class="account-option">
        <span class="account-option__name">{{ account.name }}</span>
        <span v-if="account.email" class="account-option__email" :title="account.email">
          {{ account.email }}
        </span>
      </div>
    </el-option>
  </el-select>
</template>

<script setup>
  import { computed, onMounted, ref } from 'vue';
  import { ElMessage } from '@/utils/message';
  import { searchEmails } from '@/api/email';
  import { mergeAccountOptions, normalizeAccountSearchResponse } from '@/utils/browserAccount.mjs';

  const props = defineProps({
    modelValue: { type: String, default: '' },
    initialAccount: { type: Object, default: null },
  });
  const emit = defineEmits(['update:modelValue']);

  const options = ref([]);
  const loading = ref(false);
  const loaded = ref(false);
  const displayOptions = computed(() => mergeAccountOptions(options.value, props.initialAccount));

  const loadAccounts = async () => {
    if (loaded.value || loading.value) return;
    loading.value = true;
    try {
      const response = await searchEmails({
        groupId: 0,
        apiName: '',
        current: 1,
        pageSize: 200,
      });
      options.value = normalizeAccountSearchResponse(response);
      loaded.value = true;
    } catch (error) {
      if (!error?.isNotified) ElMessage.error('账号列表读取失败，请稍后重试');
    } finally {
      loading.value = false;
    }
  };

  onMounted(loadAccounts);
</script>

<style scoped>
  .account-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    gap: 16px;
  }

  .account-option__name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .account-option__email {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
