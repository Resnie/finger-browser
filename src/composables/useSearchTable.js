import { ref, reactive, computed } from 'vue';
import { PAGINATION } from '@/constants';
import { useMessage } from './useGlobalProperties.js';
import { getUserFacingErrorMessage } from '@/utils/error.mjs';

/**
 * 搜索表格 composable
 * 提供统一的搜索、分页、表格数据管理功能
 */
export function useSearchTable(searchFn, options = {}) {
  const {
    defaultPage = PAGINATION.DEFAULT_PAGE,
    defaultSize = PAGINATION.DEFAULT_SIZE,
    pageSizes = PAGINATION.PAGE_SIZES,
    transformData = null,
    immediate = false,
  } = options;

  const message = useMessage();

  // 数据状态
  const tableData = ref([]);
  const total = ref(0);
  const loading = ref(false);
  const error = ref(null);

  // 分页状态
  const pagination = reactive({
    currentPage: defaultPage,
    pageSize: defaultSize,
    pageSizes,
  });

  // 搜索参数
  const searchParams = ref({});

  /**
   * 执行搜索
   * @param {Object} params - 额外的搜索参数
   * @param {Object} pageData - 分页参数覆盖
   */
  const search = async (params = null, pageData = null) => {
    // 更新搜索参数
    if (params !== null) {
      searchParams.value = params;
    }

    // 更新分页参数
    if (pageData) {
      if (pageData.page !== undefined) {
        pagination.currentPage = pageData.page;
      }
      if (pageData.size !== undefined) {
        pagination.pageSize = pageData.size;
      }
    }

    loading.value = true;
    error.value = null;

    try {
      const requestParams = {
        page: pagination.currentPage,
        size: pagination.pageSize,
        ...searchParams.value,
      };

      const result = await searchFn(requestParams);

      // 处理响应数据
      let list = [];
      let totalCount = 0;

      if (Array.isArray(result)) {
        list = result;
        totalCount = result.length;
      } else if (result?.list) {
        list = result.list;
        totalCount = result.total || result.list.length;
      } else if (result?.data) {
        list = result.data;
        totalCount = result.total || result.data.length;
      }

      // 应用数据转换
      if (transformData) {
        list = transformData(list);
      }

      tableData.value = list;
      total.value = totalCount;

      return result;
    } catch (err) {
      error.value = getUserFacingErrorMessage(err, '搜索失败，请稍后重试');
      message.error(err, '搜索失败，请稍后重试');
      console.error('[Search Table Error]', err);
      throw err;
    } finally {
      loading.value = false;
    }
  };

  /**
   * 刷新数据（使用当前参数重新搜索）
   */
  const refresh = async () => {
    return search(null, null);
  };

  /**
   * 重置搜索（清空参数并回到第一页）
   */
  const reset = async () => {
    searchParams.value = {};
    pagination.currentPage = defaultPage;
    return search({}, null);
  };

  /**
   * 处理分页大小变化
   * @param {number} size - 新的分页大小
   */
  const handleSizeChange = size => {
    pagination.currentPage = 1;
    search(null, { size, page: 1 });
  };

  /**
   * 处理页码变化
   * @param {number} page - 新的页码
   */
  const handleCurrentChange = page => {
    search(null, { page });
  };

  // 分页信息计算属性
  const paginationInfo = computed(() => ({
    currentPage: pagination.currentPage,
    pageSize: pagination.pageSize,
    total: total.value,
    pageSizes: pagination.pageSizes,
  }));

  // 是否有数据
  const hasData = computed(() => tableData.value.length > 0);

  // 是否为空状态
  const isEmpty = computed(() => !loading.value && tableData.value.length === 0);

  // 立即执行搜索
  if (immediate) {
    search();
  }

  return {
    // 数据状态
    tableData,
    total,
    loading,
    error,

    // 分页状态
    pagination,
    paginationInfo,

    // 搜索参数
    searchParams,

    // 计算属性
    hasData,
    isEmpty,

    // 方法
    search,
    refresh,
    reset,
    handleSizeChange,
    handleCurrentChange,
  };
}

/**
 * 表格多选 composable
 * 提供表格多选相关功能
 */
export function useTableSelection() {
  const selectedRows = ref([]);

  /**
   * 处理选择变化
   * @param {Array} selection - 选中的行
   */
  const handleSelectionChange = selection => {
    selectedRows.value = selection;
  };

  /**
   * 清空选择
   */
  const clearSelection = () => {
    selectedRows.value = [];
  };

  /**
   * 获取选中的 ID 列表
   * @param {string} idField - ID 字段名
   * @returns {Array} ID 列表
   */
  const getSelectedIds = (idField = 'id') => {
    return selectedRows.value.map(row => row[idField]);
  };

  // 是否有选中项
  const hasSelection = computed(() => selectedRows.value.length > 0);

  // 选中数量
  const selectionCount = computed(() => selectedRows.value.length);

  return {
    selectedRows,
    hasSelection,
    selectionCount,
    handleSelectionChange,
    clearSelection,
    getSelectedIds,
  };
}

/**
 * 表格行操作 composable
 * 提供表格行的增删改操作
 */
export function useTableOperations(options = {}) {
  const { onRefresh = null } = options;
  const message = useMessage();

  /**
   * 执行删除操作
   * @param {Function} deleteFn - 删除 API 函数
   * @param {any} id - 要删除的 ID
   * @param {Object} opts - 配置选项
   */
  const handleDelete = async (deleteFn, id, opts = {}) => {
    const { successMessage = '删除成功', errorMessage = '删除失败' } = opts;

    try {
      await deleteFn(id);
      message.success(successMessage);

      if (onRefresh) {
        await onRefresh();
      }

      return true;
    } catch (err) {
      message.error(errorMessage);
      console.error('[Delete Error]', err);
      return false;
    }
  };

  /**
   * 执行批量删除操作
   * @param {Function} deleteFn - 删除 API 函数
   * @param {Array} ids - 要删除的 ID 列表
   * @param {Object} opts - 配置选项
   */
  const handleBatchDelete = async (deleteFn, ids, opts = {}) => {
    const { successMessage = '批量删除成功', errorMessage = '批量删除失败' } = opts;

    if (!ids || ids.length === 0) {
      message.warning('请先选择要删除的项');
      return false;
    }

    try {
      await Promise.all(ids.map(id => deleteFn(id)));
      message.success(successMessage);

      if (onRefresh) {
        await onRefresh();
      }

      return true;
    } catch (err) {
      message.error(errorMessage);
      console.error('[Batch Delete Error]', err);
      return false;
    }
  };

  return {
    handleDelete,
    handleBatchDelete,
  };
}
