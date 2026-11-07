import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return { default: memfs.fs.promises, ...memfs.fs.promises };
});

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { vol } from 'memfs';
import joplin from '../src/__mocks__/joplin';
import { digestPairs } from '../src/backup';
import {
  ACTIVE_DIR_PREFIX,
  createStagingDirName,
  describeWarnings,
  extractExportWarnings,
  fingerprintsEqual,
  generateSnapshotName,
  getAllFolderIds,
  getChangeFingerprint,
  isTransientExportError,
  LATEST_FILENAME,
  listStagingDirs,
  LOCK_FILENAME,
  recoverBackupDirs,
  resolveBackupRoot,
  resolveLastSnapshot,
  resolveUniqueSnapshotName,
  retryTransient,
  runBackup,
  verifyBackup,
} from '../src/backup';
import { snapshotDirPath } from '../src/backup';
import { readManifest, MANIFEST_FILENAME } from '../src/manifest';
import { logger } from '../src/logger';
import { mockState, resetMockJoplin } from '../src/__mocks__/joplin';
import { MISSING_BACKUP_PATH_MESSAGE, SETTING_KEYS, SETTING_SECTION_NAME } from '../src/settings';

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
  folders?: Array<{ id: string; updated_time?: number }>;
  resources?: Array<{ id: string; updated_time: number }>;
  tags?: Array<{ id: string; updated_time?: number }>;
  /** Tag id → ids of the notes carrying that tag. */
  noteTags?: Record<string, string[]>;
}): void {
  mockState.dataItems = {
    notes: options.notes ?? [],
    folders: options.folders ?? [{ id: 'folder-1' }],
    resources: options.resources ?? [],
    tags: options.tags ?? [],
  };
  for (const [tagId, noteIds] of Object.entries(options.noteTags ?? {})) {
    mockState.dataItems[`tags/${tagId}/notes`] = noteIds.map((id) => ({ id }));
  }
}

const FIXED_DATE = new Date('2026-01-02T03:04:05.000Z');

beforeEach(async () => {
  vol.reset();
  resetMockJoplin();
  await fs.mkdir(path.join(BACKUP_ROOT, PROFILE), { recursive: true });
  setSettings();
  setData({ notes: [{ id: 'n1', updated_time: 1000 }], folders: [] });
  stubExport([{ path: 'n1.md', content: 'hello' }]);
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
    const a = {
      maxNoteUpdatedTime: 1,
      noteCount: 2,
      maxResourceUpdatedTime: 3,
      noteDigest: 'n',
      resourceDigest: 'r',
      folderDigest: 'f',
      tagDigest: 't',
      noteTagDigest: 'nt',
    };
    expect(fingerprintsEqual(a, { ...a })).toBe(true);
    expect(fingerprintsEqual(a, { ...a, noteCount: 3 })).toBe(false);
    expect(fingerprintsEqual(a, { ...a, folderDigest: 'f2' })).toBe(false);
    expect(fingerprintsEqual(a, { ...a, noteTagDigest: undefined })).toBe(false);
    expect(fingerprintsEqual(a, undefined)).toBe(false);
    expect(fingerprintsEqual(undefined, a)).toBe(false);
  });

  it('treats a legacy fingerprint (missing digests) as different', () => {
    const legacy = { maxNoteUpdatedTime: 1, noteCount: 2, maxResourceUpdatedTime: 3 };
    expect(fingerprintsEqual(legacy, { ...legacy })).toBe(false);
  });

  it('digestPairs is order-independent and sensitive to every pair', () => {
    const base = digestPairs([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(
      digestPairs([
        ['b', '2'],
        ['a', '1'],
      ]),
    ).toBe(base);
    expect(
      digestPairs([
        ['a', '1'],
        ['b', '3'],
      ]),
    ).not.toBe(base);
    expect(digestPairs([['a', '1']])).not.toBe(base);
  });

  it('detects transient export errors', () => {
    expect(isTransientExportError(new Error('database is locked'))).toBe(true);
    expect(isTransientExportError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true);
    expect(isTransientExportError(new Error('permission denied'))).toBe(false);
  });
});

describe('staging directories', () => {
  it('creates a unique directory name per run', () => {
    const first = createStagingDirName(FIXED_DATE);
    const second = createStagingDirName(FIXED_DATE);

    expect(first).not.toBe(second);
    expect(first.startsWith(ACTIVE_DIR_PREFIX)).toBe(true);
    expect(first).toMatch(/^_joplin_active_\d{8}T\d{6}_\d+_[a-z0-9]+$/);
  });

  it('lists only staging directories', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    await fs.mkdir(path.join(root, createStagingDirName()), { recursive: true });
    await fs.mkdir(path.join(root, '20260102T030405'), { recursive: true });
    await fs.writeFile(path.join(root, 'latest.txt'), 'x');

    const staging = await listStagingDirs(root);

    expect(staging).toHaveLength(1);
    expect(staging[0].startsWith(ACTIVE_DIR_PREFIX)).toBe(true);
  });

  it('leaves no staging directory behind after a run', async () => {
    await run();

    expect(await listStagingDirs(path.join(BACKUP_ROOT, PROFILE))).toEqual([]);
  });
});

describe('recoverBackupDirs', () => {
  it('removes stale staging directories', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const stale = path.join(root, createStagingDirName());
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(path.join(stale, 'leftover.md'), 'stale');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(stale, old, old);

    await recoverBackupDirs({ backupRoot: root });

    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a staging directory that was touched recently', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const fresh = path.join(root, createStagingDirName());
    await fs.mkdir(fresh, { recursive: true });

    await recoverBackupDirs({ backupRoot: root });

    await expect(fs.stat(fresh)).resolves.toBeDefined();
  });

  it('keeps everything when another backup holds a fresh lock', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const staging = path.join(root, createStagingDirName());
    await fs.mkdir(staging, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(staging, old, old);
    await fs.writeFile(path.join(root, LOCK_FILENAME), new Date().toISOString());

    await recoverBackupDirs({ backupRoot: root });

    await expect(fs.stat(staging)).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, LOCK_FILENAME))).resolves.toBeDefined();
  });
});
describe('unset backup directory', () => {
  beforeEach(() => {
    setSettings({ [SETTING_KEYS.backupPath]: '' });
  });

  it('runBackup fails with a user-facing error and exports nothing', async () => {
    await expect(runBackup()).rejects.toThrow(MISSING_BACKUP_PATH_MESSAGE);
    expect(mockState.executedCommands).toHaveLength(0);
  });

  it('verifyBackup fails with a user-facing error', async () => {
    await expect(verifyBackup()).rejects.toThrow(MISSING_BACKUP_PATH_MESSAGE);
  });

  it('recoverBackupDirs is a quiet no-op', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await expect(recoverBackupDirs()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('records the failure so "Show last backup result" and a toast report it', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(runBackup()).rejects.toThrow(MISSING_BACKUP_PATH_MESSAGE);

    expect(String(mockState.values[SETTING_KEYS.lastBackupResult])).toMatch(
      /failed — .*No backup directory is set/,
    );
    const record = JSON.parse(String(mockState.values[SETTING_KEYS.lastBackupResultJson]));
    expect(record).toMatchObject({ status: 'failed', error: MISSING_BACKUP_PATH_MESSAGE });
    expect(mockState.toastMessages.some((message) => /Backup failed/.test(message))).toBe(true);
  });
});

describe('relative backup directory', () => {
  beforeEach(() => {
    setSettings({ [SETTING_KEYS.backupPath]: 'relative/backups' });
  });

  it('runBackup refuses it and creates nothing in the working directory', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(runBackup()).rejects.toThrow(/not an absolute path/);
    expect(mockState.executedCommands).toHaveLength(0);
    await expect(fs.stat('relative')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recoverBackupDirs leaves it alone', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await recoverBackupDirs();
    expect(warn).not.toHaveBeenCalled();
    await expect(fs.stat('relative')).rejects.toMatchObject({ code: 'ENOENT' });
    warn.mockRestore();
  });
});

describe('runBackup — setup failures', () => {
  it('records a disk-space failure before the lock is taken', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(run({ minFreeBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow(
      /Not enough free disk space/,
    );
    expect(String(mockState.values[SETTING_KEYS.lastBackupResult])).toMatch(/failed/);
  });

  it('does not record lock contention as a failure of the running backup', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    await fs.writeFile(path.join(root, LOCK_FILENAME), new Date().toISOString());

    await expect(run()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(mockState.values[SETTING_KEYS.lastBackupResult]).toBeUndefined();
  });
});

describe('getChangeFingerprint', () => {
  it('collects note, resource, notebook and tag counts and times', async () => {
    setData({
      notes: [
        { id: 'n1', updated_time: 100 },
        { id: 'n2', updated_time: 500 },
      ],
      resources: [
        { id: 'r1', updated_time: 42 },
        { id: 'r2', updated_time: 900 },
      ],
      folders: [
        { id: 'f1', updated_time: 7 },
        { id: 'f2', updated_time: 70 },
      ],
      tags: [{ id: 't1', updated_time: 33 }],
      noteTags: { t1: ['n1'] },
    });

    const fingerprint = await getChangeFingerprint();
    expect(fingerprint).toEqual({
      maxNoteUpdatedTime: 500,
      noteCount: 2,
      maxResourceUpdatedTime: 900,
      noteDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      resourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      folderDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      tagDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      noteTagDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('leaves out note-tag links (and their queries) when asked to', async () => {
    setData({ tags: [{ id: 't1' }], noteTags: { t1: ['n1'] } });
    const get = vi.spyOn(joplin.data, 'get');
    try {
      const fingerprint = await getChangeFingerprint({ includeNoteTags: false });
      expect(fingerprint.noteTagDigest).toBeUndefined();
      expect(get.mock.calls.some(([dataPath]) => (dataPath as string[]).length > 1)).toBe(false);
    } finally {
      get.mockRestore();
    }
  });

  it('produces an order-independent note-tag digest', async () => {
    setData({
      tags: [{ id: 't1' }, { id: 't2' }],
      noteTags: { t1: ['n1', 'n2'], t2: ['n3'] },
    });
    const a = await getChangeFingerprint();

    setData({
      tags: [{ id: 't2' }, { id: 't1' }],
      noteTags: { t1: ['n2', 'n1'], t2: ['n3'] },
    });
    const b = await getChangeFingerprint();

    expect(a.noteTagDigest).toBe(b.noteTagDigest);
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
    expect(manifest?.files).toEqual([{ path: 'n1.md', size: 5, sha256: sha256('hello') }]);

    await expect(
      fs.readFile(path.join(BACKUP_ROOT, PROFILE, LATEST_FILENAME), 'utf8'),
    ).resolves.toBe('20260102T030405');

    expect(mockState.values[SETTING_KEYS.lastSnapshot]).toBe('20260102T030405');
    expect(mockState.values[SETTING_KEYS.lastBackup]).toBe(FIXED_DATE.toISOString());
  });

  it('cleans the staging dir and releases the lock afterwards', async () => {
    await run();

    const root = path.join(BACKUP_ROOT, PROFILE);
    expect(await listStagingDirs(root)).toEqual([]);
    await expect(fs.stat(path.join(root, LOCK_FILENAME))).rejects.toMatchObject({
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

describe('runBackup — skipIfBackedUpAfter', () => {
  const SEEN = Date.parse('2026-01-01T00:00:00.000Z');

  it('skips without touching the result when a newer backup was recorded', async () => {
    const newer = new Date(SEEN + 60 * 1000).toISOString();
    setSettings({ [SETTING_KEYS.lastBackup]: newer, [SETTING_KEYS.lastBackupResult]: 'previous' });

    const result = await run({ skipIfBackedUpAfter: SEEN });

    expect(result.status).toBe('skipped');
    expect(result.snapshotName).toBeUndefined();
    expect(mockState.values[SETTING_KEYS.lastBackup]).toBe(newer);
    expect(mockState.values[SETTING_KEYS.lastBackupResult]).toBe('previous');
    const root = path.join(BACKUP_ROOT, PROFILE);
    expect(await listStagingDirs(root)).toEqual([]);
    await expect(fs.stat(path.join(root, LOCK_FILENAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('runs when lastBackup is unchanged', async () => {
    setSettings({ [SETTING_KEYS.lastBackup]: new Date(SEEN).toISOString() });

    const result = await run({ skipIfBackedUpAfter: SEEN });

    expect(result.status).toBe('success');
  });

  it('skips when a first backup appeared after "never backed up" was seen', async () => {
    setSettings({ [SETTING_KEYS.lastBackup]: new Date(SEEN).toISOString() });

    const result = await run({ skipIfBackedUpAfter: Number.NEGATIVE_INFINITY });

    expect(result.status).toBe('skipped');
  });
});

describe('runBackup — onlyOnChange', () => {
  it('skips when the fingerprint is unchanged', async () => {
    const first = await run();
    expect(first.status).toBe('success');

    stubExport([{ path: 'n1.md', content: 'hello' }]);
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
    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      resources: [{ id: 'r1', updated_time: 10 }],
    });
    await run();

    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      resources: [{ id: 'r1', updated_time: 999 }],
    });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
    expect(second.snapshotName).toBe('20260102T040000');
  });

  it('takes a new snapshot when a resource is deleted', async () => {
    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      resources: [
        { id: 'r1', updated_time: 10 },
        { id: 'r2', updated_time: 5 },
      ],
    });
    await run();

    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      resources: [{ id: 'r1', updated_time: 10 }],
    });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
  });

  it('takes a new snapshot when a notebook is renamed', async () => {
    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      folders: [{ id: 'f1', updated_time: 1 }],
    });
    await run();

    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      folders: [{ id: 'f1', updated_time: 2 }],
    });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
  });

  it('takes a new snapshot when a notebook is added', async () => {
    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      folders: [{ id: 'f1', updated_time: 1 }],
    });
    await run();

    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      folders: [
        { id: 'f1', updated_time: 1 },
        { id: 'f2', updated_time: 1 },
      ],
    });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
  });

  it('takes a new snapshot when a tag is renamed', async () => {
    setData({ notes: [{ id: 'n1', updated_time: 1000 }], tags: [{ id: 't1', updated_time: 1 }] });
    await run();

    setData({ notes: [{ id: 'n1', updated_time: 1000 }], tags: [{ id: 't1', updated_time: 2 }] });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
  });

  it('takes a new snapshot when a note is tagged without other timestamps changing', async () => {
    const base = {
      notes: [{ id: 'n1', updated_time: 1000 }],
      tags: [{ id: 't1', updated_time: 1 }],
    };
    setData({ ...base, noteTags: { t1: [] } });
    await run();

    setData({ ...base, noteTags: { t1: ['n1'] } });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
  });

  it('skips when notebooks, tags and links are all unchanged', async () => {
    const data = {
      notes: [{ id: 'n1', updated_time: 1000 }],
      folders: [{ id: 'f1', updated_time: 1 }],
      tags: [{ id: 't1', updated_time: 1 }],
      noteTags: { t1: ['n1'] },
    };
    setData(data);
    await run();

    setData(data);
    stubExport([{ path: 'n1.md', content: 'hello' }]);
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('skipped');
  });

  it('takes one new snapshot when the stored fingerprint predates the newer fields', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const first = await run();
    const snapshotDir = snapshotDirPath(root, first.snapshotName!);

    const manifest = (await readManifest(snapshotDir))!;
    const { maxNoteUpdatedTime, noteCount, maxResourceUpdatedTime } = manifest.changeFingerprint;
    await fs.writeFile(
      path.join(snapshotDir, MANIFEST_FILENAME),
      JSON.stringify({
        ...manifest,
        changeFingerprint: { maxNoteUpdatedTime, noteCount, maxResourceUpdatedTime },
      }),
    );

    stubExport([{ path: 'n1.md', content: 'hello' }]);
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });
    expect(second.status).toBe('success');

    stubExport([{ path: 'n1.md', content: 'hello' }]);
    const third = await run({ now: new Date('2026-01-02T05:00:00.000Z') });
    expect(third.status).toBe('skipped');
  });

  it('takes a new snapshot when a synced edit arrives with an older timestamp', async () => {
    // n2 is the newest local edit; n1 was edited elsewhere earlier and syncs
    // in afterwards. Max time and count are unchanged, so only the digest
    // can notice.
    setData({
      notes: [
        { id: 'n1', updated_time: 100 },
        { id: 'n2', updated_time: 500 },
      ],
    });
    await run();

    setData({
      notes: [
        { id: 'n1', updated_time: 300 },
        { id: 'n2', updated_time: 500 },
      ],
    });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
  });

  it('takes a new snapshot when a notebook rename syncs in with an older timestamp', async () => {
    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      folders: [
        { id: 'f1', updated_time: 1 },
        { id: 'f2', updated_time: 50 },
      ],
    });
    await run();

    setData({
      notes: [{ id: 'n1', updated_time: 1000 }],
      folders: [
        { id: 'f1', updated_time: 20 },
        { id: 'f2', updated_time: 50 },
      ],
    });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
  });

  it('takes a new snapshot when one note is deleted and an older one imported', async () => {
    setData({
      notes: [
        { id: 'n1', updated_time: 1000 },
        { id: 'n2', updated_time: 10 },
      ],
    });
    await run();

    setData({
      notes: [
        { id: 'n1', updated_time: 1000 },
        { id: 'n3', updated_time: 5 },
      ],
    });
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

    expect(second.status).toBe('success');
  });

  it('always snapshots when the stored manifest has no fingerprint', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const first = await run();
    const snapshotDir = snapshotDirPath(root, first.snapshotName!);

    const manifest = await readManifest(snapshotDir);
    const { changeFingerprint: _dropped, ...legacy } = manifest!;
    await fs.writeFile(path.join(snapshotDir, MANIFEST_FILENAME), JSON.stringify(legacy));

    stubExport([{ path: 'n1.md', content: 'hello' }]);
    const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });
    expect(second.status).toBe('success');
  });
});

describe('describeWarnings', () => {
  it('is empty when there are no warnings', () => {
    expect(describeWarnings([])).toBe('');
  });

  it('counts only exporter warnings as skipped items', () => {
    const text = describeWarnings([
      { kind: 'export', message: 'a' },
      { kind: 'export', message: 'b' },
    ]);
    expect(text).toMatch(/2 item\(s\) were skipped by the export/);
    expect(text).toMatch(/may be incomplete/);
  });

  it('lists the count and kind of each completeness warning', () => {
    const text = describeWarnings([
      { kind: 'completeness', message: 'long note text', summary: '3 note(s)' },
      { kind: 'completeness', message: 'long resource text', summary: '40 of 200 resource(s)' },
    ]);
    expect(text).not.toMatch(/skipped by the export/);
    expect(text).toMatch(/Missing from the export: 3 note\(s\), 40 of 200 resource\(s\)\./);
    expect(text).toMatch(/may be incomplete/);
  });

  it('mentions storage warnings without calling the snapshot incomplete', () => {
    const text = describeWarnings([{ kind: 'storage', message: 'no hardlinks' }]);
    expect(text).toMatch(/Deduplication was limited/);
    expect(text).toMatch(/1 warning\(s\)/);
    expect(text).not.toMatch(/may be incomplete/);
  });
});

describe('runBackup — success bookkeeping', () => {
  it('reports the hardlink fallback as a warning without calling the snapshot incomplete', async () => {
    await run();

    const link = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }));
    try {
      stubExport([{ path: 'n1.md', content: 'hello' }]);
      setData({ notes: [{ id: 'n1', updated_time: 2000 }], folders: [] });
      const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

      expect(second.status).toBe('success');
      expect(second.warnings).toEqual([expect.stringMatching(/Hardlinks are not supported/)]);
      expect(second.message).not.toMatch(/skipped by the export/);
      expect(second.message).not.toMatch(/may be incomplete/);
      expect(second.message).toMatch(/Deduplication was limited/);
    } finally {
      link.mockRestore();
    }
  });

  it('reports per-file dedup failures as a storage warning', async () => {
    await run();

    const link = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('i/o error'), { code: 'EIO' }));
    try {
      stubExport([{ path: 'n1.md', content: 'hello' }]);
      setData({ notes: [{ id: 'n1', updated_time: 2000 }], folders: [] });
      const second = await run({ now: new Date('2026-01-02T04:00:00.000Z') });

      expect(second.status).toBe('success');
      expect(second.warnings).toEqual([
        expect.stringMatching(/1 file\(s\) could not be deduplicated/),
      ]);
      expect(second.message).toMatch(/Deduplication was limited/);
      expect(second.message).not.toMatch(/may be incomplete/);
    } finally {
      link.mockRestore();
    }
  });

  it('persists lastBackup/lastSnapshot and logs completion exactly once', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const result = await run();

      const writes = (key: string) => mockState.setValues.filter((entry) => entry.key === key);
      expect(writes(SETTING_KEYS.lastBackup)).toHaveLength(1);
      expect(writes(SETTING_KEYS.lastSnapshot)).toEqual([
        { key: SETTING_KEYS.lastSnapshot, value: result.snapshotName },
      ]);
      const completions = info.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.startsWith('Backup complete'),
      );
      expect(completions).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });
});

describe('runBackup — failures', () => {
  it('aborts before locking or snapshotting when disk space is insufficient', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);

    await expect(run({ minFreeBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow(
      /Not enough free disk space/,
    );

    // The gate runs before the lock is taken and before any export.
    await expect(fs.stat(path.join(root, LOCK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await listStagingDirs(root)).toEqual([]);
    expect(mockState.executedCommands.some((c) => c.name === 'exportFolders')).toBe(false);
  });

  it('errors and cleans up when the export produces no files', async () => {
    stubExport([]);

    await expect(run()).rejects.toThrow(/no files/);

    const root = path.join(BACKUP_ROOT, PROFILE);
    expect(await listStagingDirs(root)).toEqual([]);
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
      await fs.writeFile(path.join(dir, 'n1.md'), 'hello');
    };

    const result = await run({ exportRetries: 3 });
    expect(result.status).toBe('success');
    expect(attempts).toBe(2);
  });
});

describe('export warnings', () => {
  it('extractExportWarnings returns [] for non-object or missing warnings', () => {
    expect(extractExportWarnings(undefined)).toEqual([]);
    expect(extractExportWarnings(null)).toEqual([]);
    expect(extractExportWarnings('nope')).toEqual([]);
    expect(extractExportWarnings({})).toEqual([]);
    expect(extractExportWarnings({ warnings: 'not-an-array' })).toEqual([]);
  });

  it('extractExportWarnings keeps only string warnings', () => {
    expect(extractExportWarnings({ warnings: ['a', 1, null, 'b'] })).toEqual(['a', 'b']);
  });

  it('surfaces exporter warnings in the result and logs them', async () => {
    mockState.commandHandlers.exportFolders = async (_ids, _format, target) => {
      const dir = String(target);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'n1.md'), 'hello');
      return { warnings: ['This item is currently encrypted: note "x" and was not exported.'] };
    };
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await run();

    expect(result.status).toBe('success');
    expect(result.warnings).toEqual([
      'This item is currently encrypted: note "x" and was not exported.',
    ]);
    expect(result.message).toMatch(/may be incomplete/);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Export reported 1 warning'),
      expect.any(Array),
    );
    warn.mockRestore();
  });

  it('reports no warnings for a clean export', async () => {
    const result = await run();
    expect(result.warnings).toEqual([]);
    expect(result.message).not.toMatch(/incomplete/);
  });
});

describe('runBackup — collision', () => {
  it('does not clobber an existing snapshot of the same second', async () => {
    const root = path.join(BACKUP_ROOT, PROFILE);
    const first = await run();
    expect(first.snapshotName).toBe('20260102T030405');

    // Force a content change so the second run is not skipped.
    setData({ notes: [{ id: 'n1', updated_time: 2000 }] });
    stubExport([{ path: 'n1.md', content: 'hello' }]);
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
    await fs.writeFile(path.join(snapshotDirPath(root, first.snapshotName!), 'n1.md'), 'tampered');

    const result = await verifyBackup({ backupRoot: root });

    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(['n1.md']);
    expect(result.message).toMatch(/failed/);
  });

  it('reports a missing file as a mismatch', async () => {
    const first = await run();
    const root = path.join(BACKUP_ROOT, PROFILE);
    await fs.rm(path.join(snapshotDirPath(root, first.snapshotName!), 'n1.md'));

    const result = await verifyBackup({ backupRoot: root });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(['n1.md']);
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

describe('runBackup — inventory and notebook list', () => {
  it('retries a transient error while reading the vault inventory', async () => {
    const get = vi.spyOn(joplin.data, 'get').mockRejectedValueOnce(new Error('database is locked'));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const result = await run();
      expect(result.status).toBe('success');
    } finally {
      get.mockRestore();
    }
  });

  it('re-reads the notebook list before each export attempt', async () => {
    setData({ notes: [{ id: 'n1', updated_time: 1000 }], folders: [{ id: 'f-old' }] });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const exportedWith: unknown[] = [];
    let attempt = 0;
    mockState.commandHandlers.exportFolders = async (ids, _format, target) => {
      attempt += 1;
      exportedWith.push(ids);
      if (attempt === 1) {
        // A notebook is created and another deleted while the first attempt runs.
        mockState.dataItems.folders = [{ id: 'f-new' }];
        throw new Error('database is locked');
      }
      const dir = String(target);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'n1.md'), 'hello');
      await fs.writeFile(path.join(dir, 'f-new.md'), 'folder');
    };

    const result = await run();

    expect(result.status).toBe('success');
    expect(exportedWith).toEqual([['f-old'], ['f-new']]);
    expect(result.warnings).toEqual([]);
  });
});

describe('runBackup — result timestamps', () => {
  const injected = new Date('2026-03-04T05:06:07.000Z');
  const injectedIso = injected.toISOString();
  const lastResult = () => String(mockState.values[SETTING_KEYS.lastBackupResult]);
  const lastRecord = () => JSON.parse(String(mockState.values[SETTING_KEYS.lastBackupResultJson]));

  it('uses the injected time for lastBackup and the success summary', async () => {
    await run({ now: injected });

    expect(mockState.values[SETTING_KEYS.lastBackup]).toBe(injectedIso);
    expect(lastResult()).toMatch(new RegExp(`^${injectedIso} — success`));
    expect(lastRecord().finishedAt).toBe(injectedIso);
  });

  it('uses the injected time for lastBackup and the skipped summary', async () => {
    await run();
    stubExport([{ path: 'n1.md', content: 'hello' }]);
    const second = await run({ now: injected });

    expect(second.status).toBe('skipped');
    expect(mockState.values[SETTING_KEYS.lastBackup]).toBe(injectedIso);
    expect(lastResult()).toBe(`Skipped (no changes) at ${injectedIso} — ${second.duration}`);
    expect(lastRecord().finishedAt).toBe(injectedIso);
  });

  it('uses the injected time for the failed summary', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockState.commandHandlers.exportFolders = async () => {
      throw new Error('boom');
    };

    await expect(run({ now: injected })).rejects.toThrow('boom');

    expect(lastResult()).toMatch(new RegExp(`^${injectedIso} — failed — .* — boom$`));
    expect(lastRecord().finishedAt).toBe(injectedIso);
  });
});
