import { createHash } from 'node:crypto';

export const OPFS_LIMITS = Object.freeze({
  origins: 100,
  entries: 2000,
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value =>
  value &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validPath = value =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 32 &&
  value.every(
    part =>
      typeof part === 'string' &&
      part.length > 0 &&
      part.length <= 255 &&
      part !== '.' &&
      part !== '..' &&
      !/[\/\0]/.test(part)
  );

/** Logical file names and bytes, independent of Chromium's OS-specific database paths. */
export const normalizeOpfs = value => {
  try {
    if (
      !plain(value) ||
      value.version !== 1 ||
      !Array.isArray(value.origins) ||
      value.origins.length > OPFS_LIMITS.origins
    )
      return null;
    const origins = [],
      seenOrigins = new Set();
    let totalBytes = 0,
      entries = 0;
    for (const origin of value.origins) {
      if (
        !plain(origin) ||
        typeof origin.origin !== 'string' ||
        origin.origin.length > 2048 ||
        !Array.isArray(origin.directories) ||
        !Array.isArray(origin.files)
      )
        return null;
      const url = new URL(origin.origin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.origin !== origin.origin ||
        seenOrigins.has(url.origin)
      )
        return null;
      seenOrigins.add(url.origin);
      const paths = new Map(),
        directories = [],
        files = [];
      for (const directory of origin.directories) {
        if (!validPath(directory)) return null;
        const key = JSON.stringify(directory);
        if (paths.has(key)) return null;
        paths.set(key, 'directory');
        directories.push([...directory]);
      }
      for (const file of origin.files) {
        if (
          !plain(file) ||
          !validPath(file.path) ||
          !Number.isSafeInteger(file.bytes) ||
          file.bytes < 0 ||
          file.bytes > OPFS_LIMITS.fileBytes ||
          typeof file.data !== 'string' ||
          file.data.length !== Math.ceil(file.bytes / 3) * 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) ||
          !/^[a-f0-9]{64}$/.test(file.sha256 || '')
        )
          return null;
        const bytes = Buffer.from(file.data, 'base64'),
          key = JSON.stringify(file.path);
        if (
          paths.has(key) ||
          bytes.length !== file.bytes ||
          bytes.toString('base64') !== file.data ||
          hash(bytes) !== file.sha256
        )
          return null;
        paths.set(key, 'file');
        totalBytes += bytes.length;
        files.push({
          path: [...file.path],
          bytes: bytes.length,
          sha256: file.sha256,
          data: file.data,
        });
      }
      entries += paths.size;
      if (entries > OPFS_LIMITS.entries || totalBytes > OPFS_LIMITS.totalBytes) return null;
      for (const entry of [...directories, ...files.map(file => file.path)]) {
        for (let depth = 1; depth < entry.length; depth++)
          if (paths.get(JSON.stringify(entry.slice(0, depth))) !== 'directory') return null;
      }
      origins.push({ origin: origin.origin, directories, files });
    }
    return { version: 1, origins };
  } catch {
    return null;
  }
};

/** Runs only in intercepted, script-free documents in a stopped profile's temporary copy. */
export const captureOpfs = async (context, origins) => {
  const result = { version: 1, origins: [] };
  const page = context.pages()[0] || (await context.newPage());
  await context.route('**/*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title></title>' })
  );
  let totalBytes = 0,
    entries = 0;
  for (const origin of new Set(origins)) {
    if (result.origins.length >= OPFS_LIMITS.origins)
      throw new Error('OPFS origin count exceeds the sync limit');
    await page.goto(origin + '/.well-known/finger-browser-opfs-export', {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    const captured = await page.evaluate(async limits => {
      if (!navigator.storage?.getDirectory) return null;
      const root = await navigator.storage.getDirectory(),
        directories = [],
        files = [];
      let bytes = 0,
        entries = 0;
      const visit = async (dir, parent) => {
        for await (const [name, handle] of dir.entries()) {
          const path = [...parent, name];
          if (++entries > limits.entries || path.length > 32)
            throw new Error('OPFS entry limit exceeded');
          if (handle.kind === 'directory') {
            directories.push(path);
            await visit(handle, path);
          } else {
            const file = await handle.getFile();
            if (file.size > limits.fileBytes || (bytes += file.size) > limits.totalBytes)
              throw new Error('OPFS byte limit exceeded');
            const data = new Uint8Array(await file.arrayBuffer());
            let binary = '';
            for (let offset = 0; offset < data.length; offset += 16384)
              binary += String.fromCharCode(...data.subarray(offset, offset + 16384));
            files.push({ path, bytes: data.length, data: btoa(binary) });
          }
        }
      };
      await visit(root, []);
      return { directories, files };
    }, OPFS_LIMITS);
    if (!captured) continue;
    for (const file of captured.files) {
      file.sha256 = hash(Buffer.from(file.data, 'base64'));
      totalBytes += file.bytes;
    }
    entries += captured.files.length + captured.directories.length;
    if (entries > OPFS_LIMITS.entries || totalBytes > OPFS_LIMITS.totalBytes)
      throw new Error('OPFS snapshot exceeds the sync limit');
    result.origins.push({ origin, ...captured });
  }
  const normalized = normalizeOpfs(result);
  if (!normalized) throw new Error('Invalid OPFS snapshot');
  return normalized;
};

/** Uses origin-scoped handles, never host filesystem paths. Empty snapshots clear stale files. */
export const restoreOpfsOrigin = async (page, snapshot) => {
  const normalized = normalizeOpfs({ version: 1, origins: [snapshot] });
  if (!normalized) throw new Error('Invalid OPFS origin snapshot');
  await page.evaluate(async saved => {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
    const directory = async segments => {
      let current = root;
      for (const name of segments)
        current = await current.getDirectoryHandle(name, { create: true });
      return current;
    };
    for (const path of [...saved.directories].sort((a, b) => a.length - b.length))
      await directory(path);
    for (const file of saved.files) {
      const dir = await directory(file.path.slice(0, -1)),
        handle = await dir.getFileHandle(file.path.at(-1), { create: true });
      const writer = await handle.createWritable();
      try {
        await writer.write(Uint8Array.from(atob(file.data), char => char.charCodeAt(0)));
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
    }
  }, normalized.origins[0]);
};
