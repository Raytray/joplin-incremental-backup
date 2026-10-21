/**
 * Step 1B tests — Cross-Platform Utilities (src/platform.ts)
 *
 * Uses memfs to simulate the filesystem so tests are hermetic and run on any
 * OS without touching real disk.
 */

import { Volume, createFsFromVolume } from 'memfs';

// ---------------------------------------------------------------------------
// Replace the real `fs/promises` with memfs before the module under test loads.
// ---------------------------------------------------------------------------

const vol = new Volume();
const memFs = createFsFromVolume(vol);
const memFsPromises = memFs.promises;

jest.mock('fs/promises', () => {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === '__esModule') return true;
        return (memFsPromises as unknown as Record<string | symbol, unknown>)[prop];
      },
    },
  );
});

// Import module under test AFTER the mock is registered.
import {
  atomicWriteFile,
  acquireLock,
  releaseLock,
  hardlinkOrCopy,
  toDedupeKey,
  safeRmDir,
  ensureBackupRoot,
  checkDiskSpace,
} from '../src/platform';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function resetVolume(initialFiles: Record<string, string> = {}): void {
  vol.reset();
  vol.mkdirSync('/tmp', { recursive: true });

  // Seed the volume with any initial files.
  for (const [filePath, content] of Object.entries(initialFiles)) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir) vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(filePath, content, { encoding: 'utf8' });
  }
}

// ---------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------

describe('atomicWriteFile', () => {
  beforeEach(() => resetVolume());

  it('creates a new file', async () => {
    await atomicWriteFile('/tmp/new.txt', 'hello');
    expect(vol.readFileSync('/tmp/new.txt', 'utf8')).toBe('hello');
  });

  it('overwrites an existing file without error', async () => {
    vol.writeFileSync('/tmp/existing.txt', 'old', { encoding: 'utf8' });
    await atomicWriteFile('/tmp/existing.txt', 'new');
    expect(vol.readFileSync('/tmp/existing.txt', 'utf8')).toBe('new');
  });

  it('retries with unlink when rename throws EEXIST (Windows fallback)', async () => {
    vol.writeFileSync('/tmp/existing.txt', 'old', { encoding: 'utf8' });
    const origRename = memFsPromises.rename;
    let renameAttempts = 0;
    memFsPromises.rename = jest.fn().mockImplementation(async (oldP, newP) => {
      renameAttempts++;
      if (renameAttempts === 1) {
        const err = Object.assign(new Error('EEXIST: file already exists'), {
          code: 'EEXIST',
        });
        throw err;
      }
      return origRename(oldP, newP);
    }) as typeof memFsPromises.rename;

    await atomicWriteFile('/tmp/existing.txt', 'updated');
    expect(vol.readFileSync('/tmp/existing.txt', 'utf8')).toBe('updated');
    expect(renameAttempts).toBe(2);
    memFsPromises.rename = origRename;
  });

  it('leaves no .tmp file after a successful write', async () => {
    await atomicWriteFile('/tmp/clean.txt', 'data');
    expect(vol.existsSync('/tmp/clean.txt.tmp')).toBe(false);
  });

  it('propagates non-EEXIST rename errors', async () => {
    // Simulate a rename that throws EPERM (not EEXIST).
    const origRename = memFsPromises.rename;
    memFsPromises.rename = jest.fn().mockRejectedValue(
      Object.assign(new Error('EPERM'), { code: 'EPERM' }),
    ) as typeof memFsPromises.rename;

    await expect(atomicWriteFile('/tmp/x.txt', 'data')).rejects.toMatchObject({
      code: 'EPERM',
    });
    memFsPromises.rename = origRename;
  });
});

// ---------------------------------------------------------------------------
// acquireLock / releaseLock
// ---------------------------------------------------------------------------

describe('acquireLock / releaseLock', () => {
  const LOCK = '/tmp/backup.lock';
  const STALE_MS = 5000;

  beforeEach(() => resetVolume());

  it('creates the lock file on success', async () => {
    await acquireLock(LOCK, STALE_MS);
    expect(vol.existsSync(LOCK)).toBe(true);
  });

  it('throws EEXIST when lock is already held (not stale)', async () => {
    // Write a fresh lock (timestamp = now).
    vol.writeFileSync(LOCK, new Date().toISOString(), { encoding: 'utf8' });
    await expect(acquireLock(LOCK, STALE_MS)).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('removes a stale lock and succeeds', async () => {
    // Write a lock that is older than STALE_MS.
    const staleTs = new Date(Date.now() - STALE_MS - 1000).toISOString();
    vol.writeFileSync(LOCK, staleTs, { encoding: 'utf8' });
    await expect(acquireLock(LOCK, STALE_MS)).resolves.toBeUndefined();
    expect(vol.existsSync(LOCK)).toBe(true);
  });

  it('treats unreadable lock file as stale and acquires lock', async () => {
    vol.writeFileSync(LOCK, 'invalid-content', { encoding: 'utf8' });
    const origReadFile = memFsPromises.readFile;
    memFsPromises.readFile = jest.fn().mockRejectedValue(new Error('Cannot read'));

    await expect(acquireLock(LOCK, STALE_MS)).resolves.toBeUndefined();
    expect(vol.existsSync(LOCK)).toBe(true);
    memFsPromises.readFile = origReadFile;
  });

  it('propagates unexpected error from open when acquiring lock', async () => {
    const origOpen = memFsPromises.open;
    memFsPromises.open = jest.fn().mockRejectedValue(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    ) as typeof memFsPromises.open;

    await expect(acquireLock(LOCK, STALE_MS)).rejects.toMatchObject({
      code: 'EACCES',
    });
    memFsPromises.open = origOpen;
  });

  it('releaseLock removes the lock file', async () => {
    await acquireLock(LOCK, STALE_MS);
    await releaseLock(LOCK);
    expect(vol.existsSync(LOCK)).toBe(false);
  });

  it('releaseLock is idempotent when lock does not exist', async () => {
    await expect(releaseLock(LOCK)).resolves.toBeUndefined();
  });

  it('rethrows unexpected error on releaseLock', async () => {
    const origUnlink = memFsPromises.unlink;
    memFsPromises.unlink = jest.fn().mockRejectedValue(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    ) as typeof memFsPromises.unlink;

    await expect(releaseLock(LOCK)).rejects.toMatchObject({
      code: 'EACCES',
    });
    memFsPromises.unlink = origUnlink;
  });
});

// ---------------------------------------------------------------------------
// hardlinkOrCopy
// ---------------------------------------------------------------------------

describe('hardlinkOrCopy', () => {
  const SRC = '/data/src/note.md';
  const DEST = '/data/dest/note.md';

  beforeEach(() => resetVolume({ [SRC]: '# My Note' }));

  it('returns "hardlink" when fs.link succeeds', async () => {
    const result = await hardlinkOrCopy(SRC, DEST);
    expect(result).toBe('hardlink');
    // Both paths should contain the same content.
    expect(vol.readFileSync(DEST, 'utf8')).toBe('# My Note');
  });

  it('returns "copy" when fs.link throws EPERM', async () => {
    const origLink = memFsPromises.link;
    memFsPromises.link = jest.fn().mockRejectedValue(
      Object.assign(new Error('EPERM'), { code: 'EPERM' }),
    ) as typeof memFsPromises.link;

    const result = await hardlinkOrCopy(SRC, DEST);
    expect(result).toBe('copy');
    expect(vol.readFileSync(DEST, 'utf8')).toBe('# My Note');
    memFsPromises.link = origLink;
  });

  it('returns "copy" when fs.link throws ENOTSUP', async () => {
    const origLink = memFsPromises.link;
    memFsPromises.link = jest.fn().mockRejectedValue(
      Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }),
    ) as typeof memFsPromises.link;

    const result = await hardlinkOrCopy(SRC, DEST);
    expect(result).toBe('copy');
    memFsPromises.link = origLink;
  });

  it('returns "copy" when fs.link throws EXDEV (cross-device)', async () => {
    const origLink = memFsPromises.link;
    memFsPromises.link = jest.fn().mockRejectedValue(
      Object.assign(new Error('EXDEV'), { code: 'EXDEV' }),
    ) as typeof memFsPromises.link;

    const result = await hardlinkOrCopy(SRC, DEST);
    expect(result).toBe('copy');
    memFsPromises.link = origLink;
  });

  it('rethrows unexpected errors from fs.link', async () => {
    const origLink = memFsPromises.link;
    memFsPromises.link = jest.fn().mockRejectedValue(
      Object.assign(new Error('EIO'), { code: 'EIO' }),
    ) as typeof memFsPromises.link;

    await expect(hardlinkOrCopy(SRC, DEST)).rejects.toMatchObject({
      code: 'EIO',
    });
    memFsPromises.link = origLink;
  });

  it('creates destination directory if it does not exist', async () => {
    const deepDest = '/data/a/b/c/note.md';
    await hardlinkOrCopy(SRC, deepDest);
    expect(vol.existsSync('/data/a/b/c')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toDedupeKey
// ---------------------------------------------------------------------------

describe('toDedupeKey', () => {
  it('lowercases the path', () => {
    expect(toDedupeKey('Notes/FOO.md')).toBe('notes/foo.md');
  });

  it('normalizes Windows backslashes to forward slashes', () => {
    expect(toDedupeKey('Notes\\SubDir\\file.md')).toBe('notes/subdir/file.md');
  });

  it('handles mixed separators', () => {
    expect(toDedupeKey('UPPER\\Lower/MIXED.MD')).toBe('upper/lower/mixed.md');
  });

  it('returns an empty string for an empty input', () => {
    expect(toDedupeKey('')).toBe('');
  });

  it('does not modify already-normalised lowercase paths', () => {
    expect(toDedupeKey('notes/subfolder/note.md')).toBe(
      'notes/subfolder/note.md',
    );
  });
});

// ---------------------------------------------------------------------------
// safeRmDir
// ---------------------------------------------------------------------------

describe('safeRmDir', () => {
  beforeEach(() => resetVolume());

  it('removes a directory and its contents', async () => {
    vol.mkdirSync('/tmp/snap', { recursive: true });
    vol.writeFileSync('/tmp/snap/a.md', 'data', { encoding: 'utf8' });

    await safeRmDir('/tmp/snap');
    expect(vol.existsSync('/tmp/snap')).toBe(false);
  });

  it('does not throw when directory does not exist (force: true)', async () => {
    await expect(safeRmDir('/tmp/nonexistent')).resolves.toBeUndefined();
  });

  it('warns instead of throwing on EBUSY', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const origRm = memFsPromises.rm;
    memFsPromises.rm = jest.fn().mockRejectedValue(
      Object.assign(new Error('EBUSY'), { code: 'EBUSY' }),
    ) as typeof memFsPromises.rm;

    await expect(safeRmDir('/tmp/busy')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('EBUSY'),
    );

    memFsPromises.rm = origRm;
    warnSpy.mockRestore();
  });

  it('rethrows non-EBUSY errors', async () => {
    const origRm = memFsPromises.rm;
    memFsPromises.rm = jest.fn().mockRejectedValue(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    ) as typeof memFsPromises.rm;

    await expect(safeRmDir('/tmp/noperm')).rejects.toMatchObject({
      code: 'EACCES',
    });
    memFsPromises.rm = origRm;
  });
});

describe('ensureBackupRoot', () => {
  it('creates directory if absent', async () => {
    vol.reset();
    await ensureBackupRoot('/new/backup/root');
    expect(vol.existsSync('/new/backup/root')).toBe(true);
  });

  it('succeeds if directory exists', async () => {
    vol.reset();
    vol.mkdirSync('/existing', { recursive: true });
    await expect(ensureBackupRoot('/existing')).resolves.toBeUndefined();
  });

  it('throws if path exists as file', async () => {
    vol.reset();
    vol.writeFileSync('/afile', 'x');
    await expect(ensureBackupRoot('/afile')).rejects.toThrow(/not a directory/);
  });

  it('throws if path is empty', async () => {
    await expect(ensureBackupRoot('')).rejects.toThrow(/empty/);
  });

  it('propagates unexpected stat errors', async () => {
    vol.reset();
    const origStat = memFsPromises.stat;
    memFsPromises.stat = (async () => {
      throw Object.assign(new Error('boom'), { code: 'EACCES' });
    }) as unknown as typeof memFsPromises.stat;
    await expect(ensureBackupRoot('/some/path')).rejects.toThrow('boom');
    memFsPromises.stat = origStat;
  });

  it('throws if path is not writable', async () => {
    vol.reset();
    vol.mkdirSync('/readonly', { recursive: true });
    const origAccess = memFsPromises.access;
    memFsPromises.access = (async () => {
      throw new Error('no access');
    }) as unknown as typeof memFsPromises.access;
    await expect(ensureBackupRoot('/readonly')).rejects.toThrow(/not writable/);
    memFsPromises.access = origAccess;
  });
});

describe('checkDiskSpace', () => {
  it('returns available bytes when sufficient', async () => {
    vol.reset();
    vol.mkdirSync('/tmp', { recursive: true });
    const avail = await checkDiskSpace('/tmp', 1);
    expect(avail).toBeGreaterThan(0);
  });

  it('throws when insufficient space requested', async () => {
    vol.reset();
    vol.mkdirSync('/tmp', { recursive: true });
    await expect(checkDiskSpace('/tmp', Number.MAX_SAFE_INTEGER)).rejects.toThrow(/Insufficient disk space/);
  });
});
