<template>
  <el-select
    size="small"
    v-model="selectGroup"
    filterable
    remote
    reserve-keyword
    clearable
    placeholder="输入选择分组"
    :remote-method="handleFilter"
    :loading="loading"
    @change="handleChange"
    @visible-change="handleVisibleChange"
  >
    <template #header>
      <div style="display: flex; justify-content: space-between; align-items: center; width: 100%">
        <el-text size="small" :type="canCreateGroup ? 'primary' : 'info'">
          {{ canCreateGroup ? searchText : '' }}
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
  import { ref, computed, onMounted, watch } from 'vue';
  import { getUserGroup, createEmailGroup } from '@/api/email';

  const props = defineProps({
    modelValue: {
      type: [String, Number],
      default: '',
    },
  });

  const emit = defineEmits(['update:modelValue', 'change']);

  const selectGroup = ref('');
  const searchText = ref('');
  const allGroups = ref([]);
  const groupOptions = ref([]);
  const loading = ref(false);

  const canCreateGroup = computed(() => {
    return (
      searchText.value !== '' &&
      allGroups.value.every(item => item.label !== searchText.value)
    );
  });

  const loadGroups = async () => {
    loading.value = true;
    try {
      const data = await getUserGroup();
      allGroups.value = (data || []).map(item => ({
        value: item.id,
        label: item.name,
      }));
      groupOptions.value = [...allGroups.value];
    } catch (err) {
      allGroups.value = [];
      groupOptions.value = [];
    } finally {
      loading.value = false;
    }
  };

  const handleFilter = query => {
    searchText.value = query;
    if (!query) {
      groupOptions.value = [...allGroups.value];
    } else {
      groupOptions.value = allGroups.value.filter(item =>
        item.label.toLowerCase().includes(query.toLowerCase())
      );
    }
  };

  const handleVisibleChange = visible => {
    if (visible) {
      loadGroups();
    }
  };

  const createGroupClick = async () => {
    try {
      const data = await createEmailGroup({ name: searchText.value });
      await loadGroups();
      selectGroup.value = data.id;
      searchText.value = '';
      emit('update:modelValue', data.id);
      emit('change', data.id);
    } catch (err) {
      // ignore
    }
  };

  const handleChange = val => {
    emit('update:modelValue', val);
    emit('change', val);
  };

  watch(
    () => props.modelValue,
    val => {
      selectGroup.value = val;
    },
    { immediate: true }
  );

  onMounted(() => {
    loadGroups();
  });
</script>
