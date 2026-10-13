// The user explicitly requested the current Mailcow certificate exception.
// TLS stays enabled. The exception is restricted to that exact configured host;
// public mail providers and other servers retain certificate validation.
export function resolveMailTlsOptions({ host, verifyCertificate }) {
  if (verifyCertificate !== undefined && typeof verifyCertificate !== 'boolean')
    throw new Error('邮件证书校验选项无效');
  if (verifyCertificate === false && String(host).toLowerCase() !== 'mail.outlook.top')
    throw new Error('此邮件服务器未配置证书校验例外');
  return { rejectUnauthorized: verifyCertificate !== false };
}
