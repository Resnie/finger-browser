import { ElMessage as elementMessage } from 'element-plus';
import { createErrorFeedback } from './error.mjs';

const error = createErrorFeedback(options => elementMessage(options));

// 显式导入和 Vue 全局 $message 共用一个入口，覆盖接口、页面和 IPC 监听。
export const ElMessage = Object.assign(
  (options, ...args) => ['error', 'warning'].includes(options?.type)
    ? error(options, undefined, options.type)
    : elementMessage(options, ...args),
  { ...elementMessage, error, warning: (input, fallback) => error(input, fallback, 'warning') }
);
