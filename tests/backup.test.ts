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
  ACTIVE_DIR_NAME,
  collectActiveFiles,
  fingerprintsEqual,
  generateSnapshotName,
  getAllFolderIds,
  getChangeFingerprint,
  isTransientExportError,
  LATEST_FILENAME,
  LOCK_FILENAME,
  resolveBackupRoot,
  resolveLastSnapshot,
  resolveUniqueSnapshotName,
  retryTransient,
  runBackup,
  verifyBackup,
} from '../src/backup';
import { activeDirPath, snapshotDirPath } from '../src/backup';
import { readManifest, MANIFEST_FILENAME } from '../src/manifest';
import { mockState, resetMockJoplin } from '../src/__mocks__/joplin';
import { SETTING_KEYS, SETTING_SECTION_NAME } from '../src/settings';

const BACKUP_ROOT = '/backups';
const PROFILE = 'default';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function setSettings(overrides: Record<string, unknown> = {}): void {
  mockState.values = {
    [SETTING_KEYS.backupPath]: BACKUP_ROOT,
    [SETTING_KEYS.backupRetention]: 5,
    [SETTING_KEYS.backupInterval]: 0,
    [SETTING_KEYS.onlyOnChange]: true,
    [SETTING_KEYS.lastBackup]: '',
    [SETTING_KEYS.lastSnapshot]: '',
    ...overrides,
  };
}

/** Simulate `exportFolders` by writing a fixed set of files into the target dir. */
function stubExport(files: Array<{ path: string; content: string }>): void {
  mockState.commandHandlers.exportFolders = async (
    _ids: unknown,
    _format: unknown,
    target: unknown,
  ) => {
    if (Array.isArray(target)) return;
    const dir = String(target);
    for (const file of files) {
      const destination = path.join(dir, file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content);
    }
  };
}

function setData(options: {
  notes?: Array<{ id: string; updated_time: number }>;
  folders?: Array<{ id: string }>;
  resources?: Array<{ updated_time: number }>;
}): void {
  mockState.dataItems = {
    notes: options.notes ?? [],
    folders: options.folders ?? [{ id: 'folder-1' }],
    resources: options.resources ?? [],
  };
}

const FIXED_DATE = new Date('2026-01-02T03:04:05.000Z');

beforeEach(async () => {
  vol.reset();
  resetMockJoplin();
  await fs.mkdir(path.join(BACKUP_ROOT, PROFILE), { recursive: true });
  setSettings();
  setData({ notes: [{ id: 'n1', updated_time: 1000 }] });
  stubExport([{ path: 'note.md', content: 'hello' }]);
});

async function run(overrides: Record<string, unknown> = {}) {
  return runBackup({
    backupRoot: path.join(BACKUP_ROOT, PROFILE),
    now: FIXED_DATE,
    ...overrides,
  });
}

describe('pure helpers', () => {
  it('formats snapshot names in UTC', () => {
    expect(generateSnapshotName(new Date('2026-01-02T03:04:05.000Z'))).toBe('20260102T030405');
  });

  it('resolves the backup root with and without a profile', () => {
    expect(resolveBackupRoot('/tmp/backups/')).toBe('/tmp/backups');
    expect(resolveBackupRoot('/tmp/backups', 'work')).toBe('/tmp/backups/work');
    expect(resolveBackupRoot('/tmp/backups', '  ')).toBe('/tmp/backups');
  });

  it('compares fingerprints strictly, rejecting missing ones', () => {
    const a = { maxNoteUpdatedTime: 1, noteCount: 2, maxResourceUpdatedTime: 3 };
    expect(fingerprintsEqual(a, { ...a })).toBe(true);
    expect(fingerprintsEqual(a, { ...a, noteCount: 3 })).toBe(false);
    expect(fingerprintsEqual(a, undefined)).toBe(false);
    expect(fingerprintsEqual(undefined, a)).toBe(false);
  });

  it('detects transient export errors', () => {
    expect(isTransientExportError(new Error('database is locked'))).toBe(true);
    expect(isTransientExportError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true);
    expect(isTransientExportError(new Error('permission denied'))).toBe(false);
  });
});
describe('getChangeFingerprint', () => {
  it('collects max note time, note count, and max resource time', async () => {
    setData({
      notes: [
        { id: 'n1', updated_time: 100 },
        { id: 'n2', updated_time: 500 },
      ],
      resources: [{ updated_time: 42 }, { updated_time: 900 }],
    });

    await expect(getChangeFingerprint()).resolves.toEqual({
      maxNoteUpdatedTime: 500,
      noteCount: 2,
      maxResourceUpdatedTime: 900,
    });
  });

  it('paginates across multiple pages', async () => {
    mockState.dataPageLimit = 2;
    setData({
      notes: [
        { id: 'n1', updated_time: 1 },
        { id: 'n2', updated_time: 2 },
        { id: 'n3', updated_time: 3 },
        { id: 'n4', updated_time: 4 },
        { id: 'n5', updated_time: 5 },
      ],
    });

    const fingerprint = await getChangeFingerprint();
    expect(fingerprint.noteCount).toBe(5);
    expect(fingerprint.maxNoteUpdatedTime).toBe(5);
  });
});

describe('getAllFolderIds', () => {
  it('returns every folder id', async () => {
    setData({ folders: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    await expect(getAllFolderIds()).resolves.toEqual(['a', 'b', 'c']);
  });
});

describe('snapshot naming', () => {
  it('appends a suffix when the base name already exists', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const base = '20260102T030405';
    await fs.mkdir(path.join(root, base), { recursive: true });
    await fs.mkdir(path.join(root, `${base}-2`), { recursive: true });

    await expect(resolveUniqueSnapshotName(root, base)).resolves.toBe(`${base}-3`);
  });

  it('uses the base name when free', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    await expect(resolveUniqueSnapshotName(root, '20260102T030405')).resolves.toBe(
      '20260102T030405',
    );
  });
});

describe('resolveLastSnapshot', () => {
  it('prefers the explicitly requested snapshot', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    await fs.mkdir(path.join(root, '20260101T000000'), { recursive: true });
    await fs.mkdir(path.join(root, '20260102T000000'), { recursive: true });
    await fs.writeFile(path.join(root, LATEST_FILENAME), '20260102T000000');

    await expect(resolveLastSnapshot(root, '20260101T000000')).resolves.toBe('20260101T000000');
  });

  it('falls back to latest.txt then the newest directory', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    await fs.mkdir(path.join(root, '20260101T000000'), { recursive: true });
    await fs.mkdir(path.join(root, '20260102T000000'), { recursive: true });

    await expect(resolveLastSnapshot(root)).resolves.toBe('20260102T000000');

    await fs.writeFile(path.join(root, LATEST_FILENAME), '20260101T000000');
    await expect(resolveLastSnapshot(root)).resolves.toBe('20260101T000000');
  });

  it('returns null when there are no snapshots', async () => {
    await expect(resolveLastSnapshot(path.join(BACKUP_ROOT, PROFILE))).resolves.toBeNull();
  });
});

describe('collectActiveFiles', () => {
  it('lists relative paths', async () => {
    const dir = path.join(BACKUP_ROOT, PROFILE, ACTIVE_DIR_NAME);
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a.md'), 'a');
    await fs.writeFile(path.join(dir, 'sub', 'b.md'), 'b');

    const files = await collectActiveFiles(dir);
    expect(files.sort()).toEqual(['a.md', 'sub/b.md']);
  });
});

describe('retryTransient', () => {
  it('retries transient errors then succeeds', async () => {
    let attempts = 0;
    const result = await retryTransient(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('database is locked');
      return 'ok';
    }, 5);

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry non-transient errors', async () => {
    let attempts = 0;
    await expect(
      retryTransient(async () => {
        attempts += 1;
        throw new Error('fatal');
      }, 5),
    ).rejects.toThrow('fatal');
    expect(attempts).toBe(1);
  });
});

describe('runBackup — happy path', () => {
  it('creates a snapshot, manifest, and latest.txt', async () => {
    const result = await run();

    expect(result.status).toBe('success');
    expect(result.snapshotName).toBe('20260102T030405');
    expect(result.fileCount).toBe(1);

    const snapshotDir = snapshotDirPath(path.join(BACKUP_ROOT, PROFILE), '20260102T030405');
    const manifest = await readManifest(snapshotDir);
    expect(manifest?.fileCount).toBe(1);
    expect(manifest?.files).toEqual([{ path: 'note.md', size: 5, sha256: sha256('hello') }]);

    await expect(
      fs.readFile(path.join(BACKUP_ROOT, PROFILE, LATEST_FILENAME), 'utf8'),
    ).resolves.toBe('20260102T030405');

    expect(mockState.values[SETTING_KEYS.lastSnapshot]).toBe('20260102T030405');
    expect(mockState.values[SETTING_KEYS.lastBackup]).toBe(FIXED_DATE.toISOString());
  });

  it('cleans the staging dir and releases the lock afterwards', async () => {
    await run();

    const activeDir = activeDirPath(path.join(BACKUP_ROOT, PROFILE));
    await expect(fs.stat(activeDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(BACKUP_ROOT, PROFILE, LOCK_FILENAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('prunes to the retention limit', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    for (const name of ['20251201T000000', '20251202T000000', '20251203T000000']) {
      await fs.mkdir(path.join(root, name), { recursive: true });
    }
    setSettings({ [SETTING_KEYS.backupRetention]: 2 });

    await run();

    // Retention 2 keeps the two newest: the pre-existing 20251203 plus the new one.
    const snapshots = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{8}T/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(snapshots).toEqual(['20251203T000000', '20260102T030405']);
  });
});

describe('runBackup — onlyOnChange', () => {
  it('skips when the fingerprint is unchanged', async () => {
    const first = await run();
    expect(first.status).toBe('success');

    stubExport([{ path: 'note.md', content: 'hello' }]);
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('skipped');
    await expect(fs.stat(path.join(BACKUP_ROOT, PROFILE, '20260102T040000'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it('takes a new snapshot when a note is deleted (count changes)', async () => {
    await run();

    setData({ notes: [], folders: [{ id: 'folder-1' }] });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
    expect(second.snapshotName).toBe('20260102T040000');
  });

  it('takes a new snapshot when a resource changes', async () => {
    setData({ notes: [{ id: 'n1', updated_time: 1000 }], resources: [{ updated_time: 10 }] });
    await run();

    setData({ notes: [{ id: 'n1', updated_time: 1000 }], resources: [{ updated_time: 999 }] });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
    expect(second.snapshotName).toBe('20260102T040000');
  });

  it('always snapshots when the stored manifest has no fingerprint', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const first = await run();
    const snapshotDir = snapshotDirPath(root, first.snapshotName!);

    const manifest = await readManifest(snapshotDir);
    const { changeFingerprint: _dropped, ...legacy } = manifest!;
    await fs.writeFile(path.join(snapshotDir, MANIFEST_FILENAME), JSON.stringify(legacy));

    stubExport([{ path: 'note.md', content: 'hello' }]);
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });
    expect(second.status).toBe('success');
  });
});

describe('runBackup — failures', () => {
  it('errors and cleans up when the export produces no files', async () => {
    stubExport([]);

    await expect(run()).rejects.toThrow(/no files/);

    const root = path.join(BACKUP_ROOT, PROFILE);
    await expect(fs.stat(activeDirPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, LOCK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails immediately when the lock is already held', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    await fs.writeFile(path.join(root, LOCK_FILENAME), new Date().toISOString());

    await expect(run()).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('retries a transient export error then succeeds', async () => {
    let attempts = 0;
    mockState.commandHandlers.exportFolders = async (_ids, _format, target) => {
      attempts += 1;
      if (attempts === 1) throw new Error('database is locked');
      const dir = String(target);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'note.md'), 'hello');
    };

    const result = await run({ exportRetries: 3 });
    expect(result.status).toBe('success');
    expect(attempts).toBe(2);
  });
});

describe('runBackup — collision', () => {
  it('does not clobber an existing snapshot of the same second', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const first = await run();
    expect(first.snapshotName).toBe('20260102T030405');

    // Force a content change so the second run is not skipped.
    setData({ notes: [{ id: 'n1', updated_time: 2000 }] });
    stubExport([{ path: 'note.md', content: 'hello' }]);
    const second = await run();

    expect(second.snapshotName).toBe('20260102T030405-2');
    await expect(fs.stat(snapshotDirPath(root, '20260102T030405'))).resolves.toBeTruthy();
    await expect(fs.stat(snapshotDirPath(root, '20260102T030405-2'))).resolves.toBeTruthy();
  });
});

describe('runBackup — version info', () => {
  it('stores the version from joplin.versionInfo()', async () => {
    await run();
    const manifest = await readManifest(
      snapshotDirPath(path.join(BACKUP_ROOT, PROFILE), '20260102T030405'),
    );
    expect(manifest?.joplinVersion).toBe('3.7.0');
  });

  it('falls back to an empty version when versionInfo throws', async () => {
    mockState.versionError = new Error('boom');
    await run();
    const manifest = await readManifest(
      snapshotDirPath(path.join(BACKUP_ROOT, PROFILE), '20260102T030405'),
    );
    expect(manifest?.joplinVersion).toBe('');
  });
});

describe('verifyBackup', () => {
  it('verifies a valid snapshot', async () => {
    await run();
    const result = await verifyBackup({ backupRoot: path.join(BACKUP_ROOT, PROFILE) });

    expect(result).toMatchObject({ ok: true, total: 1, matched: 1, mismatches: [] });
    expect(result.message).toMatch(/Verified/);
  });

  it('reports mismatches for a corrupted file', async () => {
    const first = await run();
    const root = path.join(BACKUP_ROOT, PROFILE);
    await fs.writeFile(
      path.join(snapshotDirPath(root, first.snapshotName!), 'note.md'),
      'tampered',
    );

    const result = await verifyBackup({ backupRoot: root });

    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(['note.md']);
    expect(result.message).toMatch(/failed/);
  });

  it('reports a missing file as a mismatch', async () => {
    const first = await run();
    const root = path.join(BACKUP_ROOT, PROFILE);
    await fs.rm(path.join(snapshotDirPath(root, first.snapshotName!), 'note.md'));

    const result = await verifyBackup({ backupRoot: root });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(['note.md']);
  });

  it('reports when there is nothing to verify', async () => {
    const result = await verifyBackup({ backupRoot: path.join(BACKUP_ROOT, PROFILE) });
    expect(result).toMatchObject({ ok: false, snapshotName: null });
  });

  it('reports when the manifest is missing', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const first = await run();
    await fs.rm(path.join(snapshotDirPath(root, first.snapshotName!), MANIFEST_FILENAME));

    const result = await verifyBackup({ backupRoot: root });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/manifest/);
  });
});

describe('settings section', () => {
  it('uses the documented section name', () => {
    expect(SETTING_SECTION_NAME).toBe('incrementalBackup');
  });
});
