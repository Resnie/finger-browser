import { ref } from 'vue';
import { useMessage } from './useGlobalProperties.js';
import { getUserFacingErrorMessage } from '@/utils/error.mjs';

/**
 * API 请求处理 composable
 * 提供统一的 API 调用、加载状态和错误处理
 */
export function useApiHandler() {
  const loading = ref(false);
  const error = ref(null);
  const message = useMessage();

  /**
   * 从错误对象中提取错误消息
   * @param {Error} err - 错误对象
   * @param {string} defaultMessage - 默认错误消息
   * @returns {string} 错误消息
   */
  const extractErrorMessage = (err, defaultMessage = '操作失败') => {
    return getUserFacingErrorMessage(err?.response?.data?.message || err, defaultMessage);
  };

  /**
   * 处理 API 错误
   * @param {Error} err - 错误对象
   * @param {string} defaultMessage - 默认错误消息
   * @returns {string} 错误消息
   */
  const handleError = (err, defaultMessage = '操作失败') => {
    const errorMessage = extractErrorMessage(err, defaultMessage);
    error.value = errorMessage;
    message.error(err, defaultMessage);
    console.error('[API Error]', err);
    return errorMessage;
  };

  /**
   * 执行 API 请求并处理加载状态和错误
   * @param {Function} apiCall - API 调用函数
   * @param {Object} options - 配置选项
   * @returns {Promise<any>} API 响应数据
   */
  const execute = async (apiCall, options = {}) => {
    const {
      successMessage = '',
      errorMessage = '操作失败',
      showLoading = true,
      showError = true,
      onSuccess = null,
      onError = null,
    } = options;

    if (showLoading) {
      loading.value = true;
    }
    error.value = null;

    try {
      const result = await apiCall();

      if (successMessage) {
        message.success(successMessage);
      }

      if (onSuccess) {
        onSuccess(result);
      }

      return result;
    } catch (err) {
      if (showError) {
        handleError(err, errorMessage);
      } else {
        error.value = extractErrorMessage(err, errorMessage);
      }

      if (onError) {
        onError(err);
      }

      throw err;
    } finally {
      if (showLoading) {
        loading.value = false;
      }
    }
  };

  /**
   * 执行 API 请求（静默模式，不显示错误提示）
   * @param {Function} apiCall - API 调用函数
   * @returns {Promise<any>} API 响应数据
   */
  const executeSilent = async apiCall => {
    return execute(apiCall, {
      showLoading: false,
      showError: false,
    });
  };

  /**
   * 重置状态
   */
  const reset = () => {
    loading.value = false;
    error.value = null;
  };

  return {
    loading,
    error,
    execute,
    executeSilent,
    handleError,
    reset,
  };
}

/**
 * 列表数据加载 composable
 * 专门用于处理列表数据的加载、分页等
 */
export function useListLoader(fetchFn) {
  const data = ref([]);
  const total = ref(0);
  const loading = ref(false);
  const error = ref(null);
  const message = useMessage();

  /**
   * 加载列表数据
   * @param {Object} params - 请求参数
   * @returns {Promise<void>}
   */
  const load = async (params = {}) => {
    loading.value = true;
    error.value = null;

    try {
      const result = await fetchFn(params);

      // 处理不同的响应格式
      if (Array.isArray(result)) {
        data.value = result;
        total.value = result.length;
      } else if (result?.list) {
        data.value = result.list;
        total.value = result.total || result.list.length;
      } else if (result?.data) {
        data.value = result.data;
        total.value = result.total || result.data.length;
      } else {
        data.value = [];
        total.value = 0;
      }
    } catch (err) {
      error.value = getUserFacingErrorMessage(err, '加载失败，请稍后重试');
      message.error(err, '加载失败，请稍后重试');
      console.error('[List Loader Error]', err);
    } finally {
      loading.value = false;
    }
  };

  /**
   * 重置列表数据
   */
  const reset = () => {
    data.value = [];
    total.value = 0;
    loading.value = false;
    error.value = null;
  };

  return {
    data,
    total,
    loading,
    error,
    load,
    reset,
  };
}
