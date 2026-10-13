<template>
  <div class="app-footer">
    <span class="app-footer__product">指纹浏览器</span>
    <span class="app-footer__divider" aria-hidden="true"></span>
    <span>v{{ version }}</span>
    <span class="app-footer__copyright">&copy; {{ currentYear }}</span>
  </div>
</template>

<script setup>
  const version = __Admin_VERSION__;
  const currentYear = new Date().getFullYear();
</script>

<style scoped>
  .app-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    color: var(--app-text-secondary);
    font-size: 11px;
    line-height: 1;
    white-space: nowrap;
  }

  .app-footer__product {
    color: #475467;
    font-weight: 600;
  }

  .app-footer__divider {
    width: 3px;
    height: 3px;
    margin: 0 8px;
    border-radius: 50%;
    background: #98a2b3;
  }

  .app-footer__copyright {
    margin-left: 12px;
    color: #98a2b3;
  }
</style>
