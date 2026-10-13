import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserRecoveryEmergencySentinel,
  BrowserRecoveryOutbox,
  areRecoverySnapshotsEquivalent,
  decideRecoveryOutboxReplay,
  shouldClearRecoveryOutbox,
  validateRecoveryReplayRevision,
} from '../electron/main/models/browserRecoveryOutbox.mjs';

class MemoryStore {
  static lastOptions = null;

  constructor(options) {
    MemoryStore.lastOptions = options;
    this.data = {};
    this.path = '';
  }

  get(key, fallback) {
    return Object.hasOwn(this.data, key) ? structuredClone(this.data[key]) : fallback;
  }

  set(key, value) {
    if (typeof key === 'object' && key !== null) {
      Object.assign(this.data, structuredClone(key));
      return;
    }
    this.data[key] = structuredClone(value);
  }
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`test-encrypted:${Buffer.from(value).toString('base64')}`),
  decryptString: value => {
    const encoded = value.toString().replace(/^test-encrypted:/, '');
    return Buffer.from(encoded, 'base64').toString();
  },
};

const sequences = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
];

const createPayload = (revision, password = 'test-password') => ({
  id: 'test-browser',
  pages: [{ url: 'https://example.com' }],
  state: { cookies: [], origins: [] },
  history: [],
  credentials: [{ domain: 'example.com', username: 'test-user', password, lastUsedTime: 1 }],
  recoveryRevision: revision,
  cloudRecoveryVersion: 1,
});

const createOutbox = () => {
  let index = 0;
  return new BrowserRecoveryOutbox({
    StoreClass: MemoryStore,
    safeStorageAdapter: safeStorage,
    sequenceFactory: () => sequences[index++],
    now: () => 123,
  });
};

const ownerId = '7';

test('outbox 使用 0600 electron-store 且 payload 不明文落盘', () => {
  const outbox = createOutbox();
  assert.equal(MemoryStore.lastOptions.configFileMode, 0o600);
  assert.equal(MemoryStore.lastOptions.clearInvalidConfig, false);

  outbox.put('test-browser', createPayload(4), 4, { ownerId });
  const diskText = JSON.stringify(outbox.store.data);
  assert.equal(diskText.includes('test-password'), false);
  assert.equal(diskText.includes('test-user'), false);

  const pending = outbox.read('test-browser', ownerId);
  assert.equal(pending.expectedRevision, 4);
  assert.equal(pending.payload.credentials[0].password, 'test-password');
});

test('旧请求成功不会误删后写入的新序列', () => {
  const outbox = createOutbox();
  const first = outbox.put('test-browser', createPayload(4, 'first-password'), 4, { ownerId });
  const second = outbox.put('test-browser', createPayload(4, 'second-password'), 4, { ownerId });

  assert.equal(shouldClearRecoveryOutbox(second.sequence, first.sequence), false);
  assert.equal(outbox.removeIfSequence('test-browser', first.sequence, ownerId), false);
  assert.equal(
    outbox.read('test-browser', ownerId).payload.credentials[0].password,
    'second-password'
  );
  assert.equal(outbox.removeIfSequence('test-browser', second.sequence, ownerId), true);
  assert.equal(outbox.getMetadata('test-browser', ownerId), null);
});

test('显式操作失败只在序列仍匹配时回滚 outbox', () => {
  const outbox = createOutbox();
  outbox.put('test-browser', createPayload(3, 'before'), 3, { ownerId });
  const previous = outbox.getRawEntry('test-browser', ownerId);
  const failed = outbox.put('test-browser', createPayload(3, 'failed-operation'), 3, { ownerId });

  assert.equal(outbox.restoreIfSequence('test-browser', failed.sequence, previous, ownerId), true);
  assert.equal(outbox.read('test-browser', ownerId).payload.credentials[0].password, 'before');

  const newer = outbox.put('test-browser', createPayload(3, 'newer'), 3, { ownerId });
  assert.equal(outbox.restoreIfSequence('test-browser', failed.sequence, previous, ownerId), false);
  assert.equal(outbox.getMetadata('test-browser', ownerId).sequence, newer.sequence);
});

test('回滚在一次落盘中原子恢复之前的 dirty marker', () => {
  const outbox = createOutbox();
  const previousMarker = outbox.markDirty('test-browser', 2, 'snapshot-not-secured', {
    ownerId,
    sequence: sequences[0],
  });
  const failed = outbox.put('test-browser', createPayload(2, 'failed-operation'), 2, {
    ownerId,
    sequence: sequences[1],
  });
  let writeCount = 0;
  const originalSet = outbox.store.set.bind(outbox.store);
  outbox.store.set = (key, value) => {
    writeCount += 1;
    originalSet(key, value);
  };

  assert.equal(
    outbox.rollbackAttempt('test-browser', failed.sequence, null, ownerId, previousMarker),
    true
  );
  assert.equal(writeCount, 1);
  assert.equal(outbox.getMetadata('test-browser', ownerId), null);
  assert.deepEqual(outbox.getDirtyMarker('test-browser', ownerId), previousMarker);
});

test('outbox 重放只接受 v1 且 expected revision 与服务端一致', () => {
  assert.deepEqual(
    decideRecoveryOutboxReplay({
      hasPendingEntry: false,
      cloudRecoveryVersion: 0,
      expectedRevision: 1,
      serverRevision: 2,
    }),
    { action: 'none' }
  );
  assert.deepEqual(
    decideRecoveryOutboxReplay({
      hasPendingEntry: true,
      cloudRecoveryVersion: 0,
      expectedRevision: 1,
      serverRevision: 1,
    }),
    { action: 'block', reason: 'capability' }
  );
  assert.deepEqual(
    decideRecoveryOutboxReplay({
      hasPendingEntry: true,
      cloudRecoveryVersion: 1,
      expectedRevision: 1,
      serverRevision: 2,
    }),
    { action: 'verify-committed' }
  );
  assert.deepEqual(
    decideRecoveryOutboxReplay({
      hasPendingEntry: true,
      cloudRecoveryVersion: 1,
      expectedRevision: 1,
      serverRevision: 3,
    }),
    { action: 'block', reason: 'conflict' }
  );
  assert.deepEqual(
    decideRecoveryOutboxReplay({
      hasPendingEntry: true,
      cloudRecoveryVersion: 1,
      expectedRevision: 2,
      serverRevision: 2,
    }),
    { action: 'replay' }
  );
  assert.equal(validateRecoveryReplayRevision(2, 3), true);
  assert.equal(validateRecoveryReplayRevision(2, 2), false);
  assert.equal(validateRecoveryReplayRevision(2, 1), false);
  assert.equal(validateRecoveryReplayRevision(2, 4), false);
});

test('解密失败会保留 outbox 并阻止读取', () => {
  const outbox = createOutbox();
  const written = outbox.put('test-browser', createPayload(5), 5, { ownerId });
  outbox.safeStorage = {
    ...safeStorage,
    decryptString() {
      throw new Error('test-decrypt-failure');
    },
  };

  assert.throws(() => outbox.read('test-browser', ownerId), /无法解密/);
  assert.equal(outbox.getMetadata('test-browser', ownerId).sequence, written.sequence);
});

test('队列或单条记录损坏时失败关闭，不伪装成空 outbox', () => {
  const outbox = createOutbox();
  outbox.store.data.entries = [];
  assert.throws(() => outbox.getMetadata('test-browser', ownerId), /队列格式损坏/);

  outbox.store.data.entries = { 'test-browser': { version: 1 } };
  assert.throws(() => outbox.getMetadata('test-browser', ownerId), /记录格式损坏/);
});

test('safeStorage 失败仍留下无业务数据的 dirty marker', () => {
  const outbox = createOutbox();
  outbox.safeStorage = { ...safeStorage, isEncryptionAvailable: () => false };
  assert.throws(
    () => outbox.put('test-browser', createPayload(6), 6, { ownerId }),
    /安全存储不可用/
  );
  const marker = outbox.getDirtyMarker('test-browser', ownerId);
  assert.equal(marker.expectedRevision, 6);
  assert.equal(JSON.stringify(outbox.store.data).includes('test-password'), false);
});

test('主 outbox 无法写标记时可用独立 0600 sentinel', () => {
  const sentinel = new BrowserRecoveryEmergencySentinel({
    StoreClass: MemoryStore,
    now: () => 456,
  });
  sentinel.mark('test-browser', 9, 'primary-store-failed', {
    ownerId,
    sequence: sequences[0],
  });
  assert.equal(MemoryStore.lastOptions.configFileMode, 0o600);
  assert.equal(MemoryStore.lastOptions.clearInvalidConfig, false);
  assert.equal(sentinel.get('test-browser', ownerId).expectedRevision, 9);
});

test('紧急 sentinel 回滚原位替换旧标记', () => {
  const sentinel = new BrowserRecoveryEmergencySentinel({
    StoreClass: MemoryStore,
    now: () => 456,
  });
  const previous = sentinel.mark('test-browser', 1, 'primary-store-failed', {
    ownerId,
    sequence: sequences[0],
  });
  sentinel.mark('test-browser', 2, 'primary-store-failed', {
    ownerId,
    sequence: sequences[1],
  });
  let writeCount = 0;
  const originalSet = sentinel.store.set.bind(sentinel.store);
  sentinel.store.set = (key, value) => {
    writeCount += 1;
    originalSet(key, value);
  };

  assert.equal(sentinel.restoreIfSequence('test-browser', sequences[1], previous, ownerId), true);
  assert.equal(writeCount, 1);
  assert.deepEqual(sentinel.get('test-browser', ownerId), previous);
});

test('ACK gap 仅在四类恢复数据完全等值时确认已提交', () => {
  const pending = createPayload(4);
  const server = structuredClone(pending);
  server.recoveryRevision = 5;
  server.pages[0].title = '';
  assert.equal(areRecoverySnapshotsEquivalent(pending, server), true);
  server.state = { cookies: [{ name: 'changed' }], origins: [] };
  assert.equal(areRecoverySnapshotsEquivalent(pending, server), false);
});

test('outbox 按 userId 隔离，其他用户不能读取或覆盖', () => {
  const outbox = createOutbox();
  outbox.put('test-browser', createPayload(2), 2, { ownerId });
  assert.throws(() => outbox.read('test-browser', '8'), /其他用户/);
  assert.throws(
    () => outbox.put('test-browser', createPayload(2), 2, { ownerId: '8' }),
    /其他用户/
  );
  assert.equal(outbox.getDirtyMarker('test-browser', ownerId), null);
});

test('不能跨用户覆盖 dirty marker 或 emergency sentinel', () => {
  const outbox = createOutbox();
  outbox.markDirty('test-browser', 1, 'snapshot-not-secured', {
    ownerId,
    sequence: sequences[0],
  });
  assert.throws(
    () =>
      outbox.markDirty('test-browser', 1, 'snapshot-not-secured', {
        ownerId: '8',
        sequence: sequences[1],
      }),
    /其他用户/
  );
  assert.equal(outbox.getDirtyMarker('test-browser', ownerId).sequence, sequences[0]);

  const sentinel = new BrowserRecoveryEmergencySentinel({ StoreClass: MemoryStore });
  sentinel.mark('test-browser', 1, 'primary-store-failed', {
    ownerId,
    sequence: sequences[0],
  });
  assert.throws(
    () =>
      sentinel.mark('test-browser', 1, 'primary-store-failed', {
        ownerId: '8',
        sequence: sequences[1],
      }),
    /其他用户/
  );
  assert.equal(sentinel.clearIfSequence('test-browser', sequences[1], ownerId), false);
  assert.equal(sentinel.clearIfSequence('test-browser', sequences[0], ownerId), true);
});

test('删除意图只存非敏感元数据并按 owner/序列清理', () => {
  const outbox = createOutbox();
  const intent = outbox.stageDeletionIntent('test-browser', ownerId, sequences[0]);
  assert.equal(intent.ownerId, ownerId);
  assert.equal(JSON.stringify(outbox.store.data).includes('test-password'), false);
  assert.deepEqual(outbox.stageDeletionIntent('test-browser', ownerId, sequences[1]), intent);
  assert.throws(() => outbox.getDeletionIntent('test-browser', '8'), /其他用户/);
  assert.equal(outbox.clearDeletionIntentIfSequence('test-browser', sequences[1], ownerId), false);
  assert.equal(outbox.clearDeletionIntentIfSequence('test-browser', sequences[0], ownerId), true);
});

test('孤儿清理只枚举当前 owner 的 outbox/sentinel ID', () => {
  const outbox = createOutbox();
  outbox.put('test-browser', createPayload(0), 0, { ownerId, sequence: sequences[0] });
  outbox.stageDeletionIntent('test-other', '8', sequences[1]);
  assert.deepEqual(outbox.listBrowserIdsForOwner(ownerId), ['test-browser']);
  assert.deepEqual(outbox.listBrowserIdsForOwner('8'), ['test-other']);

  const sentinel = new BrowserRecoveryEmergencySentinel({ StoreClass: MemoryStore });
  sentinel.mark('test-browser', 0, 'primary-store-failed', {
    ownerId,
    sequence: sequences[0],
  });
  sentinel.mark('test-other', 0, 'primary-store-failed', {
    ownerId: '8',
    sequence: sequences[1],
  });
  assert.deepEqual(sentinel.listBrowserIdsForOwner(ownerId), ['test-browser']);
});
