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
  atomicWriteFile,
  checkDiskSpace,
  collectFilesRecursive,
  computeFileSha256,
  ensureBackupRoot,
  hardlinkOrCopy,
  mapWithConcurrency,
  releaseLock,
  safeRmDir,
  toDedupeKey,
} from '../src/platform';

const ROOT = '/data';

function sha256(content: string): string {
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
});

describe('hardlinkOrCopy', () => {
  it('prefers a hardlink when supported', async () => {
    const src = path.join(ROOT, 'src.txt');
    const dest = path.join(ROOT, 'dest.txt');
    await fs.writeFile(src, 'hello');

    await expect(hardlinkOrCopy(src, dest)).resolves.toBe('hardlink');
    expect(await fs.readFile(dest, 'utf8')).toBe('hello');
  });

  it("returns 'copy' when fs.link throws EPERM", async () => {
    const src = path.join(ROOT, 'src.txt');
    const dest = path.join(ROOT, 'dest.txt');
    await fs.writeFile(src, 'hello');

    const linkSpy = vi
      .spyOn(fs, 'link')
      .mockRejectedValueOnce(Object.assign(new Error('not permitted'), { code: 'EPERM' }));

    await expect(hardlinkOrCopy(src, dest)).resolves.toBe('copy');
    expect(await fs.readFile(dest, 'utf8')).toBe('hello');

    linkSpy.mockRestore();
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
});
