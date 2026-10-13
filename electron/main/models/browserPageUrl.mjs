const TRANSIENT_RECOVERY_SCHEME =
  /^(?:about|blob|data|chrome|chrome-error|chrome-extension|devtools):/i;

/**
 * Chromium can display these pages during normal use, but their URL either embeds
 * process-local data or belongs to browser internals. They must not make an otherwise
 * valid cloud snapshot fail, and must never be reopened on another device.
 *
 * Empty/malformed strings are deliberately not classified as transient: protocol
 * parsers must still reject corrupted ordinary page records instead of hiding them.
 */
export const isTransientRecoveryPageUrl = value =>
  typeof value === 'string' && TRANSIENT_RECOVERY_SCHEME.test(value);

/**
 * Runtime collection only drops known process-local/internal pages. Any other non-empty
 * value is kept for the strict upload validator, so malformed HTTP(S) records still fail
 * closed instead of being silently hidden at collection time.
 */
export const shouldCollectRecoveryPageUrl = value =>
  typeof value === 'string' && value.length > 0 && !isTransientRecoveryPageUrl(value);

/** Only these schemes form durable, cross-device page targets. */
export const isRestorableBrowserPageUrl = value => {
  if (typeof value !== 'string' || !value || isTransientRecoveryPageUrl(value)) return false;
  try {
    return ['http:', 'https:', 'file:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
