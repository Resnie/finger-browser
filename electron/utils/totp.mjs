import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const decodeBase32 = secret => {
  if (typeof secret !== 'string') throw new TypeError('TOTP 密钥必须为字符串');

  const normalized = secret
    .replace(/[\s-]+/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();
  if (!normalized || normalized.length > 8192 || /[^A-Z2-7]/.test(normalized)) {
    throw new Error('TOTP 密钥不是有效的 Base32');
  }

  const bytes = [];
  let accumulator = 0;
  let bitCount = 0;

  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >> bitCount) & 0xff);
      accumulator &= (1 << bitCount) - 1;
    }
  }

  if (bytes.length === 0) throw new Error('TOTP 密钥长度不足');
  return Buffer.from(bytes);
};

/**
 * 按 RFC 6238 生成时间型一次性密码。
 */
export const generateTotpToken = (
  secret,
  { timestamp = Date.now(), period = 30, digits = 6 } = {}
) => {
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('TOTP 时间无效');
  if (!Number.isInteger(period) || period <= 0) throw new Error('TOTP 周期无效');
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error('TOTP 位数必须为 6 至 8');
  }

  const counter = BigInt(Math.floor(timestamp / 1000 / period));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
};
