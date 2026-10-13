<template>
  <section class="creation-billing" :class="`creation-billing--${state.kind}`">
    <div v-if="loading" class="creation-billing__loading">
      <el-skeleton :rows="1" animated />
    </div>
    <template v-else>
      <span class="creation-billing__icon" aria-hidden="true">
        <el-icon><Coin /></el-icon>
      </span>
      <div class="creation-billing__content">
        <div class="creation-billing__title-row">
          <strong>{{ state.title }}</strong>
          <el-tag size="small" :type="tagType" effect="light">{{ tagText }}</el-tag>
        </div>
        <p>{{ state.description }}</p>
        <p v-if="priceExplanation">{{ priceExplanation }}</p>
      </div>
      <el-button text type="primary" :loading="loading" @click="load">刷新</el-button>
      <el-button v-if="summary?.rechargeEnabled" text type="primary" @click="rechargeVisible = true"
        >充值</el-button
      >
    </template>
  </section>
  <RechargeDialog v-model="rechargeVisible" @credited="load" />
</template>

<script setup>
  import { computed, onMounted, ref, watch } from 'vue';
  import { Coin } from '@element-plus/icons-vue';
  import { getBillingSummary } from '@/api/billing';
  import { getResourceBillingState } from '@/utils/billing.mjs';
  import RechargeDialog from '@/components/RechargeDialog.vue';

  const props = defineProps({
    resource: {
      type: String,
      required: true,
      validator: value => ['browser', 'account'].includes(value),
    },
    quantity: {
      type: Number,
      default: 1,
    },
  });

  const emit = defineEmits(['state-change']);
  const loading = ref(true);
  const summary = ref(null);
  const rechargeVisible = ref(false);
  const priceExplanation = computed(() => {
    const usage = state.value.usage,
      pricing = state.value.pricing;
    if (!usage || pricing?.status !== 'active' || !pricing.unitPrice) return '';
    return `每个账户可免费创建 ${usage.freeLimit} 次${state.value.meta.shortLabel}，超出后每个 ${pricing.unitPrice.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')} USDT；成功创建才扣费，编辑和删除不收费。`;
  });
  const state = ref(getResourceBillingState(null, props.resource, props.quantity));
  let loadSequence = 0;

  const tagType = computed(
    () =>
      ({
        free: 'success',
        paid: 'warning',
        pending: 'info',
        insufficient: 'danger',
        unavailable: 'danger',
      })[state.value.kind] || 'info'
  );

  const tagText = computed(
    () =>
      ({
        free: '免费额度',
        paid: '按次计费',
        pending: '暂不可用',
        insufficient: '余额不足',
        unavailable: '状态未知',
      })[state.value.kind] || '状态未知'
  );

  const updateState = () => {
    state.value = getResourceBillingState(summary.value, props.resource, props.quantity);
    emit('state-change', state.value);
  };

  const load = async () => {
    const sequence = ++loadSequence;
    loading.value = true;
    emit('state-change', { ...state.value, allowed: false });
    try {
      const result = await getBillingSummary();
      if (sequence !== loadSequence) return;
      summary.value = result;
    } catch {
      if (sequence !== loadSequence) return;
      summary.value = null;
    } finally {
      if (sequence !== loadSequence) return;
      loading.value = false;
      updateState();
    }
  };

  watch(
    () => props.quantity,
    () => load()
  );

  onMounted(load);
  defineExpose({ load });
</script>

<style scoped>
  .creation-billing {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-height: 68px;
    margin-bottom: 16px;
    padding: 12px 14px;
    border: 1px solid var(--el-border-color-light);
    border-radius: 10px;
    background: var(--app-surface-muted);
  }

  .creation-billing--free {
    border-color: rgb(22 163 74 / 24%);
    background: rgb(22 163 74 / 5%);
  }

  .creation-billing--paid {
    border-color: rgb(217 119 6 / 28%);
    background: rgb(217 119 6 / 6%);
  }

  .creation-billing--pending,
  .creation-billing--unavailable,
  .creation-billing--insufficient {
    border-color: rgb(220 38 38 / 18%);
    background: rgb(220 38 38 / 4%);
  }

  .creation-billing__loading {
    width: 100%;
  }

  .creation-billing__icon {
    display: inline-flex;
    flex: 0 0 32px;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    color: var(--el-color-primary);
    border-radius: 9px;
    background: var(--el-color-primary-light-9);
  }

  .creation-billing__content {
    flex: 1;
    min-width: 0;
  }

  .creation-billing__title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }

  .creation-billing__title-row strong {
    color: var(--app-text);
    font-size: 13px;
    font-weight: 650;
  }

  .creation-billing__content p {
    margin: 3px 0 0;
    color: var(--app-text-secondary);
    font-size: 12px;
    line-height: 1.55;
  }
</style>
