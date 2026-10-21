/**
 * Step 2 tests — Backup Engine (src/backup.ts)
 *
 * Uses memfs to simulate the filesystem so tests are hermetic and cross-platform.
 */

import { Volume, createFsFromVolume } from 'memfs';
import * as crypto from 'crypto';

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

// Import joplin mock and modules under test after fs/promises mock
import joplin from 'api';
import { SettingKeys } from '../src/settings';
import {
  runBackup,
  generateSnapshotName,
  countFilesInDir,
  getMaxNotesUpdatedTime,
  getAllFolderIds,
  resolveLastSnapshot,
  verifyBackup,
  retryTransient,
  isTransientExportError,
  LOCK_FILENAME,
  ACTIVE_DIR_NAME,
  LATEST_FILENAME,
} from '../src/backup';
import { SNAPSHOT_PATTERN } from '../src/retention';
import { Manifest, writeManifest } from '../src/manifest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BACKUP_ROOT = '/backups/joplin';

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function resetFs(files: Record<string, string> = {}): void {
  vol.reset();
  vol.mkdirSync(BACKUP_ROOT, { recursive: true });

  for (const [filePath, content] of Object.entries(files)) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir) vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(filePath, content, { encoding: 'utf8' });
  }
}

function setupMockSettings(custom: Partial<Record<string, unknown>> = {}): void {
  const defaults: Record<string, unknown> = {
    [SettingKeys.BackupPath]: BACKUP_ROOT,
    [SettingKeys.BackupRetention]: 5,
    [SettingKeys.BackupInterval]: 24,
    [SettingKeys.OnlyOnChange]: true,
    [SettingKeys.LastBackup]: '',
    [SettingKeys.LastSnapshot]: '',
    ...custom,
  };

  (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
    return Promise.resolve(defaults[key]);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Backup Engine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetFs();
    setupMockSettings();
    (joplin.appVersion as jest.Mock).mockResolvedValue('2.14.0');
    (joplin.data.get as jest.Mock).mockImplementation(async (path: string[]) => {
      if (path[0] === 'folders') {
        return { items: [{ id: 'folder-1' }, { id: 'folder-2' }], has_more: false };
      }
      if (path[0] === 'notes') {
        return { items: [{ updated_time: 1700000000000 }], has_more: false };
      }
      return { items: [], has_more: false };
    });
  });

  describe('generateSnapshotName', () => {
    it('produces a string matching SNAPSHOT_PATTERN (YYYYMMDDTHHMMSS)', () => {
      const fixedDate = new Date(Date.UTC(2026, 9, 20, 14, 30, 45));
      const name = generateSnapshotName(fixedDate);

      expect(name).toBe('20261020T143045');
      expect(SNAPSHOT_PATTERN.test(name)).toBe(true);
    });

    it('defaults to current time matching SNAPSHOT_PATTERN', () => {
      const name = generateSnapshotName();
      expect(SNAPSHOT_PATTERN.test(name)).toBe(true);
    });
  });

  describe('countFilesInDir', () => {
    it('returns 0 for non-existent directory', async () => {
      const count = await countFilesInDir('/non-existent');
      expect(count).toBe(0);
    });

    it('recursively counts files while ignoring .tmp and lock files', async () => {
      resetFs({
        [`${BACKUP_ROOT}/dir1/file1.txt`]: 'hello',
        [`${BACKUP_ROOT}/dir1/dir2/file2.txt`]: 'world',
        [`${BACKUP_ROOT}/file3.txt`]: 'test',
        [`${BACKUP_ROOT}/test.tmp`]: 'temp',
        [`${BACKUP_ROOT}/${LOCK_FILENAME}`]: '2026-10-20T12:00:00.000Z',
      });

      const count = await countFilesInDir(BACKUP_ROOT);
      expect(count).toBe(3);
    });
  });

  describe('getMaxNotesUpdatedTime', () => {
    it('returns 0 when no notes exist', async () => {
      (joplin.data.get as jest.Mock).mockResolvedValue({ items: [], has_more: false });
      const maxTime = await getMaxNotesUpdatedTime();
      expect(maxTime).toBe(0);
    });

    it('returns max time across multiple pages', async () => {
      (joplin.data.get as jest.Mock).mockImplementation(
        async (_path: string[], query?: { page?: number }) => {
          if (query?.page === 1) {
            return {
              items: [{ updated_time: 1000 }, { updated_time: 2500 }],
              has_more: true,
            };
          }
          return {
            items: [{ updated_time: 1500 }, { updated_time: 3000 }],
            has_more: false,
          };
        },
      );

      const maxTime = await getMaxNotesUpdatedTime();
      expect(maxTime).toBe(3000);
      expect(joplin.data.get).toHaveBeenCalledTimes(2);
    });

    it('handles non-array or invalid updated_time gracefully', async () => {
      (joplin.data.get as jest.Mock).mockResolvedValue({
        items: [
          null,
          { updated_time: undefined },
          { updated_time: 'not-a-number' },
          { updated_time: '4000' },
        ],
        has_more: false,
      });

      const maxTime = await getMaxNotesUpdatedTime();
      expect(maxTime).toBe(4000);

      // Null response case
      (joplin.data.get as jest.Mock).mockResolvedValue(null);
      expect(await getMaxNotesUpdatedTime()).toBe(0);
    });
  });

  describe('getAllFolderIds', () => {
    it('returns folder IDs across pages', async () => {
      (joplin.data.get as jest.Mock).mockImplementation(
        async (_path: string[], query?: { page?: number }) => {
          if (query?.page === 1) {
            return { items: [{ id: 'f1' }], has_more: true };
          }
          return { items: [{ id: 'f2' }, { id: 'f3' }], has_more: false };
        },
      );

      const ids = await getAllFolderIds();
      expect(ids).toEqual(['f1', 'f2', 'f3']);
    });

    it('ignores invalid items or non-array responses', async () => {
      (joplin.data.get as jest.Mock).mockResolvedValue({
        items: [null, { id: '' }, { id: 'valid-id' }, { id: 123 }],
        has_more: false,
      });

      expect(await getAllFolderIds()).toEqual(['valid-id']);

      (joplin.data.get as jest.Mock).mockResolvedValue(null);
      expect(await getAllFolderIds()).toEqual([]);
    });
  });

  describe('resolveLastSnapshot', () => {
    it('returns preferred snapshot when it exists on disk', async () => {
      vol.mkdirSync(`${BACKUP_ROOT}/20261018T100000`, { recursive: true });
      vol.mkdirSync(`${BACKUP_ROOT}/20261019T100000`, { recursive: true });

      const resolved = await resolveLastSnapshot(BACKUP_ROOT, '20261018T100000');
      expect(resolved).toEqual({
        name: '20261018T100000',
        dir: `${BACKUP_ROOT}/20261018T100000`,
      });
    });

    it('ignores preferred snapshot if it is a file instead of a directory', async () => {
      vol.writeFileSync(`${BACKUP_ROOT}/20261018T100000`, 'not a directory');
      vol.mkdirSync(`${BACKUP_ROOT}/20261019T100000`, { recursive: true });

      const resolved = await resolveLastSnapshot(BACKUP_ROOT, '20261018T100000');
      expect(resolved).toEqual({
        name: '20261019T100000',
        dir: `${BACKUP_ROOT}/20261019T100000`,
      });
    });

    it('falls back to latest.txt if preferred is absent', async () => {
      vol.mkdirSync(`${BACKUP_ROOT}/20261019T100000`, { recursive: true });
      vol.writeFileSync(`${BACKUP_ROOT}/${LATEST_FILENAME}`, '20261019T100000');

      const resolved = await resolveLastSnapshot(BACKUP_ROOT, 'non_existent');
      expect(resolved).toEqual({
        name: '20261019T100000',
        dir: `${BACKUP_ROOT}/20261019T100000`,
      });
    });

    it('falls back to listSnapshots if both preferred and latest.txt are absent', async () => {
      vol.mkdirSync(`${BACKUP_ROOT}/20261017T100000`, { recursive: true });
      vol.mkdirSync(`${BACKUP_ROOT}/20261019T100000`, { recursive: true });

      const resolved = await resolveLastSnapshot(BACKUP_ROOT);
      expect(resolved).toEqual({
        name: '20261019T100000',
        dir: `${BACKUP_ROOT}/20261019T100000`,
      });
    });

    it('returns null when no snapshots exist', async () => {
      const resolved = await resolveLastSnapshot(BACKUP_ROOT);
      expect(resolved).toBeNull();
    });
  });

  describe('runBackup - Happy Path', () => {
    it('executes full initial backup when no previous snapshot exists', async () => {
      // Setup Joplin export execution to simulate writing raw export files
      (joplin.commands.execute as jest.Mock).mockImplementation(
        async (command: string, _notebookIds: string[], _format: string, targetDir: string) => {
          if (command === 'exportFolders') {
            vol.mkdirSync(`${targetDir}/Folder 1`, { recursive: true });
            vol.writeFileSync(`${targetDir}/Folder 1/note1.md`, '# Note 1 Content');
            vol.writeFileSync(`${targetDir}/Folder 1/note2.md`, '# Note 2 Content');
          }
        },
      );

      const fixedDate = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
      const result = await runBackup({ now: fixedDate });

      // Verify return result
      expect(result.status).toBe('success');
      expect(result.snapshotName).toBe('20261020T120000');
      expect(result.snapshotDir).toBe(`${BACKUP_ROOT}/20261020T120000`);
      expect(result.dedupStats).toEqual({ hardlinked: 0, copied: 0, unchanged: 2 });
      expect(result.manifest).toBeDefined();
      expect(result.manifest?.deduplication).toBe('none');
      expect(result.manifest?.fileCount).toBe(2);

      // Verify commands.execute called with correct parameters
      expect(joplin.commands.execute).toHaveBeenCalledWith(
        'exportFolders',
        ['folder-1', 'folder-2'],
        'raw',
        `${BACKUP_ROOT}/${ACTIVE_DIR_NAME}`,
      );

      // Verify snapshot directory exists and staging directory is gone
      expect(vol.existsSync(`${BACKUP_ROOT}/20261020T120000`)).toBe(true);
      expect(vol.existsSync(`${BACKUP_ROOT}/20261020T120000/Folder 1/note1.md`)).toBe(true);
      expect(vol.existsSync(`${BACKUP_ROOT}/20261020T120000/manifest.json`)).toBe(true);
      expect(vol.existsSync(`${BACKUP_ROOT}/${ACTIVE_DIR_NAME}`)).toBe(false);

      // Verify latest.txt
      expect(vol.existsSync(`${BACKUP_ROOT}/${LATEST_FILENAME}`)).toBe(true);
      const latest = vol.readFileSync(`${BACKUP_ROOT}/${LATEST_FILENAME}`, 'utf8');
      expect(latest).toBe('20261020T120000');

      // Verify settings updated
      expect(joplin.settings.setValue).toHaveBeenCalledWith(
        SettingKeys.LastBackup,
        fixedDate.toISOString(),
      );
      expect(joplin.settings.setValue).toHaveBeenCalledWith(
        SettingKeys.LastSnapshot,
        '20261020T120000',
      );

      // Verify lock was released
      expect(vol.existsSync(`${BACKUP_ROOT}/${LOCK_FILENAME}`)).toBe(false);
    });

    it('performs deduplication against previous snapshot on subsequent run', async () => {
      // Seed previous snapshot
      const prevDir = `${BACKUP_ROOT}/20261019T100000`;
      const note1Content = '# Unchanged Note';
      const prevManifest: Manifest = {
        snapshotId: '20261019T100000',
        createdAt: 1700000000000,
        joplinVersion: '2.14.0',
        lastChangeTime: 1700000000000,
        fileCount: 1,
        files: [
          {
            path: 'note1.md',
            size: Buffer.byteLength(note1Content),
            sha256: sha256Hex(note1Content),
          },
        ],
        deduplication: 'none',
      };

      vol.mkdirSync(prevDir, { recursive: true });
      vol.writeFileSync(`${prevDir}/note1.md`, note1Content);
      await writeManifest(prevDir, prevManifest);
      vol.writeFileSync(`${BACKUP_ROOT}/${LATEST_FILENAME}`, '20261019T100000');

      setupMockSettings({
        [SettingKeys.LastSnapshot]: '20261019T100000',
        [SettingKeys.LastBackup]: '2026-10-19T10:00:00.000Z',
      });

      // Updated notes time indicates a change
      (joplin.data.get as jest.Mock).mockImplementation(async (path: string[]) => {
        if (path[0] === 'folders') {
          return { items: [{ id: 'f1' }], has_more: false };
        }
        if (path[0] === 'notes') {
          return { items: [{ updated_time: 1700000500000 }], has_more: false };
        }
        return { items: [], has_more: false };
      });

      // Export exports note1 (unchanged) and note2 (new)
      (joplin.commands.execute as jest.Mock).mockImplementation(
        async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
          vol.mkdirSync(targetDir, { recursive: true });
          vol.writeFileSync(`${targetDir}/note1.md`, note1Content);
          vol.writeFileSync(`${targetDir}/note2.md`, '# New Note');
        },
      );

      const fixedDate = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
      const result = await runBackup({ now: fixedDate });

      expect(result.status).toBe('success');
      expect(result.dedupStats?.hardlinked).toBe(1);
      expect(result.dedupStats?.unchanged).toBe(1);
      expect(result.manifest?.deduplication).toBe('hardlink');
      expect(result.manifest?.fileCount).toBe(2);

      // Lock released
      expect(vol.existsSync(`${BACKUP_ROOT}/${LOCK_FILENAME}`)).toBe(false);
    });

    it('handles joplin.appVersion failure and custom snapshotName', async () => {
      (joplin.appVersion as jest.Mock).mockRejectedValue(new Error('appVersion unsupported'));

      (joplin.commands.execute as jest.Mock).mockImplementation(
        async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
          vol.mkdirSync(targetDir, { recursive: true });
          vol.writeFileSync(`${targetDir}/test.md`, '# Test');
        },
      );

      const customName = '20261020T190000';
      const result = await runBackup({ snapshotName: customName });

      expect(result.status).toBe('success');
      expect(result.snapshotName).toBe(customName);
      expect(result.manifest?.joplinVersion).toBe('');
    });
  });

  describe('runBackup - onlyOnChange', () => {
    it('skips snapshot creation when notes have not changed', async () => {
      // Seed previous snapshot
      const prevDir = `${BACKUP_ROOT}/20261019T100000`;
      const prevManifest: Manifest = {
        snapshotId: '20261019T100000',
        createdAt: 1700000000000,
        joplinVersion: '2.14.0',
        lastChangeTime: 1700000000000,
        fileCount: 1,
        files: [{ path: 'note1.md', size: 10, sha256: 'abc' }],
        deduplication: 'none',
      };

      vol.mkdirSync(prevDir, { recursive: true });
      vol.writeFileSync(`${prevDir}/note1.md`, 'note content');
      await writeManifest(prevDir, prevManifest);

      setupMockSettings({
        [SettingKeys.OnlyOnChange]: true,
        [SettingKeys.LastSnapshot]: '20261019T100000',
        [SettingKeys.LastBackup]: '2026-10-19T10:00:00.000Z',
      });

      // Notes updated_time is exactly the same as lastChangeTime
      (joplin.data.get as jest.Mock).mockImplementation(async (path: string[]) => {
        if (path[0] === 'notes') {
          return { items: [{ updated_time: 1700000000000 }], has_more: false };
        }
        return { items: [], has_more: false };
      });

      const fixedDate = new Date(Date.UTC(2026, 9, 20, 15, 0, 0));
      const result = await runBackup({ now: fixedDate });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toContain('No changes detected');

      // Export was never executed
      expect(joplin.commands.execute).not.toHaveBeenCalled();

      // No new snapshot directory created
      expect(vol.existsSync(`${BACKUP_ROOT}/20261020T150000`)).toBe(false);

      // lastBackup setting was still updated
      expect(joplin.settings.setValue).toHaveBeenCalledWith(
        SettingKeys.LastBackup,
        fixedDate.toISOString(),
      );

      // Lock file was released
      expect(vol.existsSync(`${BACKUP_ROOT}/${LOCK_FILENAME}`)).toBe(false);
    });

    it('proceeds with backup if onlyOnChange is false even when notes are unchanged', async () => {
      const prevDir = `${BACKUP_ROOT}/20261019T100000`;
      const prevManifest: Manifest = {
        snapshotId: '20261019T100000',
        createdAt: 1700000000000,
        joplinVersion: '2.14.0',
        lastChangeTime: 1700000000000,
        fileCount: 1,
        files: [{ path: 'note1.md', size: 10, sha256: 'abc' }],
        deduplication: 'none',
      };
      vol.mkdirSync(prevDir, { recursive: true });
      vol.writeFileSync(`${prevDir}/note1.md`, 'content');
      await writeManifest(prevDir, prevManifest);

      setupMockSettings({
        [SettingKeys.OnlyOnChange]: false,
        [SettingKeys.LastSnapshot]: '20261019T100000',
        [SettingKeys.LastBackup]: '2026-10-19T10:00:00.000Z',
      });

      (joplin.commands.execute as jest.Mock).mockImplementation(
        async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
          vol.mkdirSync(targetDir, { recursive: true });
          vol.writeFileSync(`${targetDir}/note1.md`, 'content');
        },
      );

      const fixedDate = new Date(Date.UTC(2026, 9, 20, 16, 0, 0));
      const result = await runBackup({ now: fixedDate });

      expect(result.status).toBe('success');
      expect(vol.existsSync(`${BACKUP_ROOT}/20261020T160000`)).toBe(true);
    });
  });

  describe('runBackup - Error handling & Cleanups', () => {
    it('throws error and cleans up active directory when export produces zero files', async () => {
      // Export command does not produce any files in targetDir
      (joplin.commands.execute as jest.Mock).mockImplementation(async () => {});

      await expect(runBackup()).rejects.toThrow(
        /Export verification failed: export produced zero files/,
      );

      // Verify active dir was removed and lock was released
      expect(vol.existsSync(`${BACKUP_ROOT}/${ACTIVE_DIR_NAME}`)).toBe(false);
      expect(vol.existsSync(`${BACKUP_ROOT}/${LOCK_FILENAME}`)).toBe(false);
      expect(vol.existsSync(`${BACKUP_ROOT}/${LATEST_FILENAME}`)).toBe(false);
    });

    it('throws EEXIST immediately when lock is already held and not stale', async () => {
      // Pre-create fresh lock file
      const lockPath = `${BACKUP_ROOT}/${LOCK_FILENAME}`;
      vol.writeFileSync(lockPath, new Date().toISOString(), { encoding: 'utf8' });

      await expect(runBackup()).rejects.toMatchObject({
        code: 'EEXIST',
      });

      // Existing lock file remains untouched
      expect(vol.existsSync(lockPath)).toBe(true);
      // No active dir created
      expect(vol.existsSync(`${BACKUP_ROOT}/${ACTIVE_DIR_NAME}`)).toBe(false);
      expect(joplin.commands.execute).not.toHaveBeenCalled();
    });

    it('throws error when backupPath setting is empty', async () => {
      setupMockSettings({ [SettingKeys.BackupPath]: '' });

      await expect(runBackup()).rejects.toThrow(/Backup path is empty/);
      expect(joplin.commands.execute).not.toHaveBeenCalled();
    });

    it('supports profileName subfolder', async () => {
      (joplin.commands.execute as jest.Mock).mockImplementation(
        async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
          vol.mkdirSync(targetDir, { recursive: true });
          vol.writeFileSync(`${targetDir}/note.md`, 'hello');
        },
      );
      const result = await runBackup({
        now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)),
        profileName: 'My Profile',
      });
      expect(result.status).toBe('success');
      expect(vol.existsSync(`${BACKUP_ROOT}/My_Profile/20261020T120000`)).toBe(true);
    });

    it('handles release lock failure gracefully', async () => {
      (joplin.commands.execute as jest.Mock).mockImplementation(
        async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
          vol.mkdirSync(targetDir, { recursive: true });
          vol.writeFileSync(`${targetDir}/note.md`, 'hello');
        },
      );
      const origUnlink = memFsPromises.unlink;
      memFsPromises.unlink = (async () => {
        throw Object.assign(new Error('no unlink'), { code: 'EPERM' });
      }) as unknown as typeof memFsPromises.unlink;
      await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)) });
      memFsPromises.unlink = origUnlink;
    });

    it('handles EBUSY during active dir cleanup', async () => {
      (joplin.commands.execute as jest.Mock).mockImplementation(
        async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
          vol.mkdirSync(targetDir, { recursive: true });
          vol.writeFileSync(`${targetDir}/note.md`, 'hello');
        },
      );
      const origRm = memFsPromises.rm;
      memFsPromises.rm = (async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }) as unknown as typeof memFsPromises.rm;
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)) });
      memFsPromises.rm = origRm;
      spy.mockRestore();
    });

    it('cleans up active dir and releases lock when export command fails', async () => {
      (joplin.commands.execute as jest.Mock).mockRejectedValue(
        new Error('Joplin internal error during export'),
      );

      await expect(runBackup()).rejects.toThrow('Joplin internal error during export');

      // Staging directory removed and lock released
      expect(vol.existsSync(`${BACKUP_ROOT}/${ACTIVE_DIR_NAME}`)).toBe(false);
      expect(vol.existsSync(`${BACKUP_ROOT}/${LOCK_FILENAME}`)).toBe(false);
    });
  });

  describe('runBackup - Retention & Pruning', () => {
    it('prunes oldest snapshots according to backupRetention', async () => {
      // Create 3 existing snapshots
      const s1 = '20261017T100000';
      const s2 = '20261018T100000';
      const s3 = '20261019T100000';
      vol.mkdirSync(`${BACKUP_ROOT}/${s1}`, { recursive: true });
      vol.mkdirSync(`${BACKUP_ROOT}/${s2}`, { recursive: true });
      vol.mkdirSync(`${BACKUP_ROOT}/${s3}`, { recursive: true });

      // Retention limit is 3, so adding a 4th will prune s1
      setupMockSettings({
        [SettingKeys.BackupRetention]: 3,
        [SettingKeys.OnlyOnChange]: false,
      });

      (joplin.commands.execute as jest.Mock).mockImplementation(
        async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
          vol.mkdirSync(targetDir, { recursive: true });
          vol.writeFileSync(`${targetDir}/file.txt`, 'data');
        },
      );

      const fixedDate = new Date(Date.UTC(2026, 9, 20, 10, 0, 0));
      const result = await runBackup({ now: fixedDate });

      expect(result.status).toBe('success');
      expect(result.prunedSnapshots).toEqual([s1]);

      // s1 is deleted, s2, s3, and new snapshot remain
      expect(vol.existsSync(`${BACKUP_ROOT}/${s1}`)).toBe(false);
      expect(vol.existsSync(`${BACKUP_ROOT}/${s2}`)).toBe(true);
      expect(vol.existsSync(`${BACKUP_ROOT}/${s3}`)).toBe(true);
      expect(vol.existsSync(`${BACKUP_ROOT}/20261020T100000`)).toBe(true);
    });
  });
});

describe('Backup Engine - verifyBackup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetFs();
    setupMockSettings();
    (joplin.appVersion as jest.Mock).mockResolvedValue('2.14.0');
    (joplin.data.get as jest.Mock).mockImplementation(async (path: string[]) => {
      if (path[0] === 'folders') return { items: [{ id: 'folder-1' }], has_more: false };
      if (path[0] === 'notes') return { items: [{ updated_time: 1700000000000 }], has_more: false };
      return { items: [], has_more: false };
    });
  });

  it('verifies a valid snapshot', async () => {
    (joplin.commands.execute as jest.Mock).mockImplementation(
      async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
        vol.mkdirSync(targetDir, { recursive: true });
        vol.writeFileSync(`${targetDir}/note.md`, 'hello');
      },
    );
    const fixedDate = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
    await runBackup({ now: fixedDate });

    const result = await verifyBackup();
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.message).toContain('✅');
  });

  it('detects corrupted snapshot', async () => {
    (joplin.commands.execute as jest.Mock).mockImplementation(
      async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
        vol.mkdirSync(targetDir, { recursive: true });
        vol.writeFileSync(`${targetDir}/note.md`, 'hello');
      },
    );
    const fixedDate = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
    await runBackup({ now: fixedDate });

    // corrupt
    vol.writeFileSync(`${BACKUP_ROOT}/20261020T120000/note.md`, 'tampered');

    const result = await verifyBackup();
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain('note.md');
    expect(result.message).toContain('❌');
  });

  it('throws when no snapshot exists', async () => {
    resetFs();
    setupMockSettings();
    await expect(verifyBackup()).rejects.toThrow(/No snapshot found/);
  });

  it('throws when manifest is malformed', async () => {
    resetFs();
    setupMockSettings();
    vol.mkdirSync(`${BACKUP_ROOT}/20261020T120000`, { recursive: true });
    vol.writeFileSync(`${BACKUP_ROOT}/20261020T120000/manifest.json`, '{bad json');
    vol.writeFileSync(`${BACKUP_ROOT}/${LATEST_FILENAME}`, '20261020T120000');
    await expect(verifyBackup()).rejects.toThrow(/Manifest missing or malformed/);
  });

  it('reports missing file as mismatch', async () => {
    (joplin.commands.execute as jest.Mock).mockImplementation(
      async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
        vol.mkdirSync(targetDir, { recursive: true });
        vol.writeFileSync(`${targetDir}/note.md`, 'hello');
      },
    );
    const fixedDate = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
    await runBackup({ now: fixedDate });

    vol.unlinkSync(`${BACKUP_ROOT}/20261020T120000/note.md`);
    const result = await verifyBackup();
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain('note.md');
  });
});

describe('Backup reliability helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetFs();
    setupMockSettings();
    (joplin.appVersion as jest.Mock).mockResolvedValue('2.14.0');
    (joplin.data.get as jest.Mock).mockImplementation(async (path: string[]) => {
      if (path[0] === 'folders') return { items: [{ id: 'folder-1' }], has_more: false };
      if (path[0] === 'notes') return { items: [{ updated_time: 1700000000000 }], has_more: false };
      return { items: [], has_more: false };
    });
  });

  it('identifies transient errors', () => {
    expect(isTransientExportError({ code: 'EBUSY' })).toBe(true);
    expect(isTransientExportError(new Error('timeout occurred'))).toBe(true);
    expect(isTransientExportError(new Error('nope'))).toBe(false);
  });

  it('retries transient failures and succeeds', async () => {
    let calls = 0;
    const result = await retryTransient(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return 'ok';
    }, 3);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not retry non-transient failures', async () => {
    let calls = 0;
    await expect(
      retryTransient(async () => {
        calls++;
        throw new Error('fatal');
      }, 3),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('verifies a specific snapshot via snapshotToVerify', async () => {
    (joplin.commands.execute as jest.Mock).mockImplementation(
      async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
        vol.mkdirSync(targetDir, { recursive: true });
        vol.writeFileSync(`${targetDir}/note.md`, 'hello');
      },
    );
    await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)) });
    const result = await verifyBackup({ snapshotToVerify: '20261020T120000' });
    expect(result.ok).toBe(true);
  });
});
