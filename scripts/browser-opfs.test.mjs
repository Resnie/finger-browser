import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeOpfs } from '../electron/main/models/browserOpfs.mjs';
import { normalizeBrowserStorageState } from '../electron/main/models/browserStorageState.mjs';

const fixture = () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  return {
    version: 1,
    origins: [
      {
        origin: 'https://example.test',
        directories: [['目录'], ['empty']],
        files: [
          {
            path: ['目录', 'binary.dat'],
            bytes: bytes.length,
            data: bytes.toString('base64'),
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
    ],
  };
};

test('logical OPFS preserves binary files, Unicode names and empty directories', () => {
  const input = fixture();
  assert.deepEqual(normalizeOpfs(input), input);
  assert.deepEqual(
    normalizeBrowserStorageState({ cookies: [], origins: [], opfs: input }).opfs,
    input
  );
});
test('corrupted bytes invalidate the entire recovery state before clearing local files', () => {
  const input = fixture();
  input.origins[0].files[0].data = Buffer.from('wrong').toString('base64');
  assert.equal(normalizeOpfs(input), null);
  assert.equal(normalizeBrowserStorageState({ cookies: [], origins: [], opfs: input }), null);
});
test('rejects unsafe virtual names, duplicate files, missing parents and credentialed origins', () => {
  for (const mutate of [
    s => {
      s.origins[0].files[0].path = ['..', 'binary.dat'];
    },
    s => {
      s.origins[0].files[0].path = ['a/b'];
    },
    s => {
      s.origins[0].files.push(s.origins[0].files[0]);
    },
    s => {
      s.origins[0].directories = [];
    },
    s => {
      s.origins[0].origin = 'https://user:password@example.test';
    },
    s => {
      s.origins.push(s.origins[0]);
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(normalizeOpfs(input), null);
  }
});
test('rejects excessive files and file sizes; accepts an authoritative empty origin', () => {
  const input = fixture();
  input.origins[0].directories = Array.from({ length: 2001 }, (_, i) => ['dir' + i]);
  assert.equal(normalizeOpfs(input), null);
  const large = fixture();
  large.origins[0].files[0].bytes = 4 * 1024 * 1024 + 1;
  assert.equal(normalizeOpfs(large), null);
  assert.ok(
    normalizeOpfs({
      version: 1,
      origins: [{ origin: 'https://example.test', directories: [], files: [] }],
    })
  );
});
