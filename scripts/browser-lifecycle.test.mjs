import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  BROWSER_LIFECYCLE_ACTIONS,
  claimBrowserLifecycleClose,
  closeContextWithTimeout,
  closeLifecycleContext,
  resolveBrowserLifecycleAction,
} from '../electron/main/models/browserLifecycle.mjs';

test('关闭流程只能被第一个异步回调占用', () => {
  const instance = { isClosing: false };
  assert.equal(claimBrowserLifecycleClose(instance), true);
  assert.equal(instance.isClosing, true);
  assert.equal(claimBrowserLifecycleClose(instance), false);
});

test('有业务页面时保持浏览器运行', () => {
  assert.equal(
    resolveBrowserLifecycleAction({ openPageCount: 2, validPageCount: 1 }),
    BROWSER_LIFECYCLE_ACTIONS.KEEP_OPEN
  );
});

test('最后一个页面已关闭时主动关闭 context 并保留快照', () => {
  assert.equal(
    resolveBrowserLifecycleAction({ openPageCount: 0, validPageCount: 0 }),
    BROWSER_LIFECYCLE_ACTIONS.CLOSE_AND_PRESERVE
  );
});

test('仅剩内部页面时关闭 context 并清空页面恢复列表', () => {
  assert.equal(
    resolveBrowserLifecycleAction({ openPageCount: 1, validPageCount: 0 }),
    BROWSER_LIFECYCLE_ACTIONS.CLOSE_AND_CLEAR
  );
});

test('拒绝矛盾的页面计数', () => {
  assert.throws(
    () => resolveBrowserLifecycleAction({ openPageCount: 0, validPageCount: 1 }),
    RangeError
  );
});

test('context close 事件先到时不误报关闭超时', async () => {
  class ContextStub extends EventEmitter {
    close() {
      queueMicrotask(() => this.emit('close'));
      return new Promise(() => {});
    }
  }

  await closeContextWithTimeout(new ContextStub(), 50);
});

test('context 无关闭信号时仍会超时', async () => {
  class ContextStub extends EventEmitter {
    close() {
      return new Promise(() => {});
    }
  }

  await assert.rejects(closeContextWithTimeout(new ContextStub(), 10), /context\.close\(\) 超时/);
});

test('生命周期优雅关闭成功时不会调用强制清理', async () => {
  let forceCloseCalls = 0;
  const result = await closeLifecycleContext({
    closeGracefully: async () => true,
    forceClose: async () => {
      forceCloseCalls += 1;
      return true;
    },
  });

  assert.deepEqual(result, { closed: true, graceful: true, forced: false });
  assert.equal(forceCloseCalls, 0);
});

test('生命周期 context 关闭超时时必须执行强制清理', async () => {
  let forceCloseCalls = 0;
  const result = await closeLifecycleContext({
    closeGracefully: async () => false,
    forceClose: async () => {
      forceCloseCalls += 1;
      return true;
    },
  });

  assert.deepEqual(result, { closed: true, graceful: false, forced: true });
  assert.equal(forceCloseCalls, 1);
});

test('生命周期强制清理失败时不得误报已关闭', async () => {
  const result = await closeLifecycleContext({
    closeGracefully: async () => {
      throw new Error('close failed');
    },
    forceClose: async () => false,
  });

  assert.deepEqual(result, { closed: false, graceful: false, forced: true });
});
