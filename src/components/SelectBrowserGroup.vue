<template>
  <el-select
    size="small"
    v-model="selectGroup"
    filterable
    remote
    reserve-keyword
    placeholder="输入选择分组"
    :remote-method="searchGroupRemoteMethod"
    :loading="searchGroupLoading"
    @change="handleChange"
  >
    <template #header>
      <div style="display: flex; justify-content: space-between; align-items: center; width: 100%">
        <el-text size="small" :type="canCreateGroup ? 'primary' : 'info'">
          {{ canCreateGroup ? searchGroupText : '' }}
        </el-text>
        <el-button :disabled="!canCreateGroup" size="small" @click="createGroupClick">
          创建
        </el-button>
      </div>
    </template>
    <el-option
      v-for="item in groupOptions"
      :key="item.value"
      :label="item.label"
      :value="item.value"
    />
  </el-select>
</template>

<script setup>
  import { ref, computed, onMounted } from 'vue';
  import { createGroup, searchGroup } from '@/api/group';

  const props = defineProps({
    modelValue: {
      type: [String, Number],
      default: undefined,
    },
    groupId: {
      type: [String, Number],
      default: undefined,
    },
  });
  const emit = defineEmits(['update:modelValue', 'change']);

  const selectGroup = computed({
    get: () => props.modelValue ?? props.groupId ?? '',
    set: value => emit('update:modelValue', value),
  });
  // 用户输入的搜索分组
  const searchGroupText = ref('');
  // 搜索到的分组列表
  const ungroupedOption = { value: 0, label: '未分组' };
  const groupOptions = ref([ungroupedOption]);
  // 搜索分组加载状态
  const searchGroupLoading = ref(false);
  // 用户输入不为空与搜索到的分组列表为空时，允许创建分组
  const canCreateGroup = computed(() => {
    return (
      searchGroupText.value != '' &&
      groupOptions.value.map(item => item.label).indexOf(searchGroupText.value) === -1
    );
  });
  onMounted(() => {
    searchGroupRemoteMethod('');
  });
  // 搜索分组函数
  const searchGroupRemoteMethod = queryString => {
    searchGroupText.value = queryString;
    searchGroupLoading.value = true;
    return searchGroup({ name: queryString })
      .then(data => {
        const options = (data || []).map(item => ({
          value: item.id,
          label: item.name,
        }));
        groupOptions.value = [
          ungroupedOption,
          ...options.filter(item => Number(item.value) !== ungroupedOption.value),
        ];
      })
      .catch(() => {
        groupOptions.value = [ungroupedOption];
      })
      .finally(() => {
        searchGroupLoading.value = false;
      });
  };

  const createGroupClick = async () => {
    const name = searchGroupText.value.trim();
    if (!name || !canCreateGroup.value) return;
    searchGroupLoading.value = true;
    try {
      const data = await createGroup({ name });
      await searchGroupRemoteMethod(name);
      selectGroup.value = data.id;
      emit('change', data.id);
    } finally {
      searchGroupLoading.value = false;
    }
  };

  const handleChange = val => {
    emit('change', val);
  };
</script>
