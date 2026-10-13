// 只读检查已保存 Mailcow 配置及证书，不注册邮箱、不发送密码/API Key。
import fs from 'node:fs';
import tls from 'node:tls';
import https from 'node:https';
import { getEmailServerConfig } from '../src/constants/email.js';

const contents = fs.readFileSync(
  new URL('../../gin-gorm-api-service/.env', import.meta.url),
  'utf8'
);
const settings = {};
const certificateException = process.argv.includes('--allow-configured-mail-certificate-errors');
for (const line of contents.split('\n')) {
  const match = line.match(/^\s*(MAIL_[A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (match) settings[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
}

const probe = (host, port) =>
  new Promise(resolve => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: !certificateException,
    });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(10000, () => finish({ verified: false, reason: 'TIMEOUT' }));
    socket.once('secureConnect', () =>
      finish({
        connected: true,
        verified: socket.authorized,
        reason: socket.authorizationError || undefined,
        protocol: socket.getProtocol(),
      })
    );
    socket.once('error', error => finish({ verified: false, reason: error.code || 'TLS_ERROR' }));
  });

const configPresent = ['MAIL_API_URL', 'MAIL_API_KEY', 'MAIL_DOMAIN'].every(key =>
  Boolean(settings[key])
);
console.log(
  JSON.stringify({
    configPresent,
    mailboxCreationEnabled: /^true$/i.test(settings.MAILBOX_CREATION_ENABLED || ''),
  })
);
if (!configPresent) process.exitCode = 1;
else {
  const api = new URL(settings.MAIL_API_URL);
  console.log(JSON.stringify({ apiHTTPSConfigured: api.protocol === 'https:' }));
  const imap = getEmailServerConfig(`test-probe@${settings.MAIL_DOMAIN}`, 'imap');
  const pop3 = getEmailServerConfig(`test-probe@${settings.MAIL_DOMAIN}`, 'pop3');
  const results = await Promise.all([
    // 即使原配置使用 HTTP，也只读检查标准 HTTPS 端口，不携带原始 URL/密钥。
    probe(api.hostname, api.protocol === 'https:' ? Number(api.port) || 443 : 443),
    probe(imap.host, imap.port),
    probe(pop3.host, pop3.port),
  ]);
  console.log(JSON.stringify({ apiTLS: results[0], imapTLS: results[1], pop3TLS: results[2] }));
  if (certificateException) {
    const apiProbe = await new Promise(resolve => {
      const req = https.request(
        {
          hostname: api.hostname,
          port: 443,
          path: '/api/v1/add/mailbox',
          method: 'GET',
          rejectUnauthorized: false,
        },
        response => {
          response.resume();
          resolve({ status: response.statusCode, contentType: response.headers['content-type'] });
        }
      );
      req.setTimeout(10000, () => {
        req.destroy();
        resolve({ reason: 'TIMEOUT' });
      });
      req.once('error', error => resolve({ reason: error.code || 'REQUEST_ERROR' }));
      req.end();
    });
    console.log(JSON.stringify({ certificateException, noCredentialsAPIProbe: apiProbe }));
  }
  if (results.some(result => !result.verified)) process.exitCode = 1;
}
