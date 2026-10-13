import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntimeLeases } from '../electron/main/models/browserRuntimeLease.mjs';

const fixture = () => {
  let wall = 1000,
    mono = 1000,
    failure;
  const requests = [],
    closed = [];
  const leases = new BrowserRuntimeLeases({
    wallNow: () => wall,
    monotonicNow: () => mono,
    intervalMs: 1000000,
    request: async (action, payload) => {
      requests.push({ action, payload });
      if (failure) throw failure;
      return { ttlMillis: 90000, recovery: { recoveryRevision: 3 } };
    },
    onLost: async id => {
      closed.push(id);
    },
  });
  return {
    leases,
    requests,
    closed,
    advance: (w, m) => {
      wall += w;
      mono += m;
    },
    fail: e => {
      failure = e;
    },
  };
};
test('acquire uses a random secret; release includes final cloud revision', async () => {
  const f = fixture();
  await f.leases.acquire('test-browser');
  assert.match(f.leases.getToken('test-browser'), /^[0-9a-f]{64}$/);
  assert.ok(f.leases.valid('test-browser'));
  await f.leases.release('test-browser', 7);
  assert.equal(f.requests.at(-1).payload.recoveryRevision, 7);
  assert.equal(f.leases.entries.size, 0);
});
test('restart and stopped recovery normalize string and numeric owner IDs', async () => {
  const f = fixture();
  await f.leases.acquire('test-browser', 44);
  const token = f.leases.getToken('test-browser');
  await f.leases.acquire('test-browser', '44');
  assert.equal(f.leases.getToken('test-browser'), token);
  await assert.rejects(f.leases.acquire('test-browser', 45), /其他登录用户/);
  await f.leases.release('test-browser', 3);
});
test('a lost renewal closes exactly once and cannot keep a browser running', async () => {
  const f = fixture();
  await f.leases.acquire('test-browser');
  f.fail(new Error('test-network'));
  await f.leases.renew('test-browser');
  await f.leases.renew('test-browser');
  assert.deepEqual(f.closed, ['test-browser']);
  assert.equal(f.leases.valid('test-browser'), false);
});
test('sleep or a backwards wall clock cannot hide lease expiration', async () => {
  for (const elapsed of [
    [80000, 0],
    [-100000, 80000],
  ]) {
    const f = fixture();
    await f.leases.acquire('test-browser');
    f.advance(...elapsed);
    await f.leases.renew('test-browser');
    assert.deepEqual(f.closed, ['test-browser']);
    assert.equal(f.requests.filter(r => r.action === 'renew').length, 0);
  }
});
test('unknown acquire outcome retries the same token; definitive busy response leaves no lock handle', async () => {
  const f = fixture();
  f.fail(new Error('test-timeout'));
  await assert.rejects(f.leases.acquire('test-browser'));
  const first = f.leases.getToken('test-browser');
  f.fail(null);
  await f.leases.acquire('test-browser');
  assert.equal(f.leases.getToken('test-browser'), first);
  await f.leases.release('test-browser', 3);
  const busy = new Error('test-busy');
  busy.definitiveLeaseRejection = true;
  f.fail(busy);
  await assert.rejects(f.leases.acquire('test-browser'));
  assert.equal(f.leases.entries.size, 0);
});
