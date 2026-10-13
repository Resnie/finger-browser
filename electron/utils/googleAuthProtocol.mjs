import { decodeBase32 } from './totp.mjs';

export const GOOGLE_AUTH_CLOUD_VERSION = 1;
export const GOOGLE_AUTH_MARKER_PREFIX = 'totp:v1:';
export const MAX_GOOGLE_AUTH_SECRET_LENGTH = 8192;

export const normalizeGoogleAuthSecret = secret => {
  if (
    typeof secret !== 'string' ||
    !secret.trim() ||
    secret.length > MAX_GOOGLE_AUTH_SECRET_LENGTH
  ) {
    throw new Error('Google Auth 密钥格式无效');
  }
  const normalized = secret
    .replace(/[\s-]+/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();
  decodeBase32(normalized);
  return normalized;
};

export const buildGoogleAuthCloudValue = secret =>
  `${GOOGLE_AUTH_MARKER_PREFIX}${normalizeGoogleAuthSecret(secret)}`;

export const normalizeGoogleAuthPreparationOptions = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      isGoAuthCloud: value.isGoAuthCloud === true || Number(value.isGoAuthCloud) === 1,
      cloudRecoveryVersion:
        Number.isSafeInteger(Number(value.cloudRecoveryVersion)) &&
        Number(value.cloudRecoveryVersion) >= GOOGLE_AUTH_CLOUD_VERSION
          ? GOOGLE_AUTH_CLOUD_VERSION
          : 0,
      cloudRecoveryCapabilityKnown: value.cloudRecoveryCapabilityKnown !== false,
    };
  }
  return {
    isGoAuthCloud: value === true || Number(value) === 1,
    cloudRecoveryVersion: 0,
    cloudRecoveryCapabilityKnown: true,
  };
};
