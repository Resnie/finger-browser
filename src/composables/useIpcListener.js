import { onBeforeUnmount } from 'vue';

/**
 * IPC 监听器管理 composable
 * 自动在组件卸载时清理监听器，避免路由切换时的重复监听问题
 */

// 存储所有已注册的监听器，用于调试和全局管理
const registeredListeners = new Map();

/**
 * 注册单个 IPC 监听器，组件卸载时自动清理
 * @param {string} channel - IPC 通道名称
 * @param {Function} handler - 事件处理函数
 * @returns {Function} 手动取消监听的函数
 */
export function useIpcListener(channel, handler) {
  if (!window.ipcRenderer) {
    console.warn('[useIpcListener] ipcRenderer not available');
    return () => {};
  }

  // preload 已剥离 Electron event，业务层只接收事件载荷。
  const cleanup = window.ipcRenderer.on(channel, (...args) => handler(...args));

  // 生成唯一标识用于追踪
  const listenerId = `${channel}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  registeredListeners.set(listenerId, { channel, cleanup });

  // 取消监听的函数
  const off = () => {
    cleanup?.();
    registeredListeners.delete(listenerId);
  };

  // 在组件卸载前自动清理
  onBeforeUnmount(() => {
    off();
  });

  return off;
}

/**
 * 批量注册多个 IPC 监听器
 * @param {Array<{channel: string, handler: Function}>} listeners - 监听器配置数组
 * @returns {Function} 手动取消所有监听的函数
 */
export function useIpcListeners(listeners) {
  const offFunctions = listeners.map(({ channel, handler }) => useIpcListener(channel, handler));

  return () => {
    offFunctions.forEach(off => off());
  };
}

/**
 * 创建一个一次性监听器，触发一次后自动取消
 * @param {string} channel - IPC 通道名称
 * @param {Function} handler - 事件处理函数
 * @returns {Function} 手动取消监听的函数
 */
export function useIpcOnce(channel, handler) {
  let off = null;

  const wrappedHandler = (...args) => {
    handler(...args);
    if (off) {
      off();
    }
  };

  off = useIpcListener(channel, wrappedHandler);
  return off;
}

/**
 * 全局单例监听器管理器
 * 用于需要在整个应用生命周期内只注册一次的监听器
 */
class GlobalIpcListenerManager {
  constructor() {
    this.listeners = new Map();
  }

  /**
   * 注册全局监听器（单例模式，同一 channel 只注册一次）
   * @param {string} channel - IPC 通道名称
   * @param {Function} handler - 事件处理函数
   * @returns {boolean} 是否是新注册（true）还是已存在（false）
   */
  register(channel, handler) {
    if (this.listeners.has(channel)) {
      return false;
    }

    if (window.ipcRenderer) {
      const cleanup = window.ipcRenderer.on(channel, (...args) => handler(...args));
      this.listeners.set(channel, cleanup);
      return true;
    }

    return false;
  }

  /**
   * 取消全局监听器
   * @param {string} channel - IPC 通道名称
   */
  unregister(channel) {
    const cleanup = this.listeners.get(channel);
    if (cleanup) {
      cleanup();
      this.listeners.delete(channel);
    }
  }

  /**
   * 清理所有全局监听器
   */
  clear() {
    this.listeners.forEach(cleanup => {
      cleanup();
    });
    this.listeners.clear();
  }

  /**
   * 检查某个 channel 是否已注册
   * @param {string} channel - IPC 通道名称
   * @returns {boolean}
   */
  has(channel) {
    return this.listeners.has(channel);
  }
}

// 导出全局单例管理器实例
export const globalIpcManager = new GlobalIpcListenerManager();

/**
 * 在 Store 中使用的监听器注册函数
 * 不依赖 Vue 生命周期，需要手动管理
 * @param {string} channel - IPC 通道名称
 * @param {Function} handler - 事件处理函数
 * @returns {Function} 取消监听的函数
 */
export function registerIpcListener(channel, handler) {
  if (!window.ipcRenderer) {
    console.warn('[registerIpcListener] ipcRenderer not available');
    return () => {};
  }

  const cleanup = window.ipcRenderer.on(channel, (...args) => handler(...args));

  return () => {
    cleanup?.();
  };
}
