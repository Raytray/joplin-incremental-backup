import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return { default: memfs.fs.promises, ...memfs.fs.promises };
});

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { vol } from 'memfs';

// Importing the entry point registers the plugin script in the mock.
import '../src/index';

const pluginScript = mockState.pluginScript;
import {
  ACTIVE_DIR_NAME,
  LATEST_FILENAME,
  LOCK_FILENAME,
  runBackup,
  verifyBackup,
} from '../src/backup';
import { readManifest, MANIFEST_FILENAME } from '../src/manifest';
import { CREATE_COMMAND, VERIFY_COMMAND, MENU_ID } from '../src/index';
import { MenuItemLocation } from 'api/types';
import { mockState, resetMockJoplin } from '../src/__mocks__/joplin';
import { SETTING_KEYS, SETTING_SECTION_NAME } from '../src/settings';

const BACKUP_ROOT = '/integration-backups';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface VirtualNote {
  id: string;
  title: string;
  updated_time: number;
}

interface VirtualResource {
  id: string;
  updated_time: number;
}

/** Models the Joplin DB and how `exportFolders` materializes it on disk. */
class FakeWorkspace {
  notes: VirtualNote[] = [];
  resources: VirtualResource[] = [];

  setNotes(notes: VirtualNote[]): void {
    this.notes = notes;
  }

  setResources(resources: VirtualResource[]): void {
    this.resources = resources;
  }

  /** Files the RAW export would produce, keyed by relative path. */
  exportFiles(): Array<{ path: string; content: string }> {
    const notes = this.notes.map((note) => ({
      path: `notes/${note.id}.md`,
      content: note.title,
    }));
    const resources = this.resources.map((resource) => ({
      path: `resources/${resource.id}`,
      content: `resource-${resource.id}-${resource.updated_time}`,
    }));
    return [...notes, ...resources];
  }
}

const workspace = new FakeWorkspace();

function installMocks(): void {
  mockState.values = {
    [SETTING_KEYS.backupPath]: BACKUP_ROOT,
    [SETTING_KEYS.backupRetention]: 5,
    [SETTING_KEYS.backupInterval]: 0,
    [SETTING_KEYS.onlyOnChange]: true,
    [SETTING_KEYS.lastBackup]: '',
    [SETTING_KEYS.lastSnapshot]: '',
  };

  mockState.dataItems = {
    notes: workspace.notes.map((note) => ({ id: note.id, updated_time: note.updated_time })),
    folders: [{ id: 'folder-1' }],
    resources: workspace.resources.map((resource) => ({ updated_time: resource.updated_time })),
  };

  mockState.commandHandlers.exportFolders = async (_ids, _format, target) => {
    const dir = String(target);
    for (const file of workspace.exportFiles()) {
      const destination = path.join(dir, file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content);
    }
  };
}

async function listSnapshotDirs(): Promise<string[]> {
  const entries = await fs.readdir(BACKUP_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}(-\d+)?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function run(now = new Date('2026-02-01T00:00:00.000Z')) {
  return runBackup({ backupRoot: BACKUP_ROOT, now });
}

beforeEach(async () => {
  vol.reset();
  resetMockJoplin();
  await fs.mkdir(BACKUP_ROOT, { recursive: true });
  workspace.setNotes([]);
  workspace.setResources([]);
  installMocks();
});

describe('end-to-end backup lifecycle', () => {
  it('first run creates a full snapshot and latest.txt', async () => {
    workspace.setNotes([
      { id: 'n1', title: 'First', updated_time: 100 },
      { id: 'n2', title: 'Second', updated_time: 200 },
    ]);
    installMocks();

    const result = await run();

    expect(result).toMatchObject({
      status: 'success',
      snapshotName: '20260201T000000',
      fileCount: 2,
    });

    const snapshotDir = path.join(BACKUP_ROOT, '20260201T000000');
    const manifest = await readManifest(snapshotDir);
    expect(manifest?.fileCount).toBe(2);
    expect(manifest?.files.map((file) => file.path).sort()).toEqual(['notes/n1.md', 'notes/n2.md']);
    expect(await fs.readFile(path.join(BACKUP_ROOT, LATEST_FILENAME), 'utf8')).toBe(
      '20260201T000000',
    );
  });

  it('second run with no changes is skipped and updates lastBackup', async () => {
    workspace.setNotes([{ id: 'n1', title: 'First', updated_time: 100 }]);
    installMocks();
    await run(new Date('2026-02-01T00:00:00.000Z'));

    const second = await run(new Date('2026-02-01T01:00:00.000Z'));

    expect(second.status).toBe('skipped');
    expect(await listSnapshotDirs()).toEqual(['20260201T000000']);
    expect(mockState.values[SETTING_KEYS.lastBackup]).toBe('2026-02-01T01:00:00.000Z');
  });

  it('third run with one changed note hardlinks the unchanged file', async () => {
    workspace.setNotes([
      { id: 'n1', title: 'Unchanged', updated_time: 100 },
      { id: 'n2', title: 'Original', updated_time: 200 },
    ]);
    installMocks();
    await run(new Date('2026-02-01T00:00:00.000Z'));

    // Change only n2's content (and its updated_time).
    workspace.setNotes([
      { id: 'n1', title: 'Unchanged', updated_time: 100 },
      { id: 'n2', title: 'Edited', updated_time: 300 },
    ]);
    installMocks();

    const result = await run(new Date('2026-02-01T02:00:00.000Z'));

    expect(result).toMatchObject({ status: 'success', hardlinked: 1, copied: 0, unchanged: 1 });

    const secondDir = path.join(BACKUP_ROOT, '20260201T020000');
    const manifest = await readManifest(secondDir);
    const n2 = manifest?.files.find((file) => file.path === 'notes/n2.md');
    expect(n2?.sha256).toBe(sha256('Edited'));

    // The unchanged note is now a hardlink to the previous snapshot's file.
    const firstStat = await fs.stat(path.join(BACKUP_ROOT, '20260201T000000', 'notes', 'n1.md'));
    const secondStat = await fs.stat(path.join(secondDir, 'notes', 'n1.md'));
    expect(secondStat.ino).toBe(firstStat.ino);
  });

  it('deleted note is detected even when max updated_time is unchanged', async () => {
    workspace.setNotes([
      { id: 'n1', title: 'Keep', updated_time: 100 },
      { id: 'n2', title: 'Remove', updated_time: 900 },
    ]);
    installMocks();
    await run(new Date('2026-02-01T00:00:00.000Z'));

    // Remove the newest note; the surviving max updated_time is unchanged.
    workspace.setNotes([{ id: 'n1', title: 'Keep', updated_time: 100 }]);
    installMocks();

    const result = await run(new Date('2026-02-01T03:00:00.000Z'));

    expect(result.status).toBe('success');
    const manifest = await readManifest(path.join(BACKUP_ROOT, '20260201T030000'));
    expect(manifest?.files.map((file) => file.path)).toEqual(['notes/n1.md']);
  });

  it('changed resource is detected and included', async () => {
    workspace.setNotes([{ id: 'n1', title: 'Note', updated_time: 100 }]);
    workspace.setResources([{ id: 'r1', updated_time: 10 }]);
    installMocks();
    await run(new Date('2026-02-01T00:00:00.000Z'));

    workspace.setResources([{ id: 'r1', updated_time: 99 }]);
    installMocks();

    const result = await run(new Date('2026-02-01T04:00:00.000Z'));

    expect(result.status).toBe('success');
    const manifest = await readManifest(path.join(BACKUP_ROOT, '20260201T040000'));
    const resource = manifest?.files.find((file) => file.path === 'resources/r1');
    expect(resource?.sha256).toBe(sha256('resource-r1-99'));
  });

  it('prunes the oldest snapshot on retention overflow', async () => {
    // Five pre-existing snapshots + retention 5 means the new run removes the oldest.
    for (const name of [
      '20260101T000000',
      '20260102T000000',
      '20260103T000000',
      '20260104T000000',
      '20260105T000000',
    ]) {
      await fs.mkdir(path.join(BACKUP_ROOT, name), { recursive: true });
    }
    workspace.setNotes([{ id: 'n1', title: 'Note', updated_time: 100 }]);
    installMocks();

    await run(new Date('2026-02-01T00:00:00.000Z'));

    expect(await listSnapshotDirs()).toEqual([
      '20260102T000000',
      '20260103T000000',
      '20260104T000000',
      '20260105T000000',
      '20260201T000000',
    ]);
  });
});

describe('verification end-to-end', () => {
  it('verifies a valid snapshot', async () => {
    workspace.setNotes([
      { id: 'n1', title: 'One', updated_time: 1 },
      { id: 'n2', title: 'Two', updated_time: 2 },
    ]);
    installMocks();
    await run();

    const result = await verifyBackup({ backupRoot: BACKUP_ROOT });
    expect(result).toMatchObject({ ok: true, total: 2, matched: 2, mismatches: [] });
  });

  it('reports the specific corrupted file', async () => {
    workspace.setNotes([
      { id: 'n1', title: 'One', updated_time: 1 },
      { id: 'n2', title: 'Two', updated_time: 2 },
    ]);
    installMocks();
    const backup = await run();

    await fs.writeFile(path.join(BACKUP_ROOT, backup.snapshotName!, 'notes', 'n2.md'), 'corrupted');

    const result = await verifyBackup({ backupRoot: BACKUP_ROOT });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(['notes/n2.md']);
  });
});

describe('lock contention', () => {
  it('a held lock makes the second run fail with no partial snapshot', async () => {
    await fs.writeFile(path.join(BACKUP_ROOT, LOCK_FILENAME), new Date().toISOString());

    await expect(run()).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await listSnapshotDirs()).toEqual([]);
    await expect(fs.stat(path.join(BACKUP_ROOT, ACTIVE_DIR_NAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('plugin startup (onStart)', () => {
  it('registers the plugin script, settings, commands, and menu, then schedules', async () => {
    expect(pluginScript).not.toBeNull();

    await pluginScript!.onStart!();

    expect(mockState.registeredSection?.name).toBe(SETTING_SECTION_NAME);
    expect(Object.keys(mockState.registeredSettings ?? {}).length).toBeGreaterThan(0);
    expect(mockState.registeredCommands[CREATE_COMMAND]).toBeDefined();
    expect(mockState.registeredCommands[VERIFY_COMMAND]).toBeDefined();

    const menu = mockState.createdMenus.find((entry) => entry.id === MENU_ID);
    expect(menu?.location).toBe(MenuItemLocation.Tools);
    expect(menu?.items).toHaveLength(2);

    // backupInterval is 0 in the shared settings, so no timer is scheduled.
    const { isSchedulerRunning, stopScheduler } = await import('../src/scheduler');
    expect(isSchedulerRunning()).toBe(false);
    stopScheduler();
  });

  it('runs a backup through the registered command and shows a dialog', async () => {
    workspace.setNotes([{ id: 'n1', title: 'Note', updated_time: 100 }]);
    installMocks();
    mockState.values[SETTING_KEYS.backupPath] = BACKUP_ROOT;

    await pluginScript!.onStart!();

    const command = mockState.registeredCommands[CREATE_COMMAND];
    await command.execute!();

    expect(mockState.messageBoxes).toHaveLength(1);
    expect(mockState.messageBoxes[0]).toMatch(/Backup complete/);
    expect(await listSnapshotDirs()).toHaveLength(1);
  });

  it('recovers by clearing the staging dir on startup', async () => {
    const activeDir = path.join(BACKUP_ROOT, ACTIVE_DIR_NAME);
    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, 'leftover.md'), 'stale');

    await pluginScript!.onStart!();

    await expect(fs.stat(activeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('manifest output', () => {
  it('writes a manifest.json that round-trips from disk', async () => {
    workspace.setNotes([{ id: 'n1', title: 'Note', updated_time: 100 }]);
    installMocks();
    const backup = await run();

    const raw = await fs.readFile(
      path.join(BACKUP_ROOT, backup.snapshotName!, MANIFEST_FILENAME),
      'utf8',
    );
    const parsed = JSON.parse(raw);
    expect(parsed.joplinVersion).toBe('3.7.0');
    expect(parsed.changeFingerprint).toEqual({
      maxNoteUpdatedTime: 100,
      noteCount: 1,
      maxResourceUpdatedTime: 0,
    });
  });
});
