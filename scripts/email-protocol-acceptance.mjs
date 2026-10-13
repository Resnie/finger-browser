// 使用真实 imap/node-pop3/mailparser 库和实际 TLS 套接字验收生产邮箱同步逻辑。
// 仅 Electron 的本地目录、store、通知依赖被隔离；测试 CA/密钥在临时目录生成并清理。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import vm from 'node:vm';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(thisFile), '..');

export function createCertificate(dir, prefix) {
  const caKey = path.join(dir, `${prefix}-ca.key`);
  const ca = path.join(dir, `${prefix}-ca.pem`);
  const key = path.join(dir, `${prefix}.key`);
  const csr = path.join(dir, `${prefix}.csr`);
  const cert = path.join(dir, `${prefix}.pem`);
  const extensions = path.join(dir, `${prefix}.ext`);
  fs.writeFileSync(extensions, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 });
  const openssl = args => execFileSync('openssl', args, { stdio: 'ignore' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    ca,
    '-days',
    '1',
    '-subj',
    `/CN=test-mail-${prefix}-CA`,
  ]);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    csr,
    '-subj',
    '/CN=localhost',
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    ca,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    cert,
    '-days',
    '1',
    '-extfile',
    extensions,
  ]);
  for (const file of [caKey, key, csr, cert, ca]) fs.chmodSync(file, 0o600);
  return { key, cert, ca };
}

export async function loadProductionEmail(dataDir, onLog = () => {}) {
  const values = new Map();
  const events = [];
  const context = vm.createContext({ Buffer, console, process, setTimeout, clearTimeout });
  const store = {
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    set: (key, value) => values.set(key, value),
    delete: key => values.delete(key),
  };
  const logger = { info() {}, warn: message => onLog(message), error: message => onLog(message) };
  const stubs = {
    './config.js': {
      getProjectBasePath: () => dataDir,
      ensureDir: dir => {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
      },
    },
    './googleAuth.js': { rsaEncrypt: value => value },
    './store.js': { default: store },
    './logger.js': { logger: { createContextLogger: () => logger } },
    '../main/ipc/emitter.js': {
      ipcEmitter: { send: (channel, data) => events.push({ channel, data }) },
    },
    electron: { dialog: {} },
  };
  const cache = new Map();
  const synthetic = (key, exports) => {
    const module = new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context, identifier: key }
    );
    cache.set(key, module);
    return module;
  };
  const linker = async (specifier, source) => {
    if (stubs[specifier]) return cache.get(specifier) || synthetic(specifier, stubs[specifier]);
    if (!specifier.startsWith('.')) {
      return cache.get(specifier) || synthetic(specifier, await import(specifier));
    }
    const target = new URL(specifier, source.identifier);
    if (cache.has(target.href)) return cache.get(target.href);
    const module = new vm.SourceTextModule(fs.readFileSync(target, 'utf8'), {
      context,
      identifier: target.href,
    });
    cache.set(target.href, module);
    await module.link(linker);
    return module;
  };
  const url = pathToFileURL(path.join(root, 'electron/utils/email.js'));
  const module = new vm.SourceTextModule(fs.readFileSync(url, 'utf8'), {
    context,
    identifier: url.href,
  });
  await module.link(linker);
  await module.evaluate();
  return { api: module.namespace, values, events };
}

export function makeMime({ code, old = false, uid }) {
  const subject = '【币安】绑定谷歌验证码';
  const body = `<html><body><p>将谷歌双重身份验证(2FA)绑定到您的账户</p><p>您的验&#35777;码：</p><b>${[...code].map(digit => `<span>${digit}</span>`).join('')}</b></body></html>`;
  const date = new Date(Date.now() - (old ? 2 * 60 * 60 * 1000 : 0)).toUTCString();
  return Buffer.from(
    [
      'From: Binance <test-binance@example.test>',
      'To: test-mail@example.test',
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `Date: ${date}`,
      `Message-ID: <test-${uid}@example.test>`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="test-boundary"',
      '',
      '--test-boundary',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      `Verification code: ${code}`,
      '--test-boundary',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body)
        .toString('base64')
        .match(/.{1,64}/g)
        .join('\r\n'),
      '--test-boundary--',
      '',
    ].join('\r\n')
  );
}

async function startServer(certificates, protocol, state) {
  const sockets = new Set();
  const server = tls.createServer(
    { key: fs.readFileSync(certificates.key), cert: fs.readFileSync(certificates.cert) },
    socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      socket.write(protocol === 'imap' ? '* OK test-mail ready\r\n' : '+OK test-mail ready\r\n');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (protocol === 'imap') {
            const [tag, command] = line.split(' ');
            if (process.env.TEST_MAIL_DEBUG) console.error('IMAP command', command);
            const ok = text => socket.write(`${tag} OK ${text}\r\n`);
            if (command === 'CAPABILITY')
              socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK capability\r\n`);
            else if (command === 'LOGIN') {
              state.loginCount++;
              line.includes('test-password')
                ? ok('authenticated')
                : socket.write(`${tag} NO wrong password\r\n`);
            } else if (command === 'LIST')
              socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK list\r\n`);
            else if (command === 'EXAMINE' || command === 'SELECT') {
              socket.write(
                `* FLAGS (\\Seen)\r\n* ${state.messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${state.validity}] valid\r\n* OK [UIDNEXT 999] next\r\n${tag} OK [READ-ONLY] selected\r\n`
              );
            } else if (command === 'UID' && / UID SEARCH /.test(` ${line} `)) {
              socket.write(
                `* SEARCH ${state.messages.map(item => item.uid).join(' ')}\r\n${tag} OK search\r\n`
              );
            } else if (command === 'UID' && / UID FETCH /.test(` ${line} `)) {
              if (state.dropFetch) {
                socket.destroy();
                continue;
              }
              const selected = new Set(line.split(' ')[3].split(',').map(Number));
              for (const [index, item] of state.messages.entries()) {
                if (!selected.has(item.uid)) continue;
                socket.write(
                  `* ${index + 1} FETCH (UID ${item.uid} FLAGS () INTERNALDATE "12-Oct-2026 00:00:00 +0000" BODY[] {${item.raw.length}}\r\n`
                );
                socket.write(item.raw);
                socket.write(')\r\n');
              }
              ok('fetch');
            } else if (command === 'LOGOUT') socket.end(`* BYE logout\r\n${tag} OK logout\r\n`);
            else ok('done');
          } else {
            const [command, argument] = line.split(' ');
            if (process.env.TEST_MAIL_DEBUG) console.error('POP3 command', command);
            if (command === 'USER') {
              state.loginCount++;
              socket.write('+OK user\r\n');
            } else if (command === 'PASS')
              socket.write(
                argument === 'test-password' ? '+OK authenticated\r\n' : '-ERR wrong password\r\n'
              );
            else if (command === 'UIDL')
              socket.write(
                `+OK uidl\r\n${state.messages.map((item, index) => `${index + 1} test-uid-${item.uid}\r\n`).join('')}.\r\n`
              );
            else if (command === 'RETR') {
              const item = state.messages[Number(argument) - 1];
              if (!item || state.failUid === item.uid) {
                socket.write('-ERR temporarily unavailable\r\n');
                continue;
              }
              socket.write('+OK message\r\n');
              socket.write(item.raw.toString('utf8').replace(/^\./gm, '..'));
              socket.write('.\r\n');
            } else if (command === 'QUIT') socket.end('+OK bye\r\n');
            else socket.write('+OK\r\n');
          }
        }
      });
    }
  );
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function runAcceptance(dir) {
  const certs = { key: path.join(dir, 'trusted.key'), cert: path.join(dir, 'trusted.pem') };
  const rejectedCerts = {
    key: path.join(dir, 'untrusted.key'),
    cert: path.join(dir, 'untrusted.pem'),
  };
  const state = {
    validity: 10,
    loginCount: 0,
    messages: [
      { uid: 1, raw: makeMime({ code: '021019', uid: 1 }) },
      { uid: 2, raw: makeMime({ code: '999999', uid: 2, old: true }) },
    ],
  };
  const { api } = await loadProductionEmail(path.join(dir, 'device-a'));
  const imap = await startServer(certs, 'imap', state);
  const pop3 = await startServer(certs, 'pop3', state);
  const invalid = await startServer(rejectedCerts, 'imap', state);
  const invalidPop3 = await startServer(rejectedCerts, 'pop3', state);
  const connection = port => ({
    email: 'test-mail@example.test',
    password: 'test-password',
    host: 'localhost',
    port,
    tls: true,
  });
  try {
    assert.equal((await api.fetchEmailsViaImap(connection(imap.port))).count, 2);
    assert.equal(api.extractVerificationCode({ email: 'test-mail@example.test' }).code, '021019');
    assert.equal((await api.fetchEmailsViaImap(connection(imap.port))).count, 0);
    const firstMail = api
      .listLocalEmailCache('test-mail@example.test')
      .find(item => item.uid === '1');
    fs.unlinkSync(firstMail.bodyPath);
    assert.equal(
      (await api.fetchEmailsViaImap(connection(imap.port))).count,
      1,
      '漏存的较小 UID 必须补齐'
    );
    state.messages.push({ uid: 3, raw: makeMime({ code: '654321', uid: 3 }) });
    assert.equal((await api.fetchEmailsViaImap(connection(imap.port))).count, 1);
    assert.equal(api.extractVerificationCode({ email: 'test-mail@example.test' }).code, '654321');
    state.validity++;
    state.messages = [{ uid: 1, raw: makeMime({ code: '123456', uid: 101 }) }];
    assert.equal(
      (await api.fetchEmailsViaImap(connection(imap.port))).count,
      1,
      'UIDVALIDITY 改变必须同步新 UID 1'
    );
    assert.equal(api.listLocalEmailCache('test-mail@example.test').length, 1);
    assert.equal(api.extractVerificationCode({ email: 'test-mail@example.test' }).code, '123456');
    state.messages.push({ uid: 2, raw: makeMime({ code: '234567', uid: 102 }) });
    state.dropFetch = true;
    await assert.rejects(api.fetchEmailsViaImap(connection(imap.port)), /连接/);
    state.dropFetch = false;
    const loginCount = state.loginCount;
    await assert.rejects(
      api.fetchEmailsViaImap({ ...connection(invalid.port), allowInvalidCert: true }),
      /certificate|issuer|self.signed/i
    );
    assert.equal(state.loginCount, loginCount, '无效 TLS 证书不得发送邮箱凭据');
    await assert.rejects(
      api.fetchEmailsViaPop3({ ...connection(invalidPop3.port), allowInvalidCert: true }),
      /certificate|issuer|self.signed/i
    );
    assert.equal(state.loginCount, loginCount, '无效 POP3 TLS 证书不得发送邮箱凭据');
    await assert.rejects(
      api.fetchEmailsViaImap({ ...connection(imap.port), password: 'wrong' }),
      /password/i
    );
    await assert.rejects(
      api.fetchEmailsViaPop3({ ...connection(pop3.port), password: 'x\r\nQUIT' }),
      /密码无效/
    );
    await assert.rejects(api.fetchEmailsViaPop3({ ...connection(pop3.port), tls: false }), /TLS/);

    const popConnection = { ...connection(pop3.port), email: 'test-pop@example.test' };
    state.failUid = 2;
    await assert.rejects(api.fetchEmailsViaPop3(popConnection), /1 封未能读取/);
    assert.equal(api.listLocalEmailCache(popConnection.email).length, 1, '部分成功邮件必须保留');
    delete state.failUid;
    assert.equal(
      (await api.fetchEmailsViaPop3(popConnection)).count,
      1,
      '失败邮件应重试，成功邮件不重复'
    );
    state.messages.reverse();
    assert.equal(
      (await api.fetchEmailsViaPop3(popConnection)).count,
      0,
      'POP3 消息序号变化不得重复下载'
    );
    assert.equal(api.extractVerificationCode({ email: popConnection.email }).code, '234567');
    const deviceB = await loadProductionEmail(path.join(dir, 'device-b'));
    assert.equal(
      (await deviceB.api.fetchEmailsViaImap(connection(imap.port))).count,
      2,
      '全新电脑应可从邮件服务器恢复缓存'
    );
    assert.equal(
      deviceB.api.extractVerificationCode({ email: 'test-mail@example.test' }).code,
      '234567'
    );
    console.log(
      JSON.stringify({
        success: true,
        tests: [
          'trusted-tls',
          'uid-1',
          'binance-mime-html',
          'fresh-code',
          'cache-hole-retry',
          'uidvalidity-reset',
          'early-disconnect',
          'invalid-tls-no-credentials',
          'wrong-password',
          'pop3-partial-retry',
          'pop3-uidl-stability',
          'fresh-device-resync',
          'reject-plaintext-and-command-injection',
        ],
      })
    );
  } finally {
    await Promise.all([imap.close(), pop3.close(), invalid.close(), invalidPop3.close()]);
  }
}

if (path.resolve(process.argv[1] || '') !== thisFile) {
  // 可供独立的真实邮件验收复用生产模块隔离器；导入时不启动任何服务。
} else if (process.argv[2] === '--worker') {
  await runAcceptance(process.argv[3]);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-mail-protocol-'));
  try {
    const trusted = createCertificate(dir, 'trusted');
    createCertificate(dir, 'untrusted');
    const result = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', thisFile, '--worker', dir],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted.ca },
        stdio: 'inherit',
        timeout: 90000,
      }
    );
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
