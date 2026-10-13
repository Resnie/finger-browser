import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  filterSupportedBrowserVersions,
  getBrowserDistribution,
  verifyBrowserArchive,
} from '../electron/utils/browserDistribution.mjs';

test('macOS 只返回已配置可信发行包的内核', () => {
  assert.deepEqual(
    filterSupportedBrowserVersions(['145.0.7600', '144.0.7500', '140.0.7259'], 'darwin'),
    ['144.0.7500', '140.0.7259']
  );
  assert.match(getBrowserDistribution('140.0.7259', 'darwin').url, /^https:\/\//);
  assert.throws(() => getBrowserDistribution('145.0.7600', 'darwin'), /暂不支持当前系统/);
});

test('Windows 和 macOS 使用各自的发行包校验值', () => {
  const mac = getBrowserDistribution('144.0.7500', 'darwin');
  const windows = getBrowserDistribution('144.0.7500', 'win32');
  assert.notEqual(mac.url, windows.url);
  assert.notEqual(mac.sha256, windows.sha256);
  assert.match(mac.sha256, /^[a-f0-9]{64}$/);
  assert.match(windows.sha256, /^[a-f0-9]{64}$/);
});

test('下载文件只有校验值完全一致时才能通过', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'test-browser-integrity-'));
  const archivePath = path.join(tempDir, 'chrome.zip');
  try {
    await writeFile(archivePath, 'test-browser-archive');
    await assert.doesNotReject(
      verifyBrowserArchive(
        archivePath,
        'af215a246612f49cd9cc1480f679be896392fa26a8f90dd92fe3faad8829b9b1'
      )
    );
    await assert.rejects(
      verifyBrowserArchive(archivePath, '0'.repeat(64)),
      error => error.code === 'BROWSER_ARCHIVE_INTEGRITY_FAILED'
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
