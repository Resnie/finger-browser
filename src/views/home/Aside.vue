<template>
  <div class="sidebar">
    <div class="sidebar__brand" title="指纹浏览器">
      <span class="sidebar__logo" aria-hidden="true">
        <span>F</span>
      </span>
      <span class="sidebar__brand-copy">
        <strong>指纹浏览器</strong>
        <small>Finger Browser</small>
      </span>
    </div>

    <div class="sidebar__section-label">工作台</div>

    <el-menu
      class="sidebar__menu"
      router
      :default-active="activeIndex"
      background-color="transparent"
      text-color="#98a2b3"
      active-text-color="#ffffff"
    >
      <el-menu-item index="/" title="浏览器">
        <el-icon><Monitor /></el-icon>
        <span class="sidebar__nav-label">浏览器</span>
      </el-menu-item>
      <el-menu-item index="/group" title="分组">
        <el-icon><FolderOpened /></el-icon>
        <span class="sidebar__nav-label">分组</span>
      </el-menu-item>
      <el-menu-item index="/browser-kernel" title="内核">
        <el-icon><Cpu /></el-icon>
        <span class="sidebar__nav-label">内核</span>
      </el-menu-item>
      <el-menu-item index="/email" title="账号">
        <el-icon><Message /></el-icon>
        <span class="sidebar__nav-label">账号</span>
      </el-menu-item>
      <el-menu-item index="/billing" title="余额与账单">
        <el-icon><Wallet /></el-icon>
        <span class="sidebar__nav-label">余额与账单</span>
      </el-menu-item>
      <el-menu-item index="/setting" title="设置">
        <el-icon><Setting /></el-icon>
        <span class="sidebar__nav-label">设置</span>
      </el-menu-item>
    </el-menu>

    <div class="sidebar__bottom">
      <el-button
        class="sidebar__logout"
        text
        title="退出登录"
        aria-label="退出登录"
        :loading="logoutLoading"
        :disabled="logoutLoading"
        @click="logout"
      >
        <el-icon><SwitchButton /></el-icon>
        <span class="sidebar__logout-label">退出登录</span>
      </el-button>
    </div>
  </div>
</template>

<script lang="ts" setup>
  import { computed, ref } from 'vue';
  import {
    Cpu,
    FolderOpened,
    Message,
    Monitor,
    Setting,
    SwitchButton,
    Wallet,
  } from '@element-plus/icons-vue';
  import { useRoute, useRouter } from 'vue-router';
  import { useUserStore } from '@/store';
  import { logout as logoutSession } from '@/api/user';
  import { ElMessage } from '@/utils/message';

  const route = useRoute();
  const router = useRouter();
  const userStore = useUserStore();
  const logoutLoading = ref(false);

  const activeIndex = computed(() => route.path);

  const logout = async () => {
    if (logoutLoading.value) return;
    logoutLoading.value = true;
    try {
      await window.ipcRenderer.prepareBrowserSessionLogout();
    } catch {
      ElMessage.error('浏览器数据尚未安全收口，已取消退出登录');
      logoutLoading.value = false;
      return;
    }
    try {
      await logoutSession();
    } catch {
      // 主进程已安全收口，服务端退出超时不阻止清除本地 token。
    }
    try {
      userStore.logout();
      await router.replace('/login');
    } finally {
      logoutLoading.value = false;
    }
  };
</script>

<style scoped>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 14px 10px 12px;
    color: #ffffff;
  }

  .sidebar__brand {
    display: flex;
    flex: 0 0 52px;
    align-items: center;
    min-width: 0;
    padding: 0 8px;
  }

  .sidebar__logo {
    display: inline-flex;
    flex: 0 0 36px;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    color: #ffffff;
    font-size: 21px;
    border: 1px solid rgb(255 255 255 / 16%);
    border-radius: 11px;
    background: linear-gradient(145deg, #3b82f6, #1d4ed8);
    box-shadow: 0 8px 20px rgb(37 99 235 / 30%);
  }

  .sidebar__brand-copy {
    display: flex;
    min-width: 0;
    margin-left: 10px;
    flex-direction: column;
    line-height: 1.2;
    white-space: nowrap;
  }

  .sidebar__brand-copy strong {
    overflow: hidden;
    font-size: 15px;
    font-weight: 650;
    letter-spacing: 0.02em;
    text-overflow: ellipsis;
  }

  .sidebar__brand-copy small {
    margin-top: 4px;
    color: #98a2b3;
    font-size: 10px;
    letter-spacing: 0.04em;
  }

  .sidebar__section-label {
    flex: none;
    margin: 18px 12px 7px;
    color: #667085;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
  }

  .sidebar__menu {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    border-right: 0;
  }

  .sidebar__menu :deep(.el-menu-item) {
    height: 44px;
    margin: 4px 0;
    padding: 0 14px !important;
    line-height: 44px;
    border-radius: 9px;
  }

  .sidebar__menu :deep(.el-menu-item:hover) {
    color: #ffffff;
    background: var(--app-sidebar-hover);
  }

  .sidebar__menu :deep(.el-menu-item.is-active) {
    color: #ffffff;
    background: linear-gradient(90deg, rgb(37 99 235 / 95%), rgb(59 130 246 / 82%));
    box-shadow: 0 6px 16px rgb(37 99 235 / 20%);
  }

  .sidebar__menu :deep(.el-icon) {
    flex: 0 0 auto;
    width: 20px;
    margin-right: 10px;
    font-size: 18px;
  }

  .sidebar__nav-label {
    overflow: hidden;
    font-size: 14px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar__bottom {
    flex: none;
    padding-top: 10px;
    border-top: 1px solid rgb(255 255 255 / 10%);
  }

  .sidebar__logout.el-button {
    display: flex;
    justify-content: flex-start;
    width: 100%;
    height: 42px;
    margin: 0;
    padding: 0 14px;
    color: #98a2b3;
    border-radius: 9px;
  }

  .sidebar__logout.el-button:hover,
  .sidebar__logout.el-button:focus-visible {
    color: #fda29b;
    background: rgb(217 45 32 / 12%);
  }

  .sidebar__logout .el-icon {
    flex: 0 0 auto;
    margin-right: 10px;
    font-size: 18px;
  }

  .sidebar__logout-label {
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 1100px) {
    .sidebar {
      padding-right: 8px;
      padding-left: 8px;
    }

    .sidebar__brand {
      justify-content: center;
      padding: 0;
    }

    .sidebar__brand-copy,
    .sidebar__section-label,
    .sidebar__nav-label,
    .sidebar__logout-label {
      display: none;
    }

    .sidebar__menu :deep(.el-menu-item),
    .sidebar__logout.el-button {
      justify-content: center;
      padding: 0 !important;
    }

    .sidebar__menu :deep(.el-icon),
    .sidebar__logout .el-icon {
      margin-right: 0;
    }
  }
</style>
