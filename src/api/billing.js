import api from '@/utils/request';

// 账户余额、计价状态与免费额度均以服务端实时数据为准。
export const getBillingSummary = () => {
  return api.get('/billing/summary', {}, { loading: false, silentError: true });
};

// 账单仅支持查看，不在客户端缓存或二次计算余额。
export const searchBills = data => {
  return api.post('/billing/bills/search', data, { loading: false, silentError: true });
};

export const getRechargeConfig = signal =>
  api.get('/billing/recharge/config', {}, { loading: false, silentError: true, signal });

// 服务端衔接 auto-register 使用的主站充值接口，客户端只提交哈希。
export const claimRecharge = (hash, signal) =>
  api.post('/billing/recharge/claim', { hash }, { loading: false, silentError: true, signal });
