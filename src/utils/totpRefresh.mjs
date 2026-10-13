export const TOTP_PERIOD_MS = 30_000;

const normalizeTimestamp = timestamp => {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value < 0) throw new RangeError('时间戳必须是非负有限数');
  return value;
};

export const getTOTPWindow = timestamp =>
  Math.floor(normalizeTimestamp(timestamp) / TOTP_PERIOD_MS);

export const getTOTPRemainingSeconds = timestamp => {
  const value = normalizeTimestamp(timestamp);
  const elapsed = value % TOTP_PERIOD_MS;
  return Math.max(1, Math.ceil((TOTP_PERIOD_MS - elapsed) / 1000));
};

export const didTOTPWindowChange = (previousWindow, timestamp) =>
  Number.isInteger(previousWindow) && getTOTPWindow(timestamp) !== previousWindow;
