import { safeStorage } from 'electron';
import Store from 'electron-store';
import {
  BROWSER_RECOVERY_OUTBOX_MAX_PAYLOAD_BYTES,
  BROWSER_RECOVERY_OUTBOX_VERSION,
  BrowserRecoveryEmergencySentinel as BrowserRecoveryEmergencySentinelCore,
  BrowserRecoveryOutbox as BrowserRecoveryOutboxCore,
  areRecoverySnapshotsEquivalent,
  decideRecoveryOutboxReplay,
  normalizeRecoveryOwnerId,
  shouldClearRecoveryOutbox,
  validateRecoveryReplayRevision,
} from './browserRecoveryOutbox.mjs';

export {
  BROWSER_RECOVERY_OUTBOX_MAX_PAYLOAD_BYTES,
  BROWSER_RECOVERY_OUTBOX_VERSION,
  areRecoverySnapshotsEquivalent,
  decideRecoveryOutboxReplay,
  normalizeRecoveryOwnerId,
  shouldClearRecoveryOutbox,
  validateRecoveryReplayRevision,
};

/** Electron production adapter; tests inject deterministic store/crypto into the core module. */
export class BrowserRecoveryOutbox extends BrowserRecoveryOutboxCore {
  constructor(options = {}) {
    super({
      StoreClass: Store,
      safeStorageAdapter: safeStorage,
      ...options,
    });
  }
}

export class BrowserRecoveryEmergencySentinel extends BrowserRecoveryEmergencySentinelCore {
  constructor(options = {}) {
    super({ StoreClass: Store, ...options });
  }
}

import { BrowserRuntimeLeaseTokens as RuntimeTokensCore } from './browserRuntimeLeaseTokens.mjs';
export class BrowserRuntimeLeaseTokens extends RuntimeTokensCore {
  constructor(options = {}) { super({ StoreClass: Store, safeStorageAdapter: safeStorage, ...options }); }
}
