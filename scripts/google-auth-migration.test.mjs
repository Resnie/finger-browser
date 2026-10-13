import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleAuthMigration } from '../electron/utils/googleAuthMigration.mjs';
import { generateTotpToken } from '../electron/utils/totp.mjs';

const UUID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'JBSWY3DPEHPK3PXP';
const SESSION = { token: 'test-session', senderId: 1 };
const SNAPSHOT_TOKEN = 'a'.repeat(64);

const fixture = (options = {}) => {
  let timestamp = 1_800_000_029_999;
  let status = options.status || 'legacy_rsa';
  let snapshotToken = SNAPSHOT_TOKEN;
  let localEntry =
    options.localEntry === undefined ? 'v2:test-encrypted-local-secret' : options.localEntry;
  let cleanupCount = 0;
  let localReadCount = 0;
  const requests = [];
  const migration = createGoogleAuthMigration({
    now: () => timestamp,
    createTicket: () => 'test-migration-ticket',
    readLocalEntry: () => {
      localReadCount += 1;
      return localEntry;
    },
    decryptLocalEntry: entry => {
      if (options.unreadable) throw new Error('test-secret-must-not-leak');
      assert.equal(entry, localEntry);
      return SECRET;
    },
    deleteLocalEntryIfUnchanged: (_identity, expected) => {
      if (expected !== localEntry) return false;
      cleanupCount += 1;
      localEntry = null;
      return true;
    },
    post: async (endpoint, data, session) => {
      requests.push({ endpoint, data, session });
      assert.deepEqual(session, SESSION);
      if (options.onRequest) await options.onRequest(endpoint, data);
      if (endpoint === '/emails/google_auth_migration_status') {
        return {
          uuid: UUID,
          email: 'test-migrate@example.com',
          googleAuthStatus: status,
          migrationToken: snapshotToken,
        };
      }
      if (endpoint === '/emails/migrate_google_auth') {
        assert.equal(data.migrationToken, snapshotToken);
        if (options.casConflict) throw new Error('云端账号已变化，请重新检查');
        assert.equal(status, 'legacy_rsa');
        status = 'ready';
        return { googleAuthStatus: 'ready' };
      }
      if (endpoint === '/emails/google_auth_code') {
        if (options.verificationFailure) throw new Error('test-verification-network-error');
        if (options.onVerify)
          options.onVerify({
            advance: value => {
              timestamp += value;
            },
            changeLocal: value => {
              localEntry = value;
            },
          });
        return { code: options.code || generateTotpToken(SECRET, { timestamp }) };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
  });
  return {
    ...migration,
    requests,
    setStatus: value => {
      status = value;
    },
    setToken: value => {
      snapshotToken = value;
    },
    setLocal: value => {
      localEntry = value;
    },
    advance: value => {
      timestamp += value;
    },
    get localEntry() {
      return localEntry;
    },
    get cleanupCount() {
      return cleanupCount;
    },
    get localReadCount() {
      return localReadCount;
    },
  };
};

const prepare = f => f.prepare({ uuid: UUID }, SESSION);
const commitLocal = (f, preview, extra = {}) =>
  f.commit({ ticket: preview.ticket, confirmed: true, source: 'local', ...extra }, SESSION);

test('云端ready永不读取或上传陈旧本机密钥', async () => {
  const f = fixture({ status: 'ready' });
  const preview = await prepare(f);
  assert.equal(preview.status, 'ready');
  assert.equal(preview.ticket, undefined);
  assert.equal(f.localReadCount, 0);
  assert.equal(f.requests.length, 1);
});

test('预览只返回状态与本机确认票据，不泄漏原密钥/密文/云端CAS令牌', async () => {
  const f = fixture();
  const preview = await prepare(f);
  assert.equal(preview.localStatus, 'available');
  assert.equal(preview.localSource, 'safe_storage');
  const payload = JSON.stringify(preview);
  for (const hidden of [SECRET, f.localEntry, SNAPSHOT_TOKEN, SESSION.token])
    assert.ok(!payload.includes(hidden));
  assert.equal(f.requests.filter(r => r.endpoint === '/emails/migrate_google_auth').length, 0);
});

test('未经明确确认不能迁移，旧副本完整保留', async () => {
  const f = fixture();
  const preview = await prepare(f);
  await assert.rejects(f.commit({ ticket: preview.ticket, source: 'local' }, SESSION), /先确认/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.cleanupCount, 0);
});

test('确认后条件上传并核验云端验证码，成功才清理原副本', async () => {
  const f = fixture();
  const preview = await prepare(f);
  const result = await commitLocal(f, preview);
  assert.equal(result.success, true);
  assert.match(result.code, /^\d{6}$/);
  assert.equal(f.localEntry, null);
  assert.equal(f.cleanupCount, 1);
  assert.deepEqual(
    f.requests.map(r => r.endpoint),
    [
      '/emails/google_auth_migration_status',
      '/emails/google_auth_migration_status',
      '/emails/migrate_google_auth',
      '/emails/google_auth_code',
    ]
  );
  assert.equal(f.requests[2].data.googleAuth, `totp:v1:${SECRET}`);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  await assert.rejects(commitLocal(f, preview), /已过期/);
});

test('预览后云端变为ready时停止迁移，原密钥不会覆盖云端', async () => {
  const f = fixture();
  const preview = await prepare(f);
  f.setStatus('ready');
  await assert.rejects(commitLocal(f, preview), /保留云端密钥/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.cleanupCount, 0);
});

test('预览后云端快照变化时必须重新确认', async () => {
  const f = fixture();
  const preview = await prepare(f);
  f.setToken('b'.repeat(64));
  await assert.rejects(commitLocal(f, preview), /云端账号已变化/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.cleanupCount, 0);
});

test('第二次状态查询后发生服务器CAS竞争，不改用普通编辑接口或删除本机副本', async () => {
  const f = fixture({ casConflict: true });
  const preview = await prepare(f);
  await assert.rejects(commitLocal(f, preview), /云端账号已变化/);
  assert.equal(f.cleanupCount, 0);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every(r => r.endpoint !== '/emails/edit'));
});

test('本机密钥在确认之前变化时阻止使用旧确认', async () => {
  const f = fixture();
  const preview = await prepare(f);
  f.setLocal('v2:test-newer-local-secret');
  await assert.rejects(commitLocal(f, preview), /本机谷歌密钥已变化/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.cleanupCount, 0);
});

test('无法解密旧RSA密钥时不泄漏错误详情并支持重新录入', async () => {
  const f = fixture({ localEntry: 'test-old-rsa-ciphertext', unreadable: true });
  const preview = await prepare(f);
  assert.equal(preview.localStatus, 'unreadable');
  assert.match(preview.message, /重新输入/);
  assert.ok(!JSON.stringify(preview).includes('test-secret-must-not-leak'));
  await assert.rejects(commitLocal(f, preview), /本机旧密钥无法使用/);
  const result = await commitLocal(f, preview, {
    source: 'manual',
    secret: 'jbsw y3dp-ehpk3pxp====',
  });
  assert.equal(result.success, true);
  assert.equal(f.cleanupCount, 1);
});

test('本机没有密钥时可明确确认并重新录入，验证码校验正常', async () => {
  const f = fixture({ localEntry: null });
  const preview = await prepare(f);
  assert.equal(preview.localStatus, 'missing');
  const result = await commitLocal(f, preview, { source: 'manual', secret: SECRET });
  assert.equal(result.success, true);
  assert.equal(f.cleanupCount, 0);
});

test('拒绝无效或过短的重录密钥，确认不会触发上传', async () => {
  const f = fixture();
  const preview = await prepare(f);
  for (const secret of ['test-invalid-0189', 'AAAA']) {
    await assert.rejects(commitLocal(f, preview, { source: 'manual', secret }), /Base32|格式无效/);
  }
  assert.ok(!f.requests.some(r => r.endpoint === '/emails/migrate_google_auth'));
  assert.equal(f.cleanupCount, 0);
});

test('跨30秒边界取码能够验证成功', async () => {
  const f = fixture({ onVerify: ({ advance }) => advance(2) });
  const result = await commitLocal(f, await prepare(f));
  assert.equal(result.success, true);
  assert.equal(f.cleanupCount, 1);
});

test('错误的云端验证码保留本机旧密钥，明确区分已上传与未验证', async () => {
  const f = fixture({ code: '000000' });
  const result = await commitLocal(f, await prepare(f));
  assert.equal(result.success, false);
  assert.equal(result.uploaded, true);
  assert.match(result.message, /保留本机旧密钥/);
  assert.equal(f.cleanupCount, 0);
  assert.ok(f.localEntry);
});

test('上传后验证码请求失败仍保留本机旧密钥', async () => {
  const f = fixture({ verificationFailure: true });
  const result = await commitLocal(f, await prepare(f));
  assert.equal(result.success, false);
  assert.equal(result.uploaded, true);
  assert.equal(f.cleanupCount, 0);
});

test('上传后本机副本变更不误删新密钥', async () => {
  const f = fixture({ onVerify: ({ changeLocal }) => changeLocal('v2:test-newer-local-secret') });
  const result = await commitLocal(f, await prepare(f));
  assert.equal(result.success, true);
  assert.equal(f.localEntry, 'v2:test-newer-local-secret');
  assert.equal(f.cleanupCount, 0);
});

test('票据绑定发起窗口、登录会话和过期时间', async () => {
  const f = fixture();
  const preview = await prepare(f);
  for (const session of [
    { ...SESSION, senderId: 2 },
    { ...SESSION, token: 'test-other-session' },
  ]) {
    await assert.rejects(
      f.commit({ ticket: preview.ticket, confirmed: true, source: 'local' }, session),
      /登录会话已变化/
    );
  }
  f.advance(5 * 60_000);
  await assert.rejects(commitLocal(f, preview), /已过期/);
  assert.equal(f.requests.length, 1);
});

test('无法确认后端迁移能力时失败关闭且不回退普通编辑', async () => {
  const f = fixture({
    onRequest: endpoint => {
      if (endpoint === '/emails/google_auth_migration_status')
        throw new Error('当前后端尚不支持安全迁移');
    },
  });
  await assert.rejects(prepare(f), /不支持安全迁移/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.localReadCount, 0);
});

test('同一确认票据并发提交只进行一次迁移请求', async () => {
  let releaseStatus;
  let enteredStatus;
  let statusCount = 0;
  const statusGate = new Promise(resolve => {
    releaseStatus = resolve;
  });
  const statusEntered = new Promise(resolve => {
    enteredStatus = resolve;
  });
  const f = fixture({
    onRequest: async endpoint => {
      if (endpoint === '/emails/google_auth_migration_status' && ++statusCount === 2) {
        enteredStatus();
        await statusGate;
      }
    },
  });
  const preview = await prepare(f);
  const first = commitLocal(f, preview);
  await statusEntered;
  await assert.rejects(commitLocal(f, preview), /正在进行/);
  releaseStatus();
  assert.equal((await first).success, true);
  assert.equal(f.requests.filter(r => r.endpoint === '/emails/migrate_google_auth').length, 1);
});

test('云端返回未知状态或缺少CAS令牌时禁止本机密钥读取和上传', async () => {
  const unknown = fixture({ status: 'test-unknown-state' });
  await assert.rejects(prepare(unknown), /无法确认/);
  assert.equal(unknown.localReadCount, 0);
  const missingToken = fixture();
  missingToken.setToken('');
  await assert.rejects(prepare(missingToken), /不支持安全迁移/);
  assert.equal(missingToken.localReadCount, 0);
});

test('验证码核验时系统时间跳变或等待异常不能清理本机副本', async () => {
  for (const delta of [-1, 60_001]) {
    const f = fixture({ onVerify: ({ advance }) => advance(delta) });
    const result = await commitLocal(f, await prepare(f));
    assert.equal(result.success, false);
    assert.equal(result.uploaded, true);
    assert.equal(f.cleanupCount, 0);
  }
});
