import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addHistoryVisit,
  ensureHistoryEntry,
  isRecordableHistoryUrl,
  mergeHistoryAfterRejectedClear,
  normalizeHistoryEntries,
  normalizeRecoveryHistoryEntries,
  updateHistoryMetadata,
} from '../electron/main/models/historyEntries.mjs';

test('损坏的历史 entries 容错为空列表，无效子项会被过滤', () => {
  assert.deepEqual(normalizeHistoryEntries(null), []);
  assert.deepEqual(normalizeHistoryEntries({ url: 'https://example.com' }), []);

  const entries = normalizeHistoryEntries([
    null,
    { url: 'about:blank', title: 'test-invalid' },
    { url: 'not-a-url', title: 'test-invalid' },
    {
      url: 'https://example.com/path',
      title: 123,
      favicon: null,
      visitCount: -1,
      lastVisitTime: Number.NaN,
    },
    {
      url: 'https://example.com/path',
      title: 'test-duplicate',
      visitCount: 99,
      lastVisitTime: 99,
    },
  ]);

  assert.deepEqual(entries, [
    {
      url: 'https://example.com/path',
      title: '',
      favicon: '',
      visitCount: 1,
      lastVisitTime: 0,
    },
  ]);
});

test('可记录的历史 URL 仅包含 HTTP、HTTPS 和 file', () => {
  assert.equal(isRecordableHistoryUrl('https://example.com'), true);
  assert.equal(isRecordableHistoryUrl('http://127.0.0.1:43127/test'), true);
  assert.equal(isRecordableHistoryUrl('file:///tmp/test-page.html'), true);
  assert.equal(isRecordableHistoryUrl('about:blank'), false);
  assert.equal(isRecordableHistoryUrl('chrome://settings'), false);
  assert.equal(isRecordableHistoryUrl('javascript:alert(1)'), false);
});

test('初始/恢复页面只补记一次，不增加已有记录的 visitCount', () => {
  const first = ensureHistoryEntry([], 'https://example.com', 'test-initial', '', 100);
  assert.equal(first.length, 1);
  assert.equal(first[0].visitCount, 1);
  assert.equal(first[0].lastVisitTime, 100);

  const second = ensureHistoryEntry(first, 'https://example.com', 'test-restored', '', 200);
  assert.equal(second.length, 1);
  assert.equal(second[0].title, 'test-restored');
  assert.equal(second[0].visitCount, 1);
  assert.equal(second[0].lastVisitTime, 100);
});

test('一次正常导航只增加一次，load 仅更新标题元数据', () => {
  const navigated = addHistoryVisit([], 'https://example.com/page', '', '', 100);
  const loaded = updateHistoryMetadata(
    navigated,
    'https://example.com/page',
    'test-page-title',
    'test-favicon'
  );

  assert.equal(loaded[0].visitCount, 1);
  assert.equal(loaded[0].lastVisitTime, 100);
  assert.equal(loaded[0].title, 'test-page-title');
  assert.equal(loaded[0].favicon, 'test-favicon');

  const revisited = addHistoryVisit(
    loaded,
    'https://example.com/page',
    'test-second-visit',
    '',
    200
  );
  assert.equal(revisited[0].visitCount, 2);
  assert.equal(revisited[0].lastVisitTime, 200);
  assert.equal(revisited[0].title, 'test-second-visit');
});

test('空白新标签不入历史，后续导航到普通页后可正常记录', () => {
  const blank = addHistoryVisit([], 'about:blank', 'test-blank', '', 100);
  assert.deepEqual(blank, []);

  const navigated = addHistoryVisit(blank, 'http://127.0.0.1:43127/second.html', '', '', 200);
  assert.equal(navigated.length, 1);
  assert.equal(navigated[0].visitCount, 1);
});

test('清历史 CAS 失败回滚时保留等待期间的新导航', () => {
  const original = addHistoryVisit([], 'https://example.com/old', 'old', '', 100);
  const revisited = addHistoryVisit([], 'https://example.com/old', 'new-title', '', 200);
  const current = addHistoryVisit(revisited, 'https://example.com/new', 'new-page', '', 300);
  const merged = mergeHistoryAfterRejectedClear(original, current);

  assert.equal(merged.find(entry => entry.url.endsWith('/old')).visitCount, 2);
  assert.equal(merged.find(entry => entry.url.endsWith('/old')).lastVisitTime, 200);
  assert.equal(merged.find(entry => entry.url.endsWith('/new')).title, 'new-page');
});

test('云恢复历史拒绝 Go int64 无法解码的小数时间戳', () => {
  assert.equal(
    normalizeRecoveryHistoryEntries([
      {
        url: 'https://example.com',
        title: '',
        favicon: '',
        visitCount: 1,
        lastVisitTime: 1.5,
      },
    ]),
    null
  );
});
