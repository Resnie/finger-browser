// 真实服务专项验收。只写本地 test 用户/数据库，最多注册一个固定 test- 邮箱。
// 客户端仅为配置的 Mailcow 主机应用证书例外；验收代理的上游例外也需显式选项。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getEmailServerConfig } from '../src/constants/email.js';
import { createCertificate, loadProductionEmail, makeMime } from './email-protocol-acceptance.mjs';
import {
  assertAcceptanceDirectory,
  assertExpectedTestMailbox,
  planMailboxCreation,
  validateAcceptanceDirectoryLocation,
} from './mail-real-acceptance-guard.mjs';

const thisFile = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const options = {
  api: arg('--api', 'http://127.0.0.1:8889/api/v1'),
  username: arg('--username', 'test-acceptance-20261012'),
  create: args.includes('--create-one-test-mailbox'),
  certificateException: args.includes('--allow-configured-mail-certificate-errors'),
  // 只记录验收授权选择；是否准许HTTP请求由隔离Go测试入口的exact-endpoint门禁决定。
  httpCredentialsException: args.includes('--allow-configured-http-credentials-test'),
  explicitRetry: args.includes('--retry-confirmed-not-created'),
};

async function startTLSProxy(certificates, target, allowInsecure, allowedHosts) {
  if (!allowedHosts.has(target.host)) throw new Error('邮件验收代理拒绝未配置的主机');
  const sockets = new Set();
  const server = tls.createServer(
    { key: fs.readFileSync(certificates.key), cert: fs.readFileSync(certificates.cert) },
    incoming => {
      const outgoing = tls.connect({
        host: target.host,
        port: target.port,
        servername: target.host,
        rejectUnauthorized: !allowInsecure,
      });
      sockets.add(incoming);
      sockets.add(outgoing);
      incoming.on('error', () => outgoing.destroy());
      outgoing.on('error', () => incoming.destroy());
      incoming.once('close', () => {
        sockets.delete(incoming);
        outgoing.destroy();
      });
      outgoing.once('close', () => {
        sockets.delete(outgoing);
        incoming.destroy();
      });
      outgoing.once('secureConnect', () => {
        incoming.pipe(outgoing);
        outgoing.pipe(incoming);
      });
      incoming.setTimeout(30000, () => incoming.destroy());
      outgoing.setTimeout(30000, () => outgoing.destroy());
    }
  );
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function sendSelfMail(port, credentials) {
  const socket = tls.connect({
    host: 'localhost',
    port,
    servername: 'localhost',
    rejectUnauthorized: true,
  });
  let buffer = '';
  const pending = [];
  const replies = [];
  let replyLines = [];
  const fail = error => {
    for (const item of pending.splice(0)) item.reject(error);
    socket.destroy();
  };
  socket.setTimeout(20000, () => fail(new Error('SMTP 响应超时')));
  socket.on('error', fail);
  socket.once('close', () => {
    if (pending.length) fail(new Error('SMTP 连接中断'));
  });
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      replyLines.push(line);
      if (!/^\d{3} /.test(line)) continue;
      const reply = { code: Number(line.slice(0, 3)), lines: replyLines };
      replyLines = [];
      const waiter = pending.shift();
      waiter ? waiter.resolve(reply) : replies.push(reply);
    }
  });
  const nextReply = () =>
    replies.length
      ? Promise.resolve(replies.shift())
      : new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const command = async (value, expected) => {
    if (value) socket.write(value + '\r\n');
    const reply = await nextReply();
    if (reply.code !== expected) throw new Error(`SMTP 返回 ${reply.code}`);
    return reply;
  };
  try {
    await command('', 220);
    await command('EHLO test-finger-browser', 250);
    await command('AUTH LOGIN', 334);
    await command(Buffer.from(credentials.email).toString('base64'), 334);
    await command(Buffer.from(credentials.password).toString('base64'), 235);
    await command(`MAIL FROM:<${credentials.email}>`, 250);
    await command(`RCPT TO:<${credentials.email}>`, 250);
    await command('DATA', 354);
    const raw = makeMime({ code: '021019', uid: `real-${Date.now()}` })
      .toString('utf8')
      .replace('Binance <test-binance@example.test>', `<${credentials.email}>`)
      .replace('test-mail@example.test', credentials.email);
    socket.write(raw.replace(/^\./gm, '..') + '.\r\n');
    await command('', 250);
    await command('QUIT', 221);
  } finally {
    socket.destroy();
  }
}

async function runReal(dir) {
  dir = assertAcceptanceDirectory(dir);
  const settings = {};
  const env = fs.readFileSync(new URL('../../gin-gorm-api-service/.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const match = line.match(/^\s*(MAIL_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) settings[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const base = new URL(options.api);
  if (
    base.protocol !== 'http:' ||
    base.hostname !== '127.0.0.1' ||
    base.port !== '8889' ||
    base.pathname !== '/api/v1'
  )
    throw new Error('仅允许隔离本地8889 API');
  if (!options.username.startsWith('test-')) throw new Error('仅允许 test- 用户');
  const accountPassword = process.env.TEST_LOGIN_PASSWORD;
  if (!accountPassword) throw new Error('缺少 TEST_LOGIN_PASSWORD');
  let token;
  const request = async (endpoint, data) => {
    const response = await fetch(base.href + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      const failure = {
        endpoint,
        status: response.status,
        code: payload.code,
        message: payload.message,
      };
      fs.writeFileSync(path.join(dir, 'api-failure.json'), JSON.stringify(failure), {
        mode: 0o600,
      });
      throw new Error(
        `本地 API ${endpoint} 验收失败，HTTP ${response.status} / code ${payload.code}；错误详情仅保存在受限临时文件`
      );
    }
    return payload.data;
  };
  const login = await request('/users/login', {
    username: options.username,
    password: crypto.createHash('md5').update(accountPassword).digest('hex'),
  });
  token = login.token;
  if (!token) throw new Error('测试登录未返回 token');
  const domain = settings.MAIL_DOMAIN;
  if (!domain || !settings.MAIL_API_URL || !settings.MAIL_API_KEY)
    throw new Error('Mailcow配置不完整');
  const localPart = 'test-mail-real-20261012';
  const expectedEmail = `${localPart}@${domain}`;
  const rows = await request('/emails/search', { apiName: localPart, pageSize: 20, current: 1 });
  const existing = rows.apikeyList?.find(item => item.email === expectedEmail);
  const marker = path.join(dir, 'create-attempt.json');
  // 跨工作目录保留成功记录；更换目录不会变成另一次注册许可。
  const recordDirectory = path.join(os.tmpdir(), 'test-mail-real-records');
  if (!fs.existsSync(recordDirectory)) fs.mkdirSync(recordDirectory, { mode: 0o700 });
  assertAcceptanceDirectory(recordDirectory);
  const recordPath = path.join(
    recordDirectory,
    crypto.createHash('sha256').update(expectedEmail).digest('hex') + '.json'
  );
  const records = [marker, recordPath]
    .filter(file => fs.existsSync(file))
    .map(file => {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
      )
        throw new Error('创建记录必须是0600普通文件');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    });
  const plan = planMailboxCreation(records, {
    existingAccountFound: Boolean(existing),
    explicitRetry: options.explicitRetry,
    expectedEmail,
  });
  const writeRecord = record => {
    for (const file of [marker, recordPath])
      fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  };
  let credentials;
  if (plan.mode === 'reuse') {
    const detail = await request('/emails/detail', { uuid: existing.uuid });
    credentials = {
      uuid: existing.uuid,
      email: detail.email,
      password: detail.mailPassword,
      reused: true,
    };
  } else {
    if (!options.create) throw new Error('缺少显式 --create-one-test-mailbox，未创建邮箱');
    const record = {
      email: expectedEmail,
      localPart,
      owner: options.username,
      attempt: plan.attempt,
      attemptedAt: new Date().toISOString(),
      state: 'attempting',
    };
    writeRecord(record);
    try {
      const created = await request('/emails/create_mailbox', { localPart, count: 1, groupId: 0 });
      if (!Array.isArray(created) || created.length !== 1)
        throw new Error('邮箱创建返回不符合单一 test- 账号要求');
      credentials = assertExpectedTestMailbox(created[0], expectedEmail);
      fs.writeFileSync(path.join(dir, 'mailbox-credentials.json'), JSON.stringify(credentials), {
        mode: 0o600,
      });
      writeRecord({
        ...record,
        state: 'succeeded',
        localSaved: Boolean(credentials.saved),
        credentialsFile: path.join(dir, 'mailbox-credentials.json'),
      });
      if (!credentials.saved)
        throw new Error('测试邮箱已创建，凭据已保留，但未保存到本地账号；禁止重复注册');
    } catch (error) {
      if (!credentials) writeRecord({ ...record, state: 'failed' });
      throw error;
    }
  }
  assertExpectedTestMailbox(credentials, expectedEmail);
  const restoredDetail = await request('/emails/detail', { uuid: credentials.uuid });
  const restoredCredentials = assertExpectedTestMailbox(
    { email: restoredDetail.email, password: restoredDetail.mailPassword },
    expectedEmail
  );
  if (restoredCredentials.password !== credentials.password)
    throw new Error('本地服务端解密后的邮箱凭据与注册结果不一致');
  fs.writeFileSync(path.join(dir, 'mailbox-credentials.json'), JSON.stringify(credentials), {
    mode: 0o600,
  });
  const imapConfig = getEmailServerConfig(credentials.email, 'imap');
  const popConfig = getEmailServerConfig(credentials.email, 'pop3');
  const smtpConfig = { host: imapConfig.host, port: 465 };
  const allowedHosts = new Set([imapConfig.host, popConfig.host, smtpConfig.host]);
  const certs = { key: path.join(dir, 'trusted.key'), cert: path.join(dir, 'trusted.pem') };
  const imap = await startTLSProxy(certs, imapConfig, options.certificateException, allowedHosts);
  const pop = await startTLSProxy(certs, popConfig, options.certificateException, allowedHosts);
  const smtp = await startTLSProxy(certs, smtpConfig, options.certificateException, allowedHosts);
  const evidence = {
    registered: !credentials.reused,
    localAccountSaved: true,
    cloudPasswordRestored: true,
    certificateException: options.certificateException,
    httpCredentialsException: options.httpCredentialsException,
    credentialsFile: path.join(dir, 'mailbox-credentials.json'),
  };
  const mailDiagnostics = [];
  const { api } = await loadProductionEmail(path.join(dir, 'device-a'), message =>
    mailDiagnostics.push(
      String(message)
        .replaceAll(credentials.email, '[test-mailbox]')
        .replaceAll(credentials.password, '[redacted]')
    )
  );
  const connect = port => ({
    email: credentials.email,
    password: credentials.password,
    host: 'localhost',
    port,
    tls: true,
  });
  try {
    try {
      await sendSelfMail(smtp.port, credentials);
      evidence.selfTestMailSent = true;
    } catch (error) {
      evidence.selfTestMailSent = false;
      evidence.smtpError = error.message;
    }
    try {
      evidence.imap = await api.fetchEmailsViaImap(connect(imap.port));
      for (
        let attempt = 0;
        attempt < 6 &&
        !api.extractVerificationCode({ email: credentials.email }).success &&
        evidence.selfTestMailSent;
        attempt++
      ) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        evidence.imap = await api.fetchEmailsViaImap(connect(imap.port));
      }
      const result = api.extractVerificationCode({ email: credentials.email });
      evidence.realCodeMatched = result.success && result.code === '021019';
      evidence.cacheCount = api.listLocalEmailCache(credentials.email).length;
      const deviceB = await loadProductionEmail(path.join(dir, 'device-b'));
      evidence.freshDevice = await deviceB.api.fetchEmailsViaImap(connect(imap.port));
      evidence.freshDeviceCodeMatched =
        deviceB.api.extractVerificationCode({ email: credentials.email }).code === '021019';
    } catch (error) {
      evidence.imapError = error.message.replaceAll(credentials.email, '[test-mailbox]');
    }
    try {
      evidence.pop3 = await api.fetchEmailsViaPop3(connect(pop.port));
    } catch (error) {
      evidence.pop3Error = error.message.replaceAll(credentials.email, '[test-mailbox]');
    }
  } finally {
    fs.writeFileSync(
      path.join(dir, 'mail-diagnostics.json'),
      JSON.stringify(mailDiagnostics, null, 2),
      { mode: 0o600 }
    );
    await Promise.all([imap.close(), pop.close(), smtp.close()]);
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2), {
      mode: 0o600,
    });
    console.log(JSON.stringify(evidence));
  }
  if (!evidence.realCodeMatched || !evidence.freshDeviceCodeMatched || !evidence.pop3?.success)
    process.exitCode = 1;
}

if (args.includes('--worker')) {
  await runReal(arg('--workdir'));
} else {
  const dir = arg('--workdir') || fs.mkdtempSync(path.join(os.tmpdir(), 'test-mail-real-'));
  validateAcceptanceDirectoryLocation(dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  assertAcceptanceDirectory(dir);
  const cert = createCertificate(dir, 'trusted');
  console.log(JSON.stringify({ evidenceDirectory: dir }));
  const result = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', thisFile, ...args, '--worker', '--workdir', dir],
    {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert.ca },
      stdio: 'inherit',
      timeout: 150000,
    }
  );
  process.exitCode = result.status ?? 1;
}
