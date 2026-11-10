import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return { default: memfs.fs.promises, ...memfs.fs.promises };
});

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { vol } from 'memfs';
import {
  acquireLock,
  assertDiskSpace,
  atomicWriteFile,
  checkDiskSpace,
  collectFilesRecursive,
  computeFileSha256,
  ensureBackupRoot,
  hashFile,
  isHardlinkUnsupportedError,
  hasFreshLock,
  mapWithConcurrency,
  releaseLock,
  safeRmDir,
  toDedupeKey,
  toManifestKey,
  touchLock,
} from '../src/platform';
import { logger } from '../src/logger';

const ROOT = '/data';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(ROOT, { recursive: true });
});

describe('atomicWriteFile', () => {
  it('overwrites an existing file without error', async () => {
    const target = path.join(ROOT, 'note.md');
    await fs.writeFile(target, 'old');

    await atomicWriteFile(target, 'new');

    expect(await fs.readFile(target, 'utf8')).toBe('new');
    expect(await fs.stat(`${target}.tmp`).catch(() => null)).toBeNull();
  });

  it('creates a new file', async () => {
    const target = path.join(ROOT, 'fresh.md');
    await atomicWriteFile(target, 'hello');
    expect(await fs.readFile(target, 'utf8')).toBe('hello');
  });
});

describe('acquireLock / releaseLock', () => {
  it('throws EEXIST while the lock is held', async () => {
    const lockPath = path.join(ROOT, '.backup.lock');
    await acquireLock(lockPath, 60_000);

    await expect(acquireLock(lockPath, 60_000)).rejects.toMatchObject({ code: 'EEXIST' });

    await releaseLock(lockPath);
    await expect(acquireLock(lockPath, 60_000)).resolves.toBeUndefined();
  });

  it('reclaims a stale lock', async () => {
    const lockPath = path.join(ROOT, '.backup.lock');
    await fs.writeFile(lockPath, 'stale');
    await fs.utimes(lockPath, new Date(0), new Date(0));

    await expect(acquireLock(lockPath, 1_000)).resolves.toBeUndefined();
    expect(await fs.readFile(lockPath, 'utf8')).not.toBe('stale');
  });

  it('releaseLock ignores a missing lock', async () => {
    await expect(releaseLock(path.join(ROOT, 'missing.lock'))).resolves.toBeUndefined();
  });

  it('lets exactly one contender win a stale lock', async () => {
    const lockPath = path.join(ROOT, '.backup.lock');
    await fs.writeFile(lockPath, 'stale');
    await fs.utimes(lockPath, new Date(0), new Date(0));

    const results = await Promise.allSettled([
      acquireLock(lockPath, 1_000),
      acquireLock(lockPath, 1_000),
      acquireLock(lockPath, 1_000),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const failure of lost) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({ code: 'EEXIST' });
    }
  });

  it('does not delete the winner lock when a stale lock is stolen', async () => {
    const lockPath = path.join(ROOT, '.backup.lock');
    await fs.writeFile(lockPath, 'stale');
    await fs.utimes(lockPath, new Date(0), new Date(0));

    await acquireLock(lockPath, 1_000);
    const holder = await fs.readFile(lockPath, 'utf8');

    // A second contender must not be able to take the fresh lock.
    await expect(acquireLock(lockPath, 1_000)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(lockPath, 'utf8')).toBe(holder);
  });

  it('leaves no stale lock files behind after a steal', async () => {
    const lockPath = path.join(ROOT, '.backup.lock');
    await fs.writeFile(lockPath, 'stale');
    await fs.utimes(lockPath, new Date(0), new Date(0));

    await acquireLock(lockPath, 1_000);

    const entries = await fs.readdir(ROOT);
    expect(entries.filter((name) => name.includes('.stale.'))).toEqual([]);
  });
});

describe('touchLock / hasFreshLock', () => {
  it('refreshes the mtime of a held lock', async () => {
    const lockPath = path.join(ROOT, '.backup.lock');
    await acquireLock(lockPath, 60_000);
    await fs.utimes(lockPath, new Date(0), new Date(0));

    expect(await hasFreshLock(lockPath, 60_000)).toBe(false);

    await touchLock(lockPath);

    expect(await hasFreshLock(lockPath, 60_000)).toBe(true);
    expect((await fs.stat(lockPath)).mtime.getTime()).toBeGreaterThan(0);
  });

  it('ignores a lock that no longer exists', async () => {
    const lockPath = path.join(ROOT, 'missing.lock');
    await expect(touchLock(lockPath)).resolves.toBeUndefined();
    await expect(hasFreshLock(lockPath, 60_000)).resolves.toBe(false);
  });
});

describe('toManifestKey', () => {
  it('normalizes separators but preserves case', () => {
    expect(toManifestKey('resources/Note.md')).toBe('resources/Note.md');
    expect(toManifestKey('Note.md')).not.toBe(toManifestKey('note.md'));
  });
});

describe('isHardlinkUnsupportedError', () => {
  it('recognizes filesystem-level link failures', () => {
    for (const code of ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EISDIR']) {
      expect(isHardlinkUnsupportedError(Object.assign(new Error(code), { code }))).toBe(true);
    }
  });

  it('rejects per-file and unrelated errors', () => {
    for (const code of ['EEXIST', 'EIO', 'ENOENT', 'EMLINK']) {
      expect(isHardlinkUnsupportedError(Object.assign(new Error(code), { code }))).toBe(false);
    }
    expect(isHardlinkUnsupportedError(new Error('no code'))).toBe(false);
  });
});

describe('toDedupeKey', () => {
  it('normalizes backslashes and casing', () => {
    expect(toDedupeKey('Notes\\Sub\\File.MD')).toBe('notes/sub/file.md');
    expect(toDedupeKey('already/lower.md')).toBe('already/lower.md');
  });
});

describe('computeFileSha256', () => {
  it('matches a known digest', async () => {
    const filePath = path.join(ROOT, 'hash.txt');
    await fs.writeFile(filePath, 'hello');

    await expect(computeFileSha256(filePath)).resolves.toBe(sha256('hello'));
  });

  it('hashes files larger than one chunk', async () => {
    const filePath = path.join(ROOT, 'large.bin');
    const content = 'a'.repeat(200 * 1024);
    await fs.writeFile(filePath, content);

    await expect(computeFileSha256(filePath)).resolves.toBe(sha256(content));
  });
});

describe('hashFile', () => {
  it.each([
    ['empty', 0],
    ['small', 5],
    ['exactly one small chunk', 64 * 1024],
    ['one byte over a small chunk', 64 * 1024 + 1],
    ['several large chunks', 3 * 1024 * 1024 + 17],
  ])('returns the digest and size of a %s file', async (_label, size) => {
    const filePath = path.join(ROOT, `f${size}.bin`);
    const content = Buffer.alloc(size, 'x');
    await fs.writeFile(filePath, content);

    await expect(hashFile(filePath)).resolves.toEqual({ sha256: sha256(content), size });
    await expect(hashFile(filePath, size)).resolves.toEqual({ sha256: sha256(content), size });
  });

  it('moves to 1 MB reads past 64 KB even when reads come back short', async () => {
    const filePath = path.join(ROOT, 'short-reads.bin');
    const content = Buffer.alloc(300 * 1024, 'z');
    await fs.writeFile(filePath, content);
    const requested: number[] = [];
    const open = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle) as (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>;
      // A network filesystem returning at most 48 KB per read.
      return Object.assign(handle, {
        read: (buffer: Buffer, offset: number, length: number, position: number) => {
          requested.push(length);
          return read(buffer, offset, Math.min(length, 48 * 1024), position);
        },
      });
    }) as typeof fs.open);
    let digest: Awaited<ReturnType<typeof hashFile>>;
    try {
      digest = await hashFile(filePath);
    } finally {
      openSpy.mockRestore();
    }

    expect(digest).toEqual({ sha256: sha256(content), size: content.length });
    expect(requested.slice(0, 3)).toEqual([64 * 1024, 64 * 1024, 1024 * 1024]);
  });

  it('does not stat the file', async () => {
    const filePath = path.join(ROOT, 'nostat.bin');
    await fs.writeFile(filePath, Buffer.alloc(100 * 1024, 'y'));
    const stat = vi.spyOn(fs, 'stat');
    const open = fs.open.bind(fs);
    let handleStat: ReturnType<typeof vi.fn> | undefined;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await open(...args);
      handleStat = vi.fn(handle.stat.bind(handle));
      return Object.assign(handle, { stat: handleStat });
    }) as typeof fs.open);
    let statCalls: number;
    try {
      await hashFile(filePath);
    } finally {
      // Read the calls first: mockRestore clears them.
      statCalls = stat.mock.calls.length;
      stat.mockRestore();
      openSpy.mockRestore();
    }
    expect(statCalls).toBe(0);
    expect(handleStat).not.toHaveBeenCalled();
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const result = await mapWithConcurrency([3, 1, 2], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return value * 10;
    });

    expect(result).toEqual([30, 10, 20]);
  });

  it('handles an empty list', async () => {
    await expect(mapWithConcurrency([], 4, async (value) => value)).resolves.toEqual([]);
  });
});

describe('filesystem helpers', () => {
  it('ensureBackupRoot creates nested directories', async () => {
    const root = path.join(ROOT, 'nested', 'backup');
    await ensureBackupRoot(root);
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  });

  it('collectFilesRecursive returns normalized relative paths', async () => {
    await fs.mkdir(path.join(ROOT, 'sub'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'a.txt'), 'a');
    await fs.writeFile(path.join(ROOT, 'sub', 'b.txt'), 'b');

    await expect(collectFilesRecursive(ROOT)).resolves.toEqual(['a.txt', 'sub/b.txt']);
  });

  it('safeRmDir removes a tree and ignores a missing directory', async () => {
    const target = path.join(ROOT, 'tree');
    await fs.mkdir(path.join(target, 'inner'), { recursive: true });
    await fs.writeFile(path.join(target, 'inner', 'file.txt'), 'x');

    await safeRmDir(target);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(safeRmDir(target)).resolves.toBeUndefined();
  });

  it('safeRmDir swallows EBUSY', async () => {
    const target = path.join(ROOT, 'busy');
    await fs.mkdir(target, { recursive: true });

    const rmSpy = vi
      .spyOn(fs, 'rm')
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));

    await expect(safeRmDir(target)).resolves.toBeUndefined();
    rmSpy.mockRestore();
  });

  it('checkDiskSpace returns free bytes', async () => {
    const free = await checkDiskSpace(ROOT, 0);
    expect(free).toBeGreaterThanOrEqual(0);
  });

  it('checkDiskSpace warns (without throwing) when below the threshold', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const free = await checkDiskSpace(ROOT, Number.MAX_SAFE_INTEGER);

    expect(free).toBeGreaterThanOrEqual(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Low disk space/);
    warn.mockRestore();
  });

  it('checkDiskSpace returns -1 when the filesystem is unavailable', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const statfsSpy = vi
      .spyOn(fs, 'statfs')
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOSYS' }));

    await expect(checkDiskSpace(ROOT, 0)).resolves.toBe(-1);
    expect(warn).toHaveBeenCalled();
    statfsSpy.mockRestore();
    warn.mockRestore();
  });

  it('checkDiskSpace rethrows unexpected errors', async () => {
    const statfsSpy = vi
      .spyOn(fs, 'statfs')
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EPERM' }));

    await expect(checkDiskSpace(ROOT, 0)).rejects.toMatchObject({ code: 'EPERM' });
    statfsSpy.mockRestore();
  });

  it('assertDiskSpace passes when free space is above the threshold', async () => {
    await expect(assertDiskSpace(ROOT, 0)).resolves.toBeGreaterThanOrEqual(0);
  });

  it('assertDiskSpace throws when free space is below the threshold', async () => {
    await expect(assertDiskSpace(ROOT, Number.MAX_SAFE_INTEGER)).rejects.toThrow(
      /Not enough free disk space/,
    );
  });

  it('assertDiskSpace proceeds when the filesystem cannot be measured', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const statfsSpy = vi
      .spyOn(fs, 'statfs')
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOSYS' }));

    await expect(assertDiskSpace(ROOT, Number.MAX_SAFE_INTEGER)).resolves.toBe(-1);
    statfsSpy.mockRestore();
    warn.mockRestore();
  });
});

describe('atomicWriteFile edge cases', () => {
  it('retries the rename after unlinking on EEXIST', async () => {
    const target = path.join(ROOT, 'retry.md');
    await fs.writeFile(target, 'old');

    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }));

    await atomicWriteFile(target, 'new');

    expect(await fs.readFile(target, 'utf8')).toBe('new');
    renameSpy.mockRestore();
  });

  it('cleans up the temp file and rethrows on unexpected rename errors', async () => {
    const target = path.join(ROOT, 'fail.md');

    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EIO' }));

    await expect(atomicWriteFile(target, 'x')).rejects.toMatchObject({ code: 'EIO' });
    expect(await fs.stat(`${target}.tmp`).catch(() => null)).toBeNull();
    renameSpy.mockRestore();
  });
});

describe('acquireLock edge cases', () => {
  it('rethrows unexpected stat errors while checking staleness', async () => {
    const lockPath = path.join(ROOT, 'stat-error.lock');
    await fs.writeFile(lockPath, 'held');

    const statSpy = vi
      .spyOn(fs, 'stat')
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EACCES' }));

    await expect(acquireLock(lockPath, 1000)).rejects.toMatchObject({ code: 'EACCES' });
    statSpy.mockRestore();
  });

  it('throws EEXIST when the lock disappears but a new one is created immediately', async () => {
    const lockPath = path.join(ROOT, 'race.lock');
    await fs.writeFile(lockPath, 'held');

    const statSpy = vi
      .spyOn(fs, 'stat')
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));

    // The lock file still exists on disk, so the retry attempt fails with EEXIST.
    await expect(acquireLock(lockPath, 1000)).rejects.toMatchObject({ code: 'EEXIST' });
    statSpy.mockRestore();
  });

  it('rethrows unexpected errors from the create attempt', async () => {
    const lockPath = path.join(ROOT, 'open-error.lock');
    const openSpy = vi
      .spyOn(fs, 'open')
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EACCES' }));

    await expect(acquireLock(lockPath, 1000)).rejects.toMatchObject({ code: 'EACCES' });
    openSpy.mockRestore();
  });
});
