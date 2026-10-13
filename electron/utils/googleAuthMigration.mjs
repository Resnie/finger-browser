import { randomUUID } from 'node:crypto';
import { buildGoogleAuthCloudValue, normalizeGoogleAuthSecret } from './googleAuthProtocol.mjs';
import { decodeBase32, generateTotpToken } from './totp.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIGRATABLE_STATUSES = new Set(['not_configured', 'legacy_rsa', 'invalid']);
const TICKET_LIFETIME_MS = 5 * 60 * 1000;

const normalizeMigrationSecret = value => {
  const secret = normalizeGoogleAuthSecret(value);
  const bytes = decodeBase32(secret);
  if (secret.length < 16 || secret.length > 256 || bytes.length < 10 || bytes.length > 128) {
    throw new Error('谷歌密钥格式无效，请重新输入有效的 Base32 密钥');
  }
  return secret;
};

const parseCloudStatus = (value, uuid) => {
  if (
    !value ||
    typeof value.uuid !== 'string' ||
    value.uuid.toLowerCase() !== uuid ||
    typeof value.email !== 'string' ||
    !value.email.trim() ||
    value.email.length > 320
  ) {
    throw new Error('云端账号状态无效，请重新打开迁移窗口');
  }
  const status = value.googleAuthStatus;
  if (status !== 'ready' && !MIGRATABLE_STATUSES.has(status)) {
    throw new Error('无法确认云端谷歌密钥状态，请稍后重试');
  }
  if (status !== 'ready' && !/^[a-f0-9]{64}$/i.test(value.migrationToken || '')) {
    throw new Error('当前后端尚不支持安全迁移，请升级后端后再试');
  }
  return {
    uuid,
    email: value.email,
    status,
    migrationToken: value.migrationToken || '',
  };
};

/**
 * 所有历史密钥读取、解密和上传均留在主进程。renderer 只获得可展示的状态
 * 和短期票据；票据绑定发起窗口与登录会话，不是可以直接上传的云端 CAS 令牌。
 */
export const createGoogleAuthMigration = ({
  post,
  readLocalEntry,
  decryptLocalEntry,
  deleteLocalEntryIfUnchanged,
  now = Date.now,
  createTicket = randomUUID,
}) => {
  const tickets = new Map();

  const getSession = session => {
    if (!session || typeof session.token !== 'string' || !session.token || !session.senderId) {
      throw new Error('登录状态已失效，请重新登录');
    }
    return session;
  };

  const fetchCloudStatus = async (uuid, session) =>
    parseCloudStatus(await post('/emails/google_auth_migration_status', { uuid }, session), uuid);

  const prepare = async (input, suppliedSession) => {
    const session = getSession(suppliedSession);
    const uuid = typeof input?.uuid === 'string' ? input.uuid.trim().toLowerCase() : '';
    if (!UUID_PATTERN.test(uuid)) throw new Error('账号 UUID 格式无效');
    const cloud = await fetchCloudStatus(uuid, session);
    if (cloud.status === 'ready') {
      return { status: 'ready', email: cloud.email, message: '云端谷歌密钥已可用，无需迁移' };
    }

    const identity = { uuid, email: cloud.email };
    const localEntry = readLocalEntry(identity);
    let localStatus = localEntry ? 'available' : 'missing';
    if (localEntry) {
      try {
        normalizeMigrationSecret(decryptLocalEntry(localEntry));
      } catch {
        localStatus = 'unreadable';
      }
    }
    for (const [ticket, record] of tickets) {
      if (record.expiresAt <= now()) tickets.delete(ticket);
    }
    if (tickets.size >= 100) tickets.delete(tickets.keys().next().value);
    const ticket = createTicket();
    tickets.set(ticket, {
      ...cloud,
      identity,
      token: session.token,
      senderId: session.senderId,
      localEntry,
      localStatus,
      expiresAt: now() + TICKET_LIFETIME_MS,
    });
    return {
      ticket,
      status: cloud.status,
      email: cloud.email,
      localStatus,
      localSource: localEntry?.startsWith('v2:') ? 'safe_storage' : 'legacy_rsa',
      message:
        localStatus === 'unreadable'
          ? '本机旧密钥无法解密，请重新输入谷歌密钥；也可在原电脑打开本应用迁移'
          : localStatus === 'missing'
            ? '本机没有旧密钥，请重新输入谷歌密钥'
            : '确认后将本机旧密钥加密保存到云端，并验证服务端验证码',
    };
  };

  const commit = async (input, suppliedSession) => {
    const session = getSession(suppliedSession);
    if (input?.confirmed !== true) throw new Error('请先确认迁移谷歌密钥');
    const record = tickets.get(input.ticket);
    if (!record || record.expiresAt <= now()) {
      tickets.delete(input.ticket);
      throw new Error('迁移确认已过期，请重新打开迁移窗口');
    }
    if (record.token !== session.token || record.senderId !== session.senderId) {
      throw new Error('登录会话已变化，请重新打开迁移窗口');
    }
    // 点击或IPC并发重入只能产生一次确认流程。
    if (record.inFlight) throw new Error('迁移正在进行，请稍候');
    record.inFlight = true;

    try {
      // 确认后重新读云端状态。真正的并发保护由服务端条件更新完成，
      // 二次查询不会替代 CAS，也不会降级到普通账号编辑接口。
      const cloud = await fetchCloudStatus(record.uuid, session);
      if (cloud.status === 'ready') {
        tickets.delete(input.ticket);
        throw new Error('云端谷歌密钥已可用，已停止迁移以保留云端密钥');
      }
      if (cloud.migrationToken !== record.migrationToken || cloud.email !== record.email) {
        tickets.delete(input.ticket);
        throw new Error('云端账号已变化，请重新打开迁移窗口');
      }

      let secret;
      if (input.source === 'manual') {
        secret = normalizeMigrationSecret(input.secret);
      } else if (input.source === 'local') {
        if (record.localStatus !== 'available') throw new Error('本机旧密钥无法使用，请重新输入');
        const currentEntry = readLocalEntry(record.identity);
        if (currentEntry !== record.localEntry) {
          throw new Error('本机谷歌密钥已变化，请重新打开迁移窗口');
        }
        try {
          secret = normalizeMigrationSecret(decryptLocalEntry(currentEntry));
        } catch {
          throw new Error('本机旧密钥无法解密，请重新输入谷歌密钥');
        }
      } else {
        throw new Error('请选择迁移方式');
      }

      // 一个明确确认只进行一次条件上传，失败时保留本机旧密钥。
      tickets.delete(input.ticket);
      await post(
        '/emails/migrate_google_auth',
        {
          uuid: record.uuid,
          migrationToken: record.migrationToken,
          googleAuth: buildGoogleAuthCloudValue(secret),
        },
        session
      );

      let verifiedCode;
      try {
        const startedAt = now();
        const response = await post('/emails/google_auth_code', { uuid: record.uuid }, session);
        const finishedAt = now();
        const code = String(response?.code || '');
        // 请求期间可能跨越 30 秒边界，允许一周期时钟偏差，但拒绝明显异常
        // 的等待区间；只比较主进程中的验证码，不将旧密钥回传到 renderer。
        if (finishedAt < startedAt || finishedAt - startedAt > 60_000 || !/^\d{6}$/.test(code)) {
          throw new Error('验证失败');
        }
        const counters = [];
        for (
          let counter = Math.floor(startedAt / 30_000) - 1;
          counter <= Math.floor(finishedAt / 30_000) + 1;
          counter += 1
        ) {
          counters.push(counter);
        }
        if (
          !counters.some(
            counter =>
              counter >= 0 && generateTotpToken(secret, { timestamp: counter * 30_000 }) === code
          )
        ) {
          throw new Error('验证失败');
        }
        verifiedCode = code;
      } catch {
        return {
          success: false,
          uploaded: true,
          message:
            '密钥已保存到云端，但验证码尚未验证通过；已保留本机旧密钥，请检查系统时间并重新读取谷歌码',
        };
      }

      let localCleanupFailed = false;
      try {
        if (record.localEntry) deleteLocalEntryIfUnchanged(record.identity, record.localEntry);
      } catch {
        localCleanupFailed = true;
      }
      return {
        success: true,
        code: verifiedCode,
        status: 'ready',
        message: localCleanupFailed
          ? '云端密钥与验证码已验证通过；本机旧副本清理失败，可稍后重试'
          : '云端密钥与验证码已验证通过，换电脑登录后可直接使用',
      };
    } finally {
      record.inFlight = false;
    }
  };

  return { prepare, commit };
};
