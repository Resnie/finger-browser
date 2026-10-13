import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeSessionStorage,
  isTrustedSessionStorageCheckpoint,
} from '../electron/main/models/browserSessionStorage.mjs';

const source = fs.readFileSync(
  new URL('../electron/main/models/BrowserInstance.js', import.meta.url),
  'utf8'
);
const start = source.indexOf('\n  acceptSessionStorageCheckpoint(');
const end = source.indexOf('\n  syncSessionStorageTopology()', start);
const Instance = new Function(
  'normalizeSessionStorage',
  'isTrustedSessionStorageCheckpoint',
  `return class {${source.slice(start, end)}};`
)(normalizeSessionStorage, isTrustedSessionStorageCheckpoint);
const fixture = () => {
  const url = 'http://127.0.0.1:19093/';
  const frame = { url: () => url },
    page = { url: () => url, mainFrame: () => frame };
  const instance = new Instance();
  Object.assign(instance, {
    startupReady: true,
    isClosing: false,
    context: { pages: () => [page] },
    state: {
      sessionStorage: [
        {
          index: 0,
          url,
          origins: [
            { origin: 'http://127.0.0.1:19093', entries: [{ name: 'marker', value: 'retained' }] },
          ],
        },
      ],
    },
    _sessionStoragePageIndices: new Map([[page, 0]]),
    _sessionStorageByPage: new Map(),
    syncSessionStorageTopology() {
      this.state.sessionStorage = [];
    },
    markRecoveryChanged() {
      this.changed = true;
    },
  });
  return {
    instance,
    source: { page, frame },
    checkpoint: {
      url,
      origin: 'http://127.0.0.1:19093',
      entries: [{ name: 'marker', value: 'new-value' }],
    },
  };
};

test('late pagehide during manager close cannot erase the captured multi-tab snapshot', () => {
  const { instance, source, checkpoint } = fixture();
  instance.isClosing = true;
  instance.context = null;
  const saved = structuredClone(instance.state);
  instance.acceptSessionStorageCheckpoint(source, checkpoint);
  assert.deepEqual(instance.state, saved);
  assert.equal(instance.changed, undefined);
  assert.equal(instance._sessionStorageByPage.size, 0);
});

test('direct instance close also freezes the already captured tab snapshot', () => {
  const { instance, source, checkpoint } = fixture();
  instance.isClosing = true;
  const saved = structuredClone(instance.state);
  instance.acceptSessionStorageCheckpoint(source, checkpoint);
  assert.deepEqual(instance.state, saved);
  assert.equal(instance.changed, undefined);
});

test('a live trusted checkpoint still updates its own tab', () => {
  const { instance, source, checkpoint } = fixture();
  instance.acceptSessionStorageCheckpoint(source, checkpoint);
  assert.equal(
    instance._sessionStorageByPage.get(source.page).origins[0].entries[0].value,
    'new-value'
  );
  assert.equal(instance.changed, true);
});
