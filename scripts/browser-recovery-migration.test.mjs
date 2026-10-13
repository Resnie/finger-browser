import assert from 'node:assert/strict';
import test from 'node:test';

import { planLegacyRecoveryMigration } from '../electron/main/models/browserRecoveryMigration.mjs';

const server = overrides => ({
  pages: [{ url: 'https://server.example', title: 'server' }],
  state: { cookies: [], origins: [] },
  history: [],
  credentials: [],
  recoveryRevision: 0,
  ...overrides,
});

const legacy = overrides => ({
  history: [{ url: 'https://legacy.example', title: 'legacy', timestamp: 1 }],
  credentials: [
    { domain: 'legacy.example', username: 'user', password: 'secret', lastUsedTime: 1 },
  ],
  ...overrides,
});

test('revision=0 且云字段为空时规划一次性旧缓存迁移', () => {
  const plan = planLegacyRecoveryMigration(server(), legacy());
  assert.deepEqual(plan, {
    history: legacy().history,
    credentials: legacy().credentials,
  });
});

test('云端非空字段保持权威，只迁移另一个空字段', () => {
  const cloudHistory = [{ url: 'https://cloud.example', title: 'cloud', timestamp: 2 }];
  const plan = planLegacyRecoveryMigration(server({ history: cloudHistory }), legacy());
  assert.deepEqual(plan, {
    history: cloudHistory,
    credentials: legacy().credentials,
  });
});

test('非初始 revision 或本机无旧数据时不迁移', () => {
  assert.equal(planLegacyRecoveryMigration(server({ recoveryRevision: 1 }), legacy()), null);
  assert.equal(
    planLegacyRecoveryMigration(server(), legacy({ history: [], credentials: [] })),
    null
  );
});

test('损坏的旧缓存不得被当作空数组迁移', () => {
  assert.throws(
    () => planLegacyRecoveryMigration(server(), legacy({ credentials: null })),
    /本地旧凭据格式无效/
  );
});
