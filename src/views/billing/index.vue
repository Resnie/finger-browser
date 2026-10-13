<template>
  <Main>
    <section class="billing-page">
      <header class="billing-page__header">
        <div>
          <h1>余额与账单</h1>
          <p>查看 USDT 余额、免费创建额度和账单明细。</p>
        </div>
        <el-button :loading="refreshing" :icon="Refresh" @click="refreshAll">刷新</el-button>
      </header>

      <el-alert
        v-if="summaryError"
        class="billing-page__alert"
        type="error"
        :closable="false"
        show-icon
        title="余额与计费状态加载失败"
        description="当前不会估算或展示未确认的金额，请刷新后重试。"
      />

      <div class="billing-summary" v-loading="summaryLoading">
        <article class="summary-card summary-card--balance">
          <div class="summary-card__heading">
            <span class="summary-card__icon"
              ><el-icon><Wallet /></el-icon
            ></span>
            <span>账户余额</span>
          </div>
          <div class="summary-card__amount">
            <strong>{{ displayBalance }}</strong>
            <span>USDT</span>
          </div>
          <p v-if="summary.sharedAccount">与主站共用账户余额，充值和扣费以服务器记录为准。</p>
          <p v-else>本页暂不提供充值操作。</p>
          <el-button v-if="summary.rechargeEnabled" @click="rechargeVisible = true"
            >USDT 充值</el-button
          >
        </article>

        <article class="summary-card">
          <div class="summary-card__heading">
            <span class="summary-card__icon"
              ><el-icon><Tickets /></el-icon
            ></span>
            <span>当前计费方式</span>
          </div>
          <div class="summary-card__mode">
            <strong>按次创建</strong>
            <el-tag size="small" type="primary" effect="light">当前模式</el-tag>
          </div>
          <p>{{ quotaDescription }}；删除窗口或账号后不返还免费次数。</p>
          <div class="summary-card__future">
            <el-icon><Calendar /></el-icon>
            <span>月套餐暂未开放</span>
          </div>
        </article>
      </div>

      <section class="usage-section">
        <div class="section-heading">
          <div>
            <h2>创建额度</h2>
            <p>窗口和账号是两类独立资源，分别计算免费创建次数。</p>
            <p>
              免费次数用完后按页面单价扣费。仅成功新增计费，编辑、打开和删除不收费；克隆按新建计算，导入只统计净新增账号。
            </p>
          </div>
        </div>

        <div class="usage-grid" v-loading="summaryLoading">
          <article v-for="item in resourceCards" :key="item.resource" class="usage-card">
            <div class="usage-card__top">
              <span class="usage-card__icon">
                <el-icon><component :is="item.icon" /></el-icon>
              </span>
              <div class="usage-card__identity">
                <strong>{{ item.meta.label }}</strong>
                <span>{{ item.meta.description }}</span>
              </div>
              <el-tag :type="item.tagType" size="small" effect="light">
                {{ item.pricingLabel }}
              </el-tag>
            </div>

            <template v-if="item.usage">
              <div class="usage-card__numbers">
                <span>免费额度已用</span>
                <strong>{{ item.usage.freeUsed }} / {{ item.usage.freeLimit }}</strong>
              </div>
              <el-progress
                :percentage="item.percentage"
                :stroke-width="8"
                :show-text="false"
                :color="item.percentage >= 100 ? '#d97706' : '#2563eb'"
              />
              <div class="usage-card__foot">
                <span>累计成功创建 {{ item.usage.lifetimeCreated }} 个</span>
                <span>免费剩余 {{ item.usage.freeRemaining }} 次</span>
              </div>
            </template>
            <el-empty v-else :image-size="40" description="额度状态暂不可用" />

            <div class="usage-card__pricing" :class="`usage-card__pricing--${item.kind}`">
              <strong>{{ item.pricingTitle }}</strong>
              <span>{{ item.pricingDescription }}</span>
            </div>
          </article>
        </div>
      </section>

      <section class="bills-section">
        <header class="section-heading section-heading--bills">
          <div>
            <h2>账单明细</h2>
            <p>余额变动以服务端账单为准。</p>
          </div>
          <el-button text type="primary" :loading="billsLoading" @click="loadBills"
            >刷新账单</el-button
          >
        </header>

        <el-alert
          v-if="billsError"
          class="billing-page__alert"
          type="error"
          :closable="false"
          show-icon
          title="账单加载失败"
          description="请检查网络后重试，已显示的余额不会在本地推算。"
        />

        <div class="bills-table" v-loading="billsLoading">
          <el-table :data="bills" empty-text="暂无账单" height="100%">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ displayDate(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column prop="entryNo" label="账单号" min-width="178" show-overflow-tooltip>
              <template #default="{ row }">{{ row.entryNo || '—' }}</template>
            </el-table-column>
            <el-table-column label="项目" min-width="150">
              <template #default="{ row }">{{ getBillCategoryLabel(row.category) }}</template>
            </el-table-column>
            <el-table-column prop="description" label="说明" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">{{ row.description || '—' }}</template>
            </el-table-column>
            <el-table-column label="变动金额" width="170" align="right">
              <template #default="{ row }">
                <span class="bill-amount" :class="`bill-amount--${row.direction}`">
                  {{ amountPrefix(row.direction)
                  }}{{ displayAmount(row.amount, row.amountMinor) }} USDT
                </span>
              </template>
            </el-table-column>
            <el-table-column label="变动后余额" width="178" align="right">
              <template #default="{ row }">
                {{ displayAmount(row.balanceAfter, row.balanceAfterMinor) }} USDT
              </template>
            </el-table-column>
          </el-table>
        </div>

        <footer class="bills-pagination">
          <PagePane
            :total="billTotal"
            :page="billPage"
            :page-size="billPageSize"
            @size-change="handleBillPageChange"
            @current-change="handleBillPageChange"
          />
        </footer>
      </section>
    </section>
    <RechargeDialog v-model="rechargeVisible" @credited="refreshAll" />
  </Main>
</template>

<script setup>
  import { computed, markRaw, onMounted, ref } from 'vue';
  import { Calendar, Monitor, Refresh, Tickets, User, Wallet } from '@element-plus/icons-vue';
  import Main from '@/views/home/Main.vue';
  import PagePane from '@/components/pagePane.vue';
  import RechargeDialog from '@/components/RechargeDialog.vue';
  import { getBillingSummary, searchBills } from '@/api/billing';
  import {
    formatMinorAmount,
    getBillCategoryLabel,
    getResourceMeta,
    normalizeBillingSummary,
    normalizeBillSearch,
  } from '@/utils/billing.mjs';
  import { formatDateTime } from '@/utils/date';

  const summary = ref(normalizeBillingSummary(null));
  const rechargeVisible = ref(false);
  const summaryLoading = ref(false);
  const summaryError = ref(false);
  const bills = ref([]);
  const billTotal = ref(0);
  const billPage = ref(1);
  const billPageSize = ref(20);
  const billsLoading = ref(false);
  const billsError = ref(false);

  const resourceDefinitions = [
    { resource: 'browser', icon: markRaw(Monitor) },
    { resource: 'account', icon: markRaw(User) },
  ];

  const displayBalance = computed(() => summary.value.wallet.balance || '—');
  const quotaDescription = computed(() => {
    const browser = summary.value.usage.find(item => item.resource === 'browser');
    const account = summary.value.usage.find(item => item.resource === 'account');
    return browser && account
      ? `窗口免费额度 ${browser.freeLimit} 次，账号免费额度 ${account.freeLimit} 次`
      : '免费额度暂不可用，请刷新后重试';
  });

  const resourceCards = computed(() =>
    resourceDefinitions.map(definition => {
      const usage = summary.value.usage.find(item => item.resource === definition.resource) || null;
      const pricing =
        summary.value.pricing.find(
          item => item.resource === definition.resource && item.mode === 'per_create'
        ) || null;
      let kind = 'pending';
      let tagType = 'info';
      let pricingLabel = '尚未启用计费';
      let pricingTitle = '超额计费尚未启用';
      let pricingDescription = '单价未配置，免费次数用完后暂时不能继续创建。';

      const unitPrice = formatMinorAmount(pricing?.unitPriceMinor, summary.value.scale);
      if (pricing?.status === 'active' && pricing.unitPriceMinor !== '0' && unitPrice) {
        kind = 'active';
        tagType = 'warning';
        pricingLabel = '按次计费';
        pricingTitle = `${unitPrice.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')} USDT / 个`;
        pricingDescription = '免费次数用完后，每次成功创建按此单价扣费。';
      } else if (pricing?.status === 'disabled') {
        kind = 'disabled';
        pricingLabel = '计费未启用';
        pricingTitle = '超额计费尚未启用';
        pricingDescription = '免费次数用完后暂时不能继续创建，不会产生扣费。';
      }

      const percentage = usage
        ? usage.freeLimit > 0
          ? Math.min(100, Math.round((usage.freeUsed / usage.freeLimit) * 100))
          : 100
        : 0;

      return {
        ...definition,
        meta: getResourceMeta(definition.resource),
        usage,
        pricing,
        percentage,
        kind,
        tagType,
        pricingLabel,
        pricingTitle,
        pricingDescription,
      };
    })
  );

  const loadSummary = async () => {
    summaryLoading.value = true;
    summaryError.value = false;
    try {
      const result = normalizeBillingSummary(await getBillingSummary());
      if (result.currency !== 'USDT') throw new Error('计费币种异常');
      summary.value = result;
    } catch {
      summary.value = normalizeBillingSummary(null);
      summaryError.value = true;
    } finally {
      summaryLoading.value = false;
    }
  };

  const loadBills = async () => {
    billsLoading.value = true;
    billsError.value = false;
    try {
      const result = normalizeBillSearch(
        await searchBills({ current: billPage.value, pageSize: billPageSize.value })
      );
      billTotal.value = result.count;
      bills.value = result.list;
      if (bills.value.length === 0 && billTotal.value > 0 && billPage.value > 1) {
        billPage.value -= 1;
        await loadBills();
      }
    } catch {
      bills.value = [];
      billTotal.value = 0;
      billsError.value = true;
    } finally {
      billsLoading.value = false;
    }
  };

  const refreshing = computed(() => summaryLoading.value || billsLoading.value);
  const refreshAll = () => Promise.allSettled([loadSummary(), loadBills()]);

  const handleBillPageChange = ({ page, size }) => {
    billPage.value = page;
    billPageSize.value = size;
    loadBills();
  };

  const displayAmount = (amount, amountMinor) =>
    formatMinorAmount(amountMinor, summary.value.scale) || amount || '—';
  const amountPrefix = direction =>
    direction === 'debit' ? '−' : direction === 'credit' ? '+' : '';
  const displayDate = value => formatDateTime(value) || '—';

  onMounted(refreshAll);
</script>

<style scoped>
  .billing-page {
    display: flex;
    flex-direction: column;
    gap: 18px;
    width: 100%;
    min-height: 100%;
    padding-bottom: 8px;
  }

  .billing-page__header,
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .billing-page__header h1,
  .section-heading h2 {
    margin: 0;
    color: var(--app-text);
  }

  .billing-page__header h1 {
    font-size: 24px;
  }

  .section-heading h2 {
    font-size: 17px;
  }

  .billing-page__header p,
  .section-heading p {
    margin: 6px 0 0;
    color: var(--app-text-secondary);
    font-size: 13px;
  }

  .billing-page__alert {
    flex: none;
  }

  .billing-summary,
  .usage-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .summary-card,
  .usage-card,
  .bills-section {
    border: 1px solid var(--app-border);
    border-radius: 12px;
    background: var(--app-surface);
    box-shadow: var(--app-shadow);
  }

  .summary-card {
    min-height: 168px;
    padding: 18px 20px;
  }

  .summary-card--balance {
    color: #ffffff;
    border-color: transparent;
    background: linear-gradient(135deg, #172554 0%, #1d4ed8 62%, #2563eb 100%);
  }

  .summary-card__heading {
    display: flex;
    align-items: center;
    gap: 9px;
    color: var(--app-text-secondary);
    font-size: 13px;
    font-weight: 600;
  }

  .summary-card--balance .summary-card__heading,
  .summary-card.summary-card--balance p {
    color: rgb(255 255 255 / 72%);
  }

  .summary-card__icon,
  .usage-card__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: var(--el-color-primary-light-9);
  }

  .summary-card--balance .summary-card__icon {
    color: #ffffff;
    background: rgb(255 255 255 / 14%);
  }

  .summary-card__amount {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 18px;
  }

  .summary-card__amount strong {
    overflow: hidden;
    font-size: clamp(28px, 3vw, 38px);
    line-height: 1;
    letter-spacing: -0.03em;
    text-overflow: ellipsis;
  }

  .summary-card__amount span {
    color: rgb(255 255 255 / 72%);
    font-size: 13px;
    font-weight: 650;
  }

  .summary-card p {
    margin: 16px 0 0;
    color: var(--app-text-secondary);
    font-size: 12px;
    line-height: 1.6;
  }

  .summary-card__mode {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-top: 17px;
  }

  .summary-card__mode strong {
    font-size: 22px;
  }

  .summary-card__future {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
    padding-top: 12px;
    color: var(--app-text-secondary);
    font-size: 12px;
    border-top: 1px solid var(--app-border);
  }

  .usage-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .usage-card {
    padding: 17px 18px;
  }

  .usage-card__top {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .usage-card__identity {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
  }

  .usage-card__identity strong {
    font-size: 14px;
  }

  .usage-card__identity span {
    margin-top: 3px;
    overflow: hidden;
    color: var(--app-text-secondary);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .usage-card__numbers,
  .usage-card__foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .usage-card__numbers {
    margin: 17px 0 8px;
    color: var(--app-text-secondary);
    font-size: 12px;
  }

  .usage-card__numbers strong {
    color: var(--app-text);
    font-size: 14px;
  }

  .usage-card__foot {
    margin-top: 8px;
    color: var(--app-text-secondary);
    font-size: 11px;
  }

  .usage-card__pricing {
    display: flex;
    margin-top: 14px;
    padding: 10px 12px;
    flex-direction: column;
    border-radius: 8px;
    background: var(--app-surface-muted);
  }

  .usage-card__pricing strong {
    color: var(--app-text);
    font-size: 12px;
  }

  .usage-card__pricing span {
    margin-top: 3px;
    color: var(--app-text-secondary);
    font-size: 11px;
    line-height: 1.5;
  }

  .usage-card__pricing--active {
    background: rgb(217 119 6 / 7%);
  }

  .bills-section {
    display: flex;
    flex: 1;
    min-height: 360px;
    flex-direction: column;
    overflow: hidden;
  }

  .section-heading--bills {
    flex: none;
    min-height: 66px;
    padding: 13px 16px;
    border-bottom: 1px solid var(--app-border);
  }

  .bills-section > .billing-page__alert {
    margin: 12px 16px 0;
  }

  .bills-table {
    flex: 1;
    min-height: 230px;
    padding: 0 16px;
  }

  .bills-pagination {
    display: flex;
    flex: none;
    justify-content: flex-end;
    min-height: 56px;
    padding: 10px 16px;
    border-top: 1px solid var(--app-border);
    background: var(--app-surface-muted);
  }

  .bill-amount {
    font-weight: 650;
  }

  .bill-amount--credit {
    color: var(--el-color-success);
  }

  .bill-amount--debit {
    color: var(--el-color-danger);
  }

  @media (max-width: 1100px) {
    .billing-summary,
    .usage-grid {
      grid-template-columns: 1fr;
    }

    .summary-card {
      min-height: 148px;
    }
  }
</style>
