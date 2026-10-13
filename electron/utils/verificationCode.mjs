const htmlEntities = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

const decodeHtmlEntities = value =>
  value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, token) => {
    const normalized = token.toLowerCase();
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return htmlEntities[normalized] ?? entity;
  });

export const normalizeVerificationText = (subject, body) => {
  const decoded = decodeHtmlEntities(`${subject || ''}\n${body || ''}`);
  return decoded
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:br|div|p|li|tr|td|th|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const digitSeparator = '[\\s\\u00a0\\u200b-\\u200d\\u2060\\ufeff]*';
const sixDigits = `([0-9](?:${digitSeparator}[0-9]){5})`;
const notPartOfLongerNumber = `(?!${digitSeparator}[0-9])`;
const phrasePattern = new RegExp(
  `(?:验证码|驗證碼|校验码|動態碼|verification\\s*code|security\\s*code|one[-\\s]*time\\s*(?:password|code)|otp)[^0-9]{0,160}${sixDigits}${notPartOfLongerNumber}`,
  'i'
);
const fallbackPattern = new RegExp(`(?:^|[^0-9])${sixDigits}${notPartOfLongerNumber}`, 'i');
const verificationContextPattern =
  /验证码|驗證碼|校验码|校驗碼|动态码|動態碼|verification|security\s*code|one[-\s]*time|\botp\b|authentication\s*code|登录验证|登入驗證/i;

export const findVerificationCode = (subject, body) => {
  const searchableText = normalizeVerificationText(subject, body);
  const explicit = phrasePattern.exec(searchableText);
  // 普通账单/订单的六位编号不是验证码；回退扫描只用于已明确是验证邮件的内容。
  const fallback =
    !explicit && verificationContextPattern.test(searchableText)
      ? fallbackPattern.exec(searchableText)
      : null;
  if (fallback && /[0-9]$/.test(searchableText.slice(0, fallback.index).trimEnd())) return null;
  const result = explicit || fallback;
  if (!result) return null;
  const code = result[1].replace(/[^0-9]/g, '');
  return code.length === 6 ? code : null;
};
