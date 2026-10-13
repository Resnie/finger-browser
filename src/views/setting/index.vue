<script setup>
  import Main from '@/views/home/Main.vue';
  import UpdateComponent from './UpdateComponent.vue';
</script>

<template>
  <Main>
    <section class="settings-page">
      <header class="settings-page__header">
        <div>
          <h1>设置</h1>
          <p>管理应用版本与更新。</p>
        </div>
      </header>
      <UpdateComponent />
    </section>
  </Main>
</template>

<style scoped>
  .settings-page {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
  }

  .settings-page__header {
    margin-bottom: 20px;
  }

  .settings-page__header h1 {
    margin: 0;
    font-size: 24px;
  }

  .settings-page__header p {
    margin: 8px 0 0;
    color: var(--app-text-secondary);
  }
</style>
