<script setup lang="ts">
  import Aside from './Aside.vue';
  import Footer from './Footer.vue';
</script>

<template>
  <div class="app-shell">
    <aside class="app-shell__sidebar" aria-label="主导航">
      <Aside />
    </aside>

    <div class="app-shell__workspace">
      <main class="app-shell__main">
        <div class="app-shell__content">
          <slot />
        </div>
      </main>

      <footer class="app-shell__footer">
        <Footer />
      </footer>
    </div>
  </div>
</template>

<style scoped>
  .app-shell {
    --app-sidebar-width: 184px;

    display: flex;
    width: 100%;
    height: 100%;
    min-width: 960px;
    min-height: 620px;
    overflow: hidden;
    background: var(--app-bg);
  }

  .app-shell__sidebar {
    position: relative;
    z-index: 2;
    flex: 0 0 var(--app-sidebar-width);
    width: var(--app-sidebar-width);
    min-width: 0;
    overflow: hidden;
    background: var(--app-sidebar);
    box-shadow: 4px 0 18px rgb(16 24 40 / 8%);
    transition:
      width 180ms ease,
      flex-basis 180ms ease;
  }

  .app-shell__workspace {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .app-shell__main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 18px 20px 12px;
    overflow: hidden;
  }

  .app-shell__content {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .app-shell__footer {
    flex: 0 0 30px;
    min-width: 0;
    height: 30px;
    padding: 0 20px;
  }

  @media (max-width: 1100px) {
    .app-shell {
      --app-sidebar-width: 72px;

      min-width: 900px;
    }

    .app-shell__main {
      padding-right: 14px;
      padding-left: 14px;
    }
  }
</style>
