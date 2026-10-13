import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';

// Execute the production method without loading Electron's native stores in Node.
const source = (await fs.readFile(
  new URL('../electron/main/browserManager.js', import.meta.url),
  'utf8'
)).replace(/\r\n/g, '\n');
const start = source.indexOf('\n  async prepareSessionLogout(');
const end = source.indexOf('\n  }\n', start);
assert.ok(start >= 0 && end > start);
const Manager = new Function(`return class { ${source.slice(start, end + 4)} };`)();
function fixture() {
  const manager = new Manager();
  let token = 'test-token-first';
  Object.assign(manager, {
    _sessionTransitioning: false,
    _frozenToken: '',
    _sessionCache: null,
    instances: new Map(),
    launchingInstances: new Map(),
    _unsafeClosedInstances: new Map(),
    _backgroundCleanupPromises: new Map(),
    _persistChains: new Map(),
    _detachedRecoveryReady: new Set(),
    _detachedRecoveryRevisions: new Map(),
    _detachedRecoveryOwners: new Map(),
    _getToken: async () => token,
    _getCurrentSession: async () => ({ userId: 1 }),
    _retryUnsafeClosedRecoveries: async () => {},
  });
  return {
    manager,
    token: value => {
      token = value;
    },
  };
}

test('退出完成后的旧 token 保持冻结；重新登录且未打开浏览器也可以再次退出', async () => {
  const f = fixture();
  assert.equal(await f.manager.prepareSessionLogout(), true);
  await assert.rejects(f.manager.prepareSessionLogout(), /登录会话正在切换/);
  f.token('test-token-new-login');
  assert.equal(await f.manager.prepareSessionLogout(), true);
  assert.equal(f.manager._frozenToken, 'test-token-new-login');
});

test('正在收口期间并发退出仍被阻止', async () => {
  const f = fixture();
  let release, entered;
  const waiting = new Promise(resolve => {
    release = resolve;
  });
  const started = new Promise(resolve => {
    entered = resolve;
  });
  f.manager.instances.set('test-browser', { ownerId: 1 });
  f.manager.closeInstance = async id => {
    entered();
    await waiting;
    f.manager.instances.delete(id);
  };
  const first = f.manager.prepareSessionLogout();
  await started;
  await assert.rejects(f.manager.prepareSessionLogout(), /登录会话正在切换/);
  release();
  assert.equal(await first, true);
});

test('恢复写入失败不冻结 token，修复后可重试收口', async () => {
  const f = fixture();
  f.manager.instances.set('test-browser', { ownerId: 1 });
  f.manager.closeInstance = async () => {
    throw new Error('test-recovery-not-secured');
  };
  await assert.rejects(f.manager.prepareSessionLogout(), /test-recovery-not-secured/);
  assert.equal(f.manager._sessionTransitioning, false);
  assert.equal(f.manager._frozenToken, '');
  assert.equal(f.manager.instances.size, 1);
  f.manager.closeInstance = async id => {
    f.manager.instances.delete(id);
  };
  assert.equal(await f.manager.prepareSessionLogout(), true);
});
