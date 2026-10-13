import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_STORAGE_STATE_LIMITS,
  normalizeBrowserStorageState,
} from '../electron/main/models/browserStorageState.mjs';

const createValidState = () => ({
  cookies: [
    {
      name: 'test-session',
      value: 'test-value',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      ignoredField: 'test-ignored',
    },
  ],
  origins: [
    {
      origin: 'http://127.0.0.1:43127',
      localStorage: [{ name: 'test-key', value: 'test-value', ignoredField: true }],
      ignoredField: 'test-ignored',
    },
  ],
  ignoredField: 'test-ignored',
});

test('合法 storageState 会复制为 Playwright 所需的最小结构', () => {
  const source = createValidState();
  const normalized = normalizeBrowserStorageState(source);

  assert.deepEqual(normalized, {
    cookies: [
      {
        name: 'test-session',
        value: 'test-value',
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [
      {
        origin: 'http://127.0.0.1:43127',
        localStorage: [{ name: 'test-key', value: 'test-value' }],
      },
    ],
  });
  assert.notEqual(normalized, source);
  assert.notEqual(normalized.cookies[0], source.cookies[0]);
  assert.notEqual(normalized.origins[0], source.origins[0]);

  source.cookies[0].value = 'test-mutated';
  source.origins[0].localStorage[0].value = 'test-mutated';
  assert.equal(normalized.cookies[0].value, 'test-value');
  assert.equal(normalized.origins[0].localStorage[0].value, 'test-value');
});

test('storageState 保留可恢复的 IndexedDB 库、store、index 和记录', () => {
  const source = createValidState();
  source.origins[0].indexedDB = [
    {
      name: 'test-db',
      version: 2,
      stores: [
        {
          name: 'test-store',
          autoIncrement: false,
          keyPath: 'id',
          records: [{ value: { id: 1, token: 'test-token' } }],
          indexes: [
            {
              name: 'test-index',
              keyPath: 'token',
              multiEntry: false,
              unique: true,
            },
          ],
        },
      ],
    },
  ];

  const normalized = normalizeBrowserStorageState(source);
  assert.deepEqual(normalized.origins[0].indexedDB, source.origins[0].indexedDB);
  assert.notEqual(normalized.origins[0].indexedDB, source.origins[0].indexedDB);

  const invalid = createValidState();
  invalid.origins[0].indexedDB = [{ name: 'test-db', version: 0, stores: [] }];
  assert.equal(normalizeBrowserStorageState(invalid), null);
});

test('非纯对象、缺少数组或子项类型异常时整体忽略', () => {
  class State {
    constructor() {
      this.cookies = [];
      this.origins = [];
    }
  }

  assert.equal(normalizeBrowserStorageState(null), null);
  assert.equal(normalizeBrowserStorageState(new State()), null);
  assert.equal(normalizeBrowserStorageState({ cookies: [], origins: {} }), null);
  assert.equal(normalizeBrowserStorageState({ cookies: [null], origins: [] }), null);
  assert.equal(
    normalizeBrowserStorageState({
      get cookies() {
        throw new Error('test-sensitive-content');
      },
      origins: [],
    }),
    null
  );
});

test('origin 必须是规范的 HTTP/HTTPS origin，不接受路径或重复项', () => {
  const invalidOrigins = [
    'file:///tmp/test-state',
    'ftp://example.com',
    'http://example.com/',
    'http://example.com/path',
    'HTTP://example.com',
    'http://example.com:80',
    ' http://example.com',
    'not-a-url',
  ];

  for (const origin of invalidOrigins) {
    assert.equal(
      normalizeBrowserStorageState({
        cookies: [],
        origins: [{ origin, localStorage: [] }],
      }),
      null,
      origin
    );
  }

  const state = createValidState();
  state.origins.push(structuredClone(state.origins[0]));
  assert.equal(normalizeBrowserStorageState(state), null);
});

test('超出 Cookie、origin、localStorage 条数或字符串上限时整体忽略', () => {
  const valid = createValidState();
  assert.equal(
    normalizeBrowserStorageState({
      cookies: new Array(BROWSER_STORAGE_STATE_LIMITS.cookies + 1).fill(valid.cookies[0]),
      origins: [],
    }),
    null
  );
  assert.equal(
    normalizeBrowserStorageState({
      cookies: [],
      origins: new Array(BROWSER_STORAGE_STATE_LIMITS.origins + 1).fill(valid.origins[0]),
    }),
    null
  );

  const tooManyLocalStorage = createValidState();
  tooManyLocalStorage.origins[0].localStorage = new Array(
    BROWSER_STORAGE_STATE_LIMITS.localStorageEntriesPerOrigin + 1
  ).fill({ name: 'test-key', value: 'test-value' });
  assert.equal(normalizeBrowserStorageState(tooManyLocalStorage), null);

  const tooLongCookie = createValidState();
  tooLongCookie.cookies[0].value = 'x'.repeat(BROWSER_STORAGE_STATE_LIMITS.cookieValueLength + 1);
  assert.equal(normalizeBrowserStorageState(tooLongCookie), null);

  const tooLongLocalStorage = createValidState();
  tooLongLocalStorage.origins[0].localStorage[0].value = 'x'.repeat(
    BROWSER_STORAGE_STATE_LIMITS.localStorageValueLength + 1
  );
  assert.equal(normalizeBrowserStorageState(tooLongLocalStorage), null);

  const overTotalBudget = createValidState();
  overTotalBudget.origins[0].localStorage = new Array(11).fill(null).map((_, index) => ({
    name: `test-key-${index}`,
    value: 'x'.repeat(BROWSER_STORAGE_STATE_LIMITS.localStorageValueLength),
  }));
  assert.equal(normalizeBrowserStorageState(overTotalBudget), null);
});

test('Cookie 有效期和必需字段异常时整体忽略', () => {
  for (const expires of [-2, Number.POSITIVE_INFINITY, 253402300800]) {
    const state = createValidState();
    state.cookies[0].expires = expires;
    assert.equal(normalizeBrowserStorageState(state), null);
  }

  const invalidPath = createValidState();
  invalidPath.cookies[0].path = 'relative';
  assert.equal(normalizeBrowserStorageState(invalidPath), null);

  const invalidSameSite = createValidState();
  invalidSameSite.cookies[0].sameSite = 'invalid';
  assert.equal(normalizeBrowserStorageState(invalidSameSite), null);
});

test('CHIPS Cookie 保留 partitionKey 与 Chromium 跨站标记', () => {
  const state = createValidState();
  state.cookies[0].partitionKey = 'https://top-level.example';
  state.cookies[0]._crHasCrossSiteAncestor = false;

  const normalized = normalizeBrowserStorageState(state);
  assert.equal(normalized.cookies[0].partitionKey, 'https://top-level.example');
  assert.equal(normalized.cookies[0]._crHasCrossSiteAncestor, false);

  state.cookies[0]._crHasCrossSiteAncestor = 'false';
  assert.equal(normalizeBrowserStorageState(state), null);
});
