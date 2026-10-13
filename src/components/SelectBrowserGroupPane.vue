<template>
  <SelectBrowserGroup style="width: 300px" v-model="selectGroup" @change="changeHandle" />
  <el-button size="small" style="margin-left: 10px" @click="confirmGroupClick">确定</el-button>
</template>

<script setup>
  import { ref } from 'vue';
  import SelectBrowserGroup from '@/components/SelectBrowserGroup.vue';
  const selectGroup = ref('');
  // 定义 emits
  const emit = defineEmits(['confirmGroup']);
  const changeHandle = val => {
    selectGroup.value = val;
  };
  const confirmGroupClick = () => {
    emit('confirmGroup', selectGroup.value);
  };
</script>
