<template>
  <section class="table-pane">
    <header v-if="$slots.search" class="table-pane__toolbar">
      <slot name="search"></slot>
    </header>

    <div class="table-pane__content">
      <slot></slot>
    </div>

    <footer v-if="$slots.page" class="table-pane__pagination">
      <slot name="page"></slot>
    </footer>
  </section>
</template>

<style scoped>
  .table-pane {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--app-border);
    border-radius: 12px;
    background: var(--app-surface);
    box-shadow: var(--app-shadow);
  }

  .table-pane__toolbar {
    display: flex;
    flex: none;
    align-items: center;
    width: 100%;
    min-height: 60px;
    padding: 13px 16px;
    border-bottom: 1px solid var(--app-border);
    background: var(--app-surface);
  }

  .table-pane__toolbar :deep(> *) {
    width: 100%;
  }

  .table-pane__toolbar :deep(.search-pane),
  .table-pane__toolbar :deep(.toolbar) {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
    min-height: 0;
  }

  .table-pane__toolbar :deep(.search-pane > *),
  .table-pane__toolbar :deep(.toolbar > *) {
    margin-left: 0 !important;
  }

  .table-pane__toolbar :deep(.el-tabs) {
    margin-bottom: -13px;
  }

  .table-pane__toolbar :deep(.el-tabs__header) {
    margin-bottom: 0;
  }

  .table-pane__content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 0 16px 12px;
    overflow: auto;
    background: var(--app-surface);
  }

  .table-pane__content :deep(.el-table) {
    max-width: 100%;
  }

  .table-pane__pagination {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: flex-end;
    min-height: 56px;
    padding: 10px 16px;
    overflow-x: auto;
    border-top: 1px solid var(--app-border);
    background: var(--app-surface-muted);
  }

  @media (max-width: 1100px) {
    .table-pane__toolbar {
      padding: 12px;
    }

    .table-pane__toolbar :deep(.el-input),
    .table-pane__toolbar :deep(.el-select) {
      max-width: 220px;
    }

    .table-pane__content {
      padding-right: 12px;
      padding-left: 12px;
    }

    .table-pane__pagination {
      padding-right: 12px;
      padding-left: 12px;
    }
  }
</style>
