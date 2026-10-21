/**
 * Step 4 — Integration Tests (end-to-end)
 *
 * Fully mocked Joplin API + memfs.
 */

import { Volume, createFsFromVolume } from 'memfs';
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

import joplin from 'api';
import { SettingKeys } from '../src/settings';
import {
  runBackup,
  verifyBackup,
  LOCK_FILENAME,
  ACTIVE_DIR_NAME,
  LATEST_FILENAME,
} from '../src/backup';
// (no extra imports needed)

const BACKUP_ROOT = '/backups/joplin';

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
  (joplin.settings.value as jest.Mock).mockImplementation((key: string) =>
    Promise.resolve(defaults[key]),
  );
}

function setupJoplinExport(files: Record<string, string>): void {
  (joplin.commands.execute as jest.Mock).mockImplementation(
    async (_cmd: string, _ids: string[], _fmt: string, targetDir: string) => {
      vol.mkdirSync(targetDir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const full = `${targetDir}/${rel}`;
        const dir = full.substring(0, full.lastIndexOf('/'));
        if (dir) vol.mkdirSync(dir, { recursive: true });
        vol.writeFileSync(full, content);
      }
    },
  );
}

describe('Integration', () => {
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

  it('first run creates snapshot, latest.txt, manifest with correct count', async () => {
    setupJoplinExport({ 'note1.md': 'hello', 'note2.md': 'world' });
    const result = await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)) });
    expect(result.status).toBe('success');
    expect(vol.existsSync(`${BACKUP_ROOT}/20261020T120000`)).toBe(true);
    expect(vol.readFileSync(`${BACKUP_ROOT}/${LATEST_FILENAME}`, 'utf8')).toBe('20261020T120000');
    expect(result.manifest?.fileCount).toBe(2);
  });

  it('second run with no changes skips snapshot creation', async () => {
    setupJoplinExport({ 'note1.md': 'hello' });
    await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)) });

    setupMockSettings({
      [SettingKeys.OnlyOnChange]: true,
      [SettingKeys.LastSnapshot]: '20261020T120000',
      [SettingKeys.LastBackup]: '2026-10-20T12:00:00.000Z',
    });
    (joplin.data.get as jest.Mock).mockImplementation(async (path: string[]) => {
      if (path[0] === 'folders') return { items: [{ id: 'folder-1' }], has_more: false };
      if (path[0] === 'notes') return { items: [{ updated_time: 1700000000000 }], has_more: false };
      return { items: [], has_more: false };
    });

    const before = vol.readdirSync(BACKUP_ROOT);
    const result = await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 13, 0, 0)) });
    expect(result.status).toBe('skipped');
    const after = vol.readdirSync(BACKUP_ROOT);
    expect(after.length).toBe(before.length);
    expect(vol.existsSync(`${BACKUP_ROOT}/20261020T130000`)).toBe(false);
  });

  it('third run with one changed note hardlinks unchanged files', async () => {
    // first snapshot
    setupJoplinExport({ 'a.md': 'unchanged', 'b.md': 'old' });
    await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)) });

    // seed manifest already written by runBackup; update settings
    setupMockSettings({
      [SettingKeys.OnlyOnChange]: true,
      [SettingKeys.LastSnapshot]: '20261020T120000',
      [SettingKeys.LastBackup]: '2026-10-20T12:00:00.000Z',
    });

    (joplin.data.get as jest.Mock).mockImplementation(async (path: string[]) => {
      if (path[0] === 'folders') return { items: [{ id: 'folder-1' }], has_more: false };
      if (path[0] === 'notes') return { items: [{ updated_time: 1700000500000 }], has_more: false };
      return { items: [], has_more: false };
    });

    setupJoplinExport({ 'a.md': 'unchanged', 'b.md': 'new' });
    const result = await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 13, 0, 0)) });
    expect(result.status).toBe('success');
    expect(result.dedupStats?.hardlinked).toBeGreaterThanOrEqual(1);
    expect(result.dedupStats?.unchanged).toBeGreaterThanOrEqual(1);
  });

  it('deleted note does not appear in new snapshot', async () => {
    setupJoplinExport({ 'keep.md': 'keep', 'delete.md': 'gone' });
    await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)) });

    setupMockSettings({
      [SettingKeys.OnlyOnChange]: false,
      [SettingKeys.LastSnapshot]: '20261020T120000',
      [SettingKeys.LastBackup]: '2026-10-20T12:00:00.000Z',
    });
    (joplin.data.get as jest.Mock).mockImplementation(async (path: string[]) => {
      if (path[0] === 'folders') return { items: [{ id: 'folder-1' }], has_more: false };
      if (path[0] === 'notes') return { items: [{ updated_time: 1700000500000 }], has_more: false };
      return { items: [], has_more: false };
    });

    setupJoplinExport({ 'keep.md': 'keep' });
    await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 13, 0, 0)) });
    expect(vol.existsSync(`${BACKUP_ROOT}/20261020T130000/delete.md`)).toBe(false);
    expect(vol.existsSync(`${BACKUP_ROOT}/20261020T130000/keep.md`)).toBe(true);
  });

  it('retention overflow removes oldest snapshots', async () => {
    for (let i = 1; i <= 5; i++) {
      vol.mkdirSync(`${BACKUP_ROOT}/2026101${i}T100000`, { recursive: true });
    }
    setupMockSettings({
      [SettingKeys.BackupRetention]: 5,
      [SettingKeys.OnlyOnChange]: false,
    });
    (joplin.data.get as jest.Mock).mockImplementation(async (path: string[]) => {
      if (path[0] === 'folders') return { items: [{ id: 'folder-1' }], has_more: false };
      if (path[0] === 'notes') return { items: [{ updated_time: 1700000500000 }], has_more: false };
      return { items: [], has_more: false };
    });
    setupJoplinExport({ 'file.txt': 'data' });

    const result = await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 10, 0, 0)) });
    expect(result.status).toBe('success');
    // oldest of 6 should be pruned
    expect(vol.existsSync(`${BACKUP_ROOT}/20261011T100000`)).toBe(false);
  });

  it('verify command reports all files match on valid snapshot', async () => {
    setupJoplinExport({ 'note.md': 'hello' });
    await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)) });
    const result = await verifyBackup();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('✅');
  });

  it('verify command reports hash mismatch on corrupted snapshot', async () => {
    setupJoplinExport({ 'note.md': 'hello' });
    await runBackup({ now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)) });
    vol.writeFileSync(`${BACKUP_ROOT}/20261020T120000/note.md`, 'tampered');
    const result = await verifyBackup();
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain('note.md');
    expect(result.message).toContain('❌');
  });

  it('lock held during second run throws EEXIST without partial snapshot', async () => {
    const lockPath = `${BACKUP_ROOT}/${LOCK_FILENAME}`;
    vol.writeFileSync(lockPath, new Date().toISOString(), { encoding: 'utf8' });
    await expect(runBackup()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(vol.existsSync(`${BACKUP_ROOT}/${ACTIVE_DIR_NAME}`)).toBe(false);
  });
});
