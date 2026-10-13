import { getCurrentInstance } from 'vue';

/**
 * 获取 Vue 全局属性的 composable
 * 提供统一的方式访问 Element Plus 的消息、确认框等全局方法
 */
export function useGlobalProperties() {
  const instance = getCurrentInstance();
  const globalProperties = instance?.appContext.config.globalProperties;

  if (!globalProperties) {
    console.warn('[useGlobalProperties] 无法获取全局属性，请确保在 setup 中调用');
  }

  return {
    /**
     * Element Plus Message 消息提示
     */
    $message: globalProperties?.$message,

    /**
     * Element Plus MessageBox 确认框
     */
    $confirm: globalProperties?.$confirm,

    /**
     * Element Plus Notification 通知
     */
    $notify: globalProperties?.$notify,
  };
}

/**
 * 消息通知工具函数
 * 封装常用的消息提示方法
 */
export function useMessage() {
  const { $message } = useGlobalProperties();

  return {
    /**
     * 成功消息
     * @param {string} message - 消息内容
     */
    success: message => {
      $message?.success(message);
    },

    /**
     * 警告消息
     * @param {string} message - 消息内容
     */
    warning: message => {
      $message?.warning(message);
    },

    /**
     * 错误消息
     * @param {string} message - 消息内容
     */
    error: (error, fallback) => {
      $message?.error(error, fallback);
    },

    /**
     * 信息消息
     * @param {string} message - 消息内容
     */
    info: message => {
      $message?.info(message);
    },
  };
}

/**
 * 确认对话框工具函数
 * 封装常用的确认框方法
 */
export function useConfirm() {
  const { $confirm } = useGlobalProperties();

  return {
    /**
     * 显示确认对话框
     * @param {string} message - 消息内容
     * @param {string} title - 标题
     * @param {Object} options - 配置选项
     * @returns {Promise} 确认结果
     */
    confirm: (message, title = '提示', options = {}) => {
      return $confirm?.(message, title, {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
        ...options,
      });
    },

    /**
     * 显示删除确认对话框
     * @param {string} message - 消息内容
     * @returns {Promise} 确认结果
     */
    confirmDelete: (message = '确定要删除吗？此操作不可恢复。') => {
      return $confirm?.(message, '删除确认', {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning',
      });
    },

    /**
     * 显示危险操作确认对话框
     * @param {string} message - 消息内容
     * @param {string} title - 标题
     * @returns {Promise} 确认结果
     */
    confirmDanger: (message, title = '危险操作') => {
      return $confirm?.(message, title, {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'error',
      });
    },
  };
}
