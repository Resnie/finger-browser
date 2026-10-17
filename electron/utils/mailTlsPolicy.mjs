// Mailcow now serves a valid public certificate. All mail connections must
// validate certificates, including requests from older renderer code.
export function resolveMailTlsOptions({ host, verifyCertificate }) {
  if (verifyCertificate !== undefined && typeof verifyCertificate !== 'boolean')
    throw new Error('邮件证书校验选项无效');
  if (verifyCertificate === false)
    throw new Error('邮件连接必须校验证书，请修复服务器证书后重试');
  return { rejectUnauthorized: true };
}
