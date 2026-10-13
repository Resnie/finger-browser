<template>
  <el-dialog
    v-model="visible"
    title="USDT 充值"
    width="580px"
    class="recharge-dialog"
    @closed="stop"
  >
    <div v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <template v-if="config?.enabled">
        <p class="recharge-intro">
          使用
          <strong>USDT-BEP20（BNB Smart Chain）</strong>
          转账。到账后输入交易哈希，由主站充值接口核对并计入共用余额。
        </p>
        <img
          v-if="matchesProvidedQR"
          :src="rechargeQR"
          class="recharge-qr"
          alt="当前 USDT-BEP20 收款地址二维码"
        />
        <div class="recharge-address">
          <span>收款地址</span>
          <code>{{ config.address }}</code>
          <el-button size="small" @click="copyAddress">复制地址</el-button>
        </div>
        <p class="recharge-help">
          请只使用此网络和币种；到账金额支持 3 位小数。交易哈希请勿转发，同一笔充值不能重复入账。
        </p>
        <el-form label-position="top" @submit.prevent="check">
          <el-form-item label="交易哈希">
            <el-input
              v-model="hash"
              :disabled="checking || watching"
              placeholder="0x 开头的完整交易哈希"
              maxlength="66"
              clearable
            />
          </el-form-item>
          <div class="recharge-actions">
            <el-button type="primary" :loading="checking" :disabled="!validHash" @click="check"
              >核对充值</el-button
            >
            <el-checkbox v-model="watching" :disabled="!validHash" @change="toggleWatching"
              >自动核对</el-checkbox
            >
          </div>
        </el-form>
        <p class="recharge-help">自动核对每 20 秒一次，最多 4 分钟；关闭窗口即停止。</p>
        <el-alert
          v-if="status"
          :title="status"
          :type="success ? 'success' : 'info'"
          :closable="false"
          show-icon
        />
      </template>
      <el-empty v-else-if="!loading && !error" description="充值暂未开放，请稍后重试" />
    </div>
    <template #footer><el-button @click="visible = false">关闭</el-button></template>
  </el-dialog>
</template>

<script setup>
  import { computed, onBeforeUnmount, ref, watch } from 'vue';
  import { getRechargeConfig, claimRecharge } from '@/api/billing';
  import { ElMessage } from '@/utils/message';
  import rechargeQR from '@/assets/bep20-recharge.png';

  const visible = defineModel({ type: Boolean, default: false });
  const emit = defineEmits(['credited']);
  const config = ref(null),
    hash = ref(''),
    error = ref(''),
    status = ref('');
  const loading = ref(false),
    checking = ref(false),
    watching = ref(false),
    success = ref(false);
  let timer = null,
    controller = null,
    revision = 0,
    deadline = 0;
  const validHash = computed(() => /^0x[0-9a-f]{64}$/i.test(hash.value.trim()));
  const matchesProvidedQR = computed(
    () => config.value?.address?.toLowerCase() === '0xbac3dc0ac4338b37194a43520e57f5c3cbe45ba6'
  );
  const stopWatching = () => {
    watching.value = false;
    clearTimeout(timer);
    timer = null;
  };
  const stop = () => {
    revision++;
    stopWatching();
    controller?.abort();
    controller = null;
    checking.value = false;
    loading.value = false;
  };

  watch(visible, async open => {
    stop();
    if (!open) return;
    const current = revision;
    controller = new AbortController();
    loading.value = true;
    config.value = null;
    error.value = '';
    status.value = '';
    success.value = false;
    try {
      const value = await getRechargeConfig(controller.signal);
      if (current !== revision) return;
      if (value?.enabled && !/^0x[0-9a-f]{40}$/i.test(value.address || ''))
        throw new Error('收款地址无效，请重试');
      config.value = value;
    } catch (e) {
      if (current === revision && e.code !== 'ERR_CANCELED')
        error.value = e.message || '充值配置加载失败';
    } finally {
      if (current === revision) loading.value = false;
    }
  });

  const check = async () => {
    if (checking.value || !validHash.value || !visible.value) return;
    clearTimeout(timer);
    const current = revision;
    controller = new AbortController();
    checking.value = true;
    error.value = '';
    success.value = false;
    try {
      const result = await claimRecharge(hash.value.trim().toLowerCase(), controller.signal);
      if (current !== revision) return;
      if (result?.status === 'credited' || result?.status === 'already_credited') {
        success.value = true;
        stopWatching();
        status.value = `${result.status === 'credited' ? '充值成功' : '这笔充值已入账'}：${result.amount} USDT，当前余额 ${result.balance} USDT。`;
        emit('credited');
      } else if (result?.status === 'pending')
        status.value = '主站暂未确认这笔充值，请等待服务器扫描后再次核对，勿重复转账。';
      else throw new Error('服务端充值结果异常，请刷新后核对');
    } catch (e) {
      if (current !== revision || e.code === 'ERR_CANCELED') return;
      error.value = e.message || '核对失败，请稍后重试';
      stopWatching();
    } finally {
      if (current === revision) {
        checking.value = false;
        if (watching.value && Date.now() < deadline) timer = setTimeout(check, 20000);
        else if (watching.value) {
          stopWatching();
          status.value = '自动核对已结束，可稍后手动核对，勿重复转账。';
        }
      }
    }
  };
  const toggleWatching = enabled => {
    if (!enabled) {
      stopWatching();
      return;
    }
    deadline = Date.now() + 240000;
    check();
  };
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(config.value.address);
      ElMessage.success('收款地址已复制');
    } catch {
      ElMessage.warning('复制失败，请手动复制收款地址');
    }
  };
  onBeforeUnmount(stop);
</script>

<style scoped>
  .recharge-intro {
    margin-top: 0;
    line-height: 1.7;
  }
  .recharge-qr {
    display: block;
    width: 220px;
    max-width: 70%;
    height: auto;
    margin: 14px auto;
  }
  .recharge-address {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: var(--app-surface-muted);
    border-radius: 8px;
  }
  .recharge-address code {
    flex: 1 1 100%;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .recharge-help {
    color: var(--app-text-secondary);
    font-size: 12px;
    line-height: 1.7;
  }
  .recharge-actions {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  :deep(.el-alert--success .el-alert__title) {
    color: #166534;
  }
</style>
