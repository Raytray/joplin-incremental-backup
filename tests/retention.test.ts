/**
 * Step 1E tests — Retention & Pruning (src/retention.ts)
 *
 * Uses memfs to simulate the filesystem so tests are hermetic and run on any
 * OS without touching real disk.
 */

import { Volume, createFsFromVolume } from 'memfs';

// ---------------------------------------------------------------------------
// Replace the real `fs/promises` with memfs before modules load
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

import { listSnapshots, pruneSnapshots, SNAPSHOT_PATTERN } from '../src/retention';
import * as platform from '../src/platform';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BACKUP_ROOT = '/backups';

function resetVolume(): void {
  vol.reset();
  vol.mkdirSync(BACKUP_ROOT, { recursive: true });
}

function createSnapshotDir(name: string, files: Record<string, string> = {}): void {
  const dirPath = `${BACKUP_ROOT}/${name}`;
  vol.mkdirSync(dirPath, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = `${dirPath}/${relativePath}`;
    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (parentDir) vol.mkdirSync(parentDir, { recursive: true });
    vol.writeFileSync(filePath, content, { encoding: 'utf8' });
  }
}

// ---------------------------------------------------------------------------
// SNAPSHOT_PATTERN
// ---------------------------------------------------------------------------

describe('SNAPSHOT_PATTERN', () => {
  it('matches valid YYYYMMDDTHHMMSS formatted timestamp strings', () => {
    expect(SNAPSHOT_PATTERN.test('20261019T140000')).toBe(true);
    expect(SNAPSHOT_PATTERN.test('20260101T000000')).toBe(true);
    expect(SNAPSHOT_PATTERN.test('19991231T235959')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(SNAPSHOT_PATTERN.test('latest.txt')).toBe(false);
    expect(SNAPSHOT_PATTERN.test('_joplin_active_')).toBe(false);
    expect(SNAPSHOT_PATTERN.test('2026-10-19T14:00:00')).toBe(false);
    expect(SNAPSHOT_PATTERN.test('20261019')).toBe(false);
    expect(SNAPSHOT_PATTERN.test('20261019T14000')).toBe(false);
    expect(SNAPSHOT_PATTERN.test('20261019T1400000')).toBe(false);
    expect(SNAPSHOT_PATTERN.test('snapshot_20261019T140000')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listSnapshots
// ---------------------------------------------------------------------------

describe('listSnapshots', () => {
  beforeEach(() => resetVolume());

  it('returns empty array when backup root does not exist', async () => {
    const result = await listSnapshots('/nonexistent_directory');
    expect(result).toEqual([]);
  });

  it('returns empty array when backup root has no snapshots', async () => {
    const result = await listSnapshots(BACKUP_ROOT);
    expect(result).toEqual([]);
  });

  it('returns snapshot directory names sorted oldest-first', async () => {
    // Create snapshots out of order
    createSnapshotDir('20261020T120000');
    createSnapshotDir('20261018T090000');
    createSnapshotDir('20261019T153000');
    createSnapshotDir('20261018T080000');

    const result = await listSnapshots(BACKUP_ROOT);
    expect(result).toEqual([
      '20261018T080000',
      '20261018T090000',
      '20261019T153000',
      '20261020T120000',
    ]);
  });

  it('ignores snapshot directories not matching the timestamp pattern', async () => {
    createSnapshotDir('20261019T140000');
    createSnapshotDir('20261020T140000');
    createSnapshotDir('_joplin_active_');
    createSnapshotDir('some_random_folder');
    vol.writeFileSync(`${BACKUP_ROOT}/latest.txt`, '20261020T140000', { encoding: 'utf8' });

    const result = await listSnapshots(BACKUP_ROOT);
    expect(result).toEqual(['20261019T140000', '20261020T140000']);
  });

  it('ignores regular files even if their filename matches the timestamp pattern', async () => {
    createSnapshotDir('20261019T140000');
    vol.writeFileSync(`${BACKUP_ROOT}/20261020T140000`, 'file not directory', {
      encoding: 'utf8',
    });

    const result = await listSnapshots(BACKUP_ROOT);
    expect(result).toEqual(['20261019T140000']);
  });

  it('rethrows unexpected non-ENOENT errors from readdir', async () => {
    const origReaddir = memFsPromises.readdir;
    memFsPromises.readdir = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
      ) as typeof memFsPromises.readdir;

    await expect(listSnapshots(BACKUP_ROOT)).rejects.toMatchObject({
      code: 'EACCES',
    });

    memFsPromises.readdir = origReaddir;
  });

  it('handles string array results from mock readdir and uses fs.stat', async () => {
    createSnapshotDir('20261019T140000');
    createSnapshotDir('20261020T140000');
    vol.writeFileSync(`${BACKUP_ROOT}/20261021T140000`, 'file', { encoding: 'utf8' });

    const origReaddir = memFsPromises.readdir;
    memFsPromises.readdir = jest.fn().mockResolvedValue([
      '20261019T140000',
      '20261020T140000',
      '20261021T140000',
      '20261022T140000', // does not exist on disk, stat will throw
      'invalid_name',
    ]) as typeof memFsPromises.readdir;

    const result = await listSnapshots(BACKUP_ROOT);
    expect(result).toEqual(['20261019T140000', '20261020T140000']);

    memFsPromises.readdir = origReaddir;
  });
});

// ---------------------------------------------------------------------------
// pruneSnapshots
// ---------------------------------------------------------------------------

describe('pruneSnapshots', () => {
  beforeEach(() => {
    resetVolume();
    jest.restoreAllMocks();
  });

  it('deletes 5 oldest snapshots and keeps 5 newest when count is 10 and retention is 5', async () => {
    const snapshotNames = [
      '20261010T100000',
      '20261011T100000',
      '20261012T100000',
      '20261013T100000',
      '20261014T100000',
      '20261015T100000',
      '20261016T100000',
      '20261017T100000',
      '20261018T100000',
      '20261019T100000',
    ];

    for (const name of snapshotNames) {
      createSnapshotDir(name, { 'note.md': `content of ${name}` });
    }

    const pruned = await pruneSnapshots(BACKUP_ROOT, 5);

    expect(pruned).toEqual([
      '20261010T100000',
      '20261011T100000',
      '20261012T100000',
      '20261013T100000',
      '20261014T100000',
    ]);

    const remaining = await listSnapshots(BACKUP_ROOT);
    expect(remaining).toEqual([
      '20261015T100000',
      '20261016T100000',
      '20261017T100000',
      '20261018T100000',
      '20261019T100000',
    ]);

    // Check disk directly
    for (const deleted of pruned) {
      expect(vol.existsSync(`${BACKUP_ROOT}/${deleted}`)).toBe(false);
    }
    for (const kept of remaining) {
      expect(vol.existsSync(`${BACKUP_ROOT}/${kept}`)).toBe(true);
      expect(vol.existsSync(`${BACKUP_ROOT}/${kept}/note.md`)).toBe(true);
    }
  });

  it('performs zero deletions when snapshot count is less than retentionCount (3 snapshots, retention 5)', async () => {
    const snapshotNames = ['20261017T100000', '20261018T100000', '20261019T100000'];

    for (const name of snapshotNames) {
      createSnapshotDir(name, { 'note.md': `content of ${name}` });
    }

    const pruned = await pruneSnapshots(BACKUP_ROOT, 5);
    expect(pruned).toEqual([]);

    const remaining = await listSnapshots(BACKUP_ROOT);
    expect(remaining).toHaveLength(3);
    expect(remaining).toEqual(snapshotNames);
  });

  it('performs zero deletions when snapshot count equals retentionCount', async () => {
    const snapshotNames = ['20261017T100000', '20261018T100000', '20261019T100000'];

    for (const name of snapshotNames) {
      createSnapshotDir(name);
    }

    const pruned = await pruneSnapshots(BACKUP_ROOT, 3);
    expect(pruned).toEqual([]);

    const remaining = await listSnapshots(BACKUP_ROOT);
    expect(remaining).toHaveLength(3);
  });

  it('ignores non-matching directories and non-snapshot files during pruning', async () => {
    createSnapshotDir('20261017T100000');
    createSnapshotDir('20261018T100000');
    createSnapshotDir('20261019T100000');
    createSnapshotDir('_joplin_active_', { 'temp.txt': 'data' });
    createSnapshotDir('custom_backup_notes');
    vol.writeFileSync(`${BACKUP_ROOT}/latest.txt`, '20261019T100000', {
      encoding: 'utf8',
    });

    // 3 valid snapshots, retention 2 -> 1 oldest snapshot deleted
    const pruned = await pruneSnapshots(BACKUP_ROOT, 2);
    expect(pruned).toEqual(['20261017T100000']);

    // Non-snapshot dirs and files must still exist
    expect(vol.existsSync(`${BACKUP_ROOT}/_joplin_active_`)).toBe(true);
    expect(vol.existsSync(`${BACKUP_ROOT}/custom_backup_notes`)).toBe(true);
    expect(vol.existsSync(`${BACKUP_ROOT}/latest.txt`)).toBe(true);

    const remaining = await listSnapshots(BACKUP_ROOT);
    expect(remaining).toEqual(['20261018T100000', '20261019T100000']);
  });

  it('catches safeRmDir failure (simulated EBUSY) and leaves remaining snapshots unaffected', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshotNames = [
      '20261010T100000', // to delete: will succeed
      '20261011T100000', // to delete: will simulate EBUSY
      '20261012T100000', // to delete: will succeed
      '20261013T100000', // keep
      '20261014T100000', // keep
    ];

    for (const name of snapshotNames) {
      createSnapshotDir(name, { 'note.md': 'data' });
    }

    // Retention count = 2: 3 snapshots to delete (10, 11, 12).
    // Simulate safeRmDir throwing EBUSY on snapshot 20261011T100000
    jest.spyOn(platform, 'safeRmDir').mockImplementation(async (dirPath: string) => {
      if (dirPath.includes('20261011T100000')) {
        const err = Object.assign(new Error('resource busy or locked'), {
          code: 'EBUSY',
        });
        throw err;
      }
      // For others, perform actual rm
      await memFsPromises.rm(dirPath, { recursive: true, force: true });
    });

    await expect(pruneSnapshots(BACKUP_ROOT, 2)).resolves.not.toThrow();

    // 20261010T100000 was deleted
    expect(vol.existsSync(`${BACKUP_ROOT}/20261010T100000`)).toBe(false);
    // 20261011T100000 failed to delete due to EBUSY
    expect(vol.existsSync(`${BACKUP_ROOT}/20261011T100000`)).toBe(true);
    // 20261012T100000 deletion succeeded (remaining in prune queue unaffected)
    expect(vol.existsSync(`${BACKUP_ROOT}/20261012T100000`)).toBe(false);

    // Remaining snapshots that should be kept (13, 14) are intact
    expect(vol.existsSync(`${BACKUP_ROOT}/20261013T100000`)).toBe(true);
    expect(vol.existsSync(`${BACKUP_ROOT}/20261014T100000`)).toBe(true);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EBUSY'));

    warnSpy.mockRestore();
  });

  it('handles simulated EBUSY at the fs.rm level inside safeRmDir', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshotNames = [
      '20261010T100000',
      '20261011T100000',
      '20261012T100000',
      '20261013T100000',
      '20261014T100000',
    ];

    for (const name of snapshotNames) {
      createSnapshotDir(name, { 'note.md': 'data' });
    }

    const origRm = memFsPromises.rm;
    memFsPromises.rm = jest.fn().mockImplementation(async (path: string, options?: unknown) => {
      if (typeof path === 'string' && path.includes('20261011T100000')) {
        const err = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        throw err;
      }
      return origRm(path, options as never);
    }) as typeof memFsPromises.rm;

    // Prune with retention = 2: deletes 10, 11 (busy), 12.
    await expect(pruneSnapshots(BACKUP_ROOT, 2)).resolves.not.toThrow();

    // 10 was deleted
    expect(vol.existsSync(`${BACKUP_ROOT}/20261010T100000`)).toBe(false);
    // 11 had EBUSY in fs.rm, so safeRmDir logged warning and skipped
    expect(vol.existsSync(`${BACKUP_ROOT}/20261011T100000`)).toBe(true);
    // 12 was deleted
    expect(vol.existsSync(`${BACKUP_ROOT}/20261012T100000`)).toBe(false);
    // 13 and 14 kept
    expect(vol.existsSync(`${BACKUP_ROOT}/20261013T100000`)).toBe(true);
    expect(vol.existsSync(`${BACKUP_ROOT}/20261014T100000`)).toBe(true);

    memFsPromises.rm = origRm;
    warnSpy.mockRestore();
  });

  it('rethrows unexpected non-EBUSY errors from safeRmDir', async () => {
    const snapshotNames = ['20261010T100000', '20261011T100000'];
    for (const name of snapshotNames) {
      createSnapshotDir(name);
    }

    jest
      .spyOn(platform, 'safeRmDir')
      .mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

    await expect(pruneSnapshots(BACKUP_ROOT, 1)).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('preserves hardlinked files in remaining snapshots when older snapshot is deleted', async () => {
    // Simulate hardlink behavior in memfs
    const snap1 = `${BACKUP_ROOT}/20261010T100000`;
    const snap2 = `${BACKUP_ROOT}/20261011T100000`;
    vol.mkdirSync(snap1, { recursive: true });
    vol.mkdirSync(snap2, { recursive: true });

    vol.writeFileSync(`${snap1}/shared.md`, 'shared note content', {
      encoding: 'utf8',
    });
    // In memfs, linkSync creates a hard link
    vol.linkSync(`${snap1}/shared.md`, `${snap2}/shared.md`);

    // Prune with retention = 1 (snap1 will be deleted)
    await pruneSnapshots(BACKUP_ROOT, 1);

    expect(vol.existsSync(snap1)).toBe(false);
    expect(vol.existsSync(`${snap2}/shared.md`)).toBe(true);
    expect(vol.readFileSync(`${snap2}/shared.md`, 'utf8')).toBe('shared note content');
  });

  it('deletes all snapshots if retentionCount is 0 or negative', async () => {
    createSnapshotDir('20261010T100000');
    createSnapshotDir('20261011T100000');

    await pruneSnapshots(BACKUP_ROOT, 0);
    const remaining = await listSnapshots(BACKUP_ROOT);
    expect(remaining).toEqual([]);
  });
});
