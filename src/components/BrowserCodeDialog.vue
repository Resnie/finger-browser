<template>
  <el-dialog
    :model-value="modelValue"
    :title="result?.type === 'email' ? '邮箱验证码' : '谷歌验证码'"
    width="min(520px, calc(100vw - 32px))"
    destroy-on-close
    @update:model-value="value => emit('update:modelValue', value)"
    @closed="emit('closed')"
  >
    <template v-if="result">
      <el-alert
        v-if="result.cacheOnly"
        class="code-dialog__alert"
        type="warning"
        :closable="false"
        show-icon
        title="实时同步未成功，以下结果仅来自本地缓存，可能不是最新邮件。"
      />

      <div class="code-dialog__account">
        <span>{{ result.accountName || '关联账号' }}</span>
        <span>{{ result.email }}</span>
      </div>

      <div class="code-dialog__code" aria-label="验证码">{{ result.code }}</div>

      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="来源">{{ result.source }}</el-descriptions-item>
        <el-descriptions-item v-if="result.type === 'email'" label="邮件时间">
          {{ formatResultTime(result.emailTime) }}
        </el-descriptions-item>
        <el-descriptions-item v-if="result.type === 'email'" label="邮件主题">
          {{ result.subject || '无主题' }}
        </el-descriptions-item>
        <el-descriptions-item v-else label="生成时间">
          {{ formatResultTime(result.generatedAt) }}
        </el-descriptions-item>
        <el-descriptions-item v-if="result.type === 'google'" label="有效期">
          约 {{ remainingSeconds }} 秒后自动刷新
        </el-descriptions-item>
      </el-descriptions>
    </template>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button v-if="result?.type === 'google'" :loading="refreshing" @click="emit('refresh')">
        刷新
      </el-button>
      <el-button type="primary" @click="copyCode">复制验证码</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
  import { ElMessage } from '@/utils/message';
  import { computed, onBeforeUnmount, ref, watch } from 'vue';
  import { formatDateTime } from '@/utils/date';
  import {
    didTOTPWindowChange,
    getTOTPRemainingSeconds,
    getTOTPWindow,
  } from '@/utils/totpRefresh.mjs';

  const props = defineProps({
    modelValue: { type: Boolean, default: false },
    result: { type: Object, default: null },
    refreshing: { type: Boolean, default: false },
  });
  const emit = defineEmits(['update:modelValue', 'closed', 'refresh']);
  const now = ref(Date.now());
  let visibleGoogleWindow = getTOTPWindow(now.value);

  const remainingSeconds = computed(() => getTOTPRemainingSeconds(now.value));

  watch(
    () => [props.modelValue, props.result?.type],
    () => {
      now.value = Date.now();
      visibleGoogleWindow = getTOTPWindow(now.value);
    }
  );

  const refreshTimer = setInterval(() => {
    now.value = Date.now();
    if (!props.modelValue || props.result?.type !== 'google') return;
    if (!didTOTPWindowChange(visibleGoogleWindow, now.value)) return;
    visibleGoogleWindow = getTOTPWindow(now.value);
    emit('refresh');
  }, 1000);

  onBeforeUnmount(() => clearInterval(refreshTimer));

  const formatResultTime = value => {
    const numeric = Number(value);
    const normalized =
      value !== null && value !== '' && Number.isFinite(numeric) && numeric > 0
        ? numeric < 1_000_000_000_000
          ? numeric * 1000
          : numeric
        : value;
    return formatDateTime(normalized) || '未知';
  };

  const copyCode = async () => {
    if (!props.result?.code) return;
    try {
      await navigator.clipboard.writeText(String(props.result.code));
      ElMessage.success('验证码已复制');
    } catch {
      ElMessage.warning('复制失败，请手动选中验证码');
    }
  };
</script>

<style scoped>
  .code-dialog__alert {
    margin-bottom: 16px;
  }

  .code-dialog__account {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    color: var(--el-text-color-secondary);
    font-size: 13px;
  }

  .code-dialog__account span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .code-dialog__account span:last-child {
    text-align: right;
  }

  .code-dialog__code {
    margin-bottom: 18px;
    padding: 18px;
    border: 1px solid var(--el-color-primary-light-7);
    border-radius: 10px;
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: clamp(30px, 8vw, 44px);
    font-weight: 700;
    letter-spacing: 0.18em;
    line-height: 1;
    text-align: center;
    user-select: text;
  }
</style>
