<template>
  <RouterView />
</template>

<script setup>
  import { RouterView } from 'vue-router';
  import { onMounted, ref } from 'vue';
  import { ElMessageBox } from 'element-plus';
import { ElMessage } from '@/utils/message';
  import { useIpcListener } from '@/composables/useIpcListener';
  import { initGlobalDownloadListeners } from '@/composables/useDownloadListeners';

  // 初始化全局下载监听器
  onMounted(() => {
    initGlobalDownloadListeners();
  });

  const updatePromptOpen = ref(false);

  useIpcListener('update-downloaded', async () => {
    if (updatePromptOpen.value) return;
    updatePromptOpen.value = true;
    try {
      await ElMessageBox.confirm('新版本已下载完成，现在重启并安装吗？', '更新已就绪', {
        confirmButtonText: '重启安装',
        cancelButtonText: '稍后再说',
        type: 'success',
      });
      await window.ipcRenderer.installUpdate();
    } catch (error) {
      if (error !== 'cancel' && error !== 'close') {
        ElMessage.error(error, '安装更新失败，请稍后重试');
      }
    } finally {
      updatePromptOpen.value = false;
    }
  });

  // 后台更新检查失败保留在主进程日志和设置页状态中，避免打断当前操作。
  // 用户主动安装失败由上面的安装入口提示。
</script>
