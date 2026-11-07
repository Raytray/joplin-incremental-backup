/**
 * End-to-end: the plugin running inside a real Joplin desktop app.
 *
 * Nothing is mocked. The scheduler drives every backup: with no previous
 * backup (or one ≥ 2 intervals old) it starts one a few seconds after
 * Joplin launches, so each launch below produces one run.
 *
 *   1. Seed notes, a notebook, a tag and an attachment through the Data API.
 *   2. Point the plugin at a backup directory → first snapshot. Then edit,
 *      delete and add notes.
 *   3. Back-date `lastBackup` → catch-up backup → second snapshot, which
 *      hardlinks the files that did not change.
 *   4. Back-date again with nothing changed → the run is skipped.
 *
 * The scenario runs twice: staging the export on the backup drive (the
 * default), and with "Stage the export on this computer" on, with the backups
 * on a different filesystem so local staging is not skipped.
 */
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackupChanges } from '../src/backup';
import type { Manifest } from '../src/manifest';
import { listSnapshots } from '../src/retention';
import { JoplinInstance, waitFor } from './joplin';

const BACKUP_TIMEOUT_MS = 120_000;
/**
 * `ACTIVE_DIR_PREFIX` from src/backup.ts, which cannot be loaded here: it
 * imports the Joplin plugin API, which only exists inside Joplin.
 */
const ACTIVE_DIR_PREFIX = '_joplin_active_';
/** A directory on a different filesystem from the work directory (tmpfs). */
const OTHER_DEVICE_ROOT = process.env.JOPLIN_E2E_OTHER_DEVICE ?? '/dev/shm';

const MODES = [
  { name: 'staging on the backup drive', slug: 'drive', stageLocally: false },
  { name: 'staging locally', slug: 'local', stageLocally: true },
] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT = Buffer.from(`attachment bytes ${Date.now()}\n`.repeat(64));

describe.each(MODES)('incremental backup in a real Joplin, $name', (mode) => {
  let workDir: string;
  let backupDir: string;
  /** Holds `backupDir`; on another device when staging locally. */
  let backupParent: string | undefined;
  let joplin: JoplinInstance;
  let failed = false;

  const ids = {
    folder: '',
    otherFolder: '',
    unchangedNote: '',
    editedNote: '',
    deletedNote: '',
    addedNote: '',
    tag: '',
    resource: '',
  };

  const snapshots: string[] = [];

  function sha256(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  async function snapshotNames(): Promise<string[]> {
    return listSnapshots(backupDir);
  }

  /**
   * Parsed independently of the plugin's own reader, so the test checks the
   * on-disk format rather than trusting the code under test.
   */
  async function readManifest(snapshot: string): Promise<Manifest> {
    return JSON.parse(
      await fs.readFile(path.join(backupDir, snapshot, 'manifest.json'), 'utf8'),
    ) as Manifest;
  }

  interface RunRecord {
    status?: string;
    snapshotName?: string;
    changes?: BackupChanges;
    warnings?: string[];
    message?: string;
  }

  function lastRunRecord(): RunRecord {
    return JSON.parse(joplin.readPluginSetting('lastBackupResultJson') || '{}') as RunRecord;
  }

  /**
   * Launch Joplin and wait for the scheduled run to record a new result.
   * Settings reach the database 500 ms after the plugin sets them, so the
   * read-only poll sees the run finish without stopping the app.
   */
  async function launchAndAwaitBackup(expectedStatus: 'success' | 'skipped'): Promise<RunRecord> {
    const before = joplin.readPluginSetting('lastBackupResultJson') ?? '';
    await joplin.start();
    await waitFor(
      'the scheduled backup to finish',
      () => {
        const now = joplin.readPluginSetting('lastBackupResultJson') ?? '';
        return now !== before && now !== '' ? true : undefined;
      },
      BACKUP_TIMEOUT_MS,
    );
    // After recording the result the run releases the lock, then removes its
    // staging directories. Wait for all of it, or stopping the app could cut
    // the cleanup short.
    await waitFor(
      'the backup run to clean up',
      async () => ((await runIsCleanedUp()) ? true : undefined),
      BACKUP_TIMEOUT_MS,
    );
    const record = lastRunRecord();
    expect(record.status, record.message).toBe(expectedStatus);
    expect(record.warnings ?? []).toEqual([]);
    return record;
  }

  async function runIsCleanedUp(): Promise<boolean> {
    if (await exists(path.join(backupDir, '.backup.lock'))) return false;
    const onDrive = await fs.readdir(backupDir).catch(() => [] as string[]);
    if (onDrive.some((name) => name.startsWith(ACTIVE_DIR_PREFIX))) return false;
    const local = await fs.readdir(joplin.localStagingRoot).catch(() => [] as string[]);
    return local.length === 0;
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Where the last run exported, from the plugin's log: locally (and cleaned up
   * afterwards) when `stageLocally` is on, otherwise on the backup drive.
   */
  async function expectStaging(): Promise<void> {
    const log = await joplin.pluginLog();
    expect(
      log.some((l) => l.includes('Starting backup run')),
      'plugin log captured',
    ).toBe(true);
    const local = log
      .map((l) => /Staging the export locally in \\?"([^"\\]+)\\?"/.exec(l)?.[1])
      .filter((dir): dir is string => dir !== undefined);
    expect(log.filter((l) => l.includes('same disk as the plugin data'))).toEqual([]);
    if (!mode.stageLocally) {
      expect(local).toEqual([]);
      return;
    }
    expect(local).toHaveLength(1);
    expect(path.dirname(local[0])).toBe(joplin.localStagingRoot);
    expect(await exists(local[0]), 'local staging directory is removed').toBe(false);
  }

  function backdateLastBackup(): void {
    joplin.writePluginSettings({ lastBackup: new Date(Date.now() - 3 * DAY_MS).toISOString() });
  }

  beforeAll(async () => {
    try {
      await setUp();
    } catch (error) {
      failed = true;
      throw error;
    }
  });

  async function setUp(): Promise<void> {
    const root = process.env.JOPLIN_E2E_WORKDIR;
    if (root) {
      workDir = path.resolve(root, mode.slug);
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.mkdir(workDir, { recursive: true });
    } else {
      workDir = await fs.mkdtemp(path.join(os.tmpdir(), `joplin-e2e-${mode.slug}-`));
    }
    // The plugin logs real paths; compare like with like (macOS /var → /private/var).
    workDir = await fs.realpath(workDir);
    joplin = new JoplinInstance(workDir);

    if (mode.stageLocally) {
      // Local staging is skipped when the plugin data and the backups share a
      // disk, so put the backups on another device.
      backupParent = await fs.realpath(
        await fs.mkdtemp(path.join(OTHER_DEVICE_ROOT, 'joplin-e2e-backups-')),
      );
      const [work, other] = await Promise.all([fs.stat(workDir), fs.stat(backupParent)]);
      if (work.dev === other.dev) {
        throw new Error(
          `${OTHER_DEVICE_ROOT} is on the same device as ${workDir}; set ` +
            'JOPLIN_E2E_OTHER_DEVICE to a directory on another filesystem (e.g. a tmpfs).',
        );
      }
    } else {
      backupParent = workDir;
    }
    backupDir = path.join(backupParent, 'backups');
  }

  afterAll(async () => {
    try {
      await joplin?.stop();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await cleanUp();
    }
  });

  async function cleanUp(): Promise<void> {
    if (failed || process.env.JOPLIN_E2E_KEEP) {
      if (workDir) console.log(`Kept e2e work directory: ${workDir} (backups: ${backupDir})`);
      return;
    }
    if (backupParent && backupParent !== workDir) {
      await fs.rm(backupParent, { recursive: true, force: true });
    }
    if (workDir && !process.env.JOPLIN_E2E_WORKDIR) {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  // Steps build on each other; stop at the first failure.
  afterEach((context) => {
    if (context.task.result?.state === 'fail') failed = true;
  });
  beforeEach((context) => {
    if (failed) context.skip();
  });

  it('seeds a profile through the Data API', async () => {
    await joplin.start();

    ids.folder = (await joplin.createFolder('E2E notebook')).id;
    ids.otherFolder = (await joplin.createFolder('E2E other notebook')).id;
    ids.resource = (await joplin.createResource('attachment.txt', ATTACHMENT, 'text/plain')).id;
    ids.unchangedNote = (
      await joplin.createNote({
        title: 'Unchanged note',
        body: `Stays the same.\n\n[attachment](:/${ids.resource})`,
        parent_id: ids.folder,
      })
    ).id;
    ids.editedNote = (
      await joplin.createNote({
        title: 'Edited note',
        body: 'Original body.',
        parent_id: ids.folder,
      })
    ).id;
    ids.deletedNote = (
      await joplin.createNote({
        title: 'Deleted note',
        body: 'Will be deleted.',
        parent_id: ids.otherFolder,
      })
    ).id;
    ids.tag = (await joplin.createTag('e2e-tag')).id;
    await joplin.tagNote(ids.tag, ids.unchangedNote);

    await joplin.stop();

    // The plugin registered its settings, but has no directory, so no backup.
    expect(await exists(backupDir)).toBe(false);
  });

  it('takes a first snapshot on the startup schedule', async () => {
    joplin.writePluginSettings({ backupPath: backupDir, stageLocally: mode.stageLocally });
    const record = await launchAndAwaitBackup('success');

    const names = await snapshotNames();
    expect(names).toHaveLength(1);
    expect(record.snapshotName).toBe(names[0]);
    snapshots.push(names[0]);
    const snapshotDir = path.join(backupDir, names[0]);

    expect((await fs.readFile(path.join(backupDir, 'latest.txt'), 'utf8')).trim()).toBe(names[0]);
    expect(await exists(path.join(backupDir, '.joplin-incremental-backup'))).toBe(true);

    // Every item is in the Raw export layout.
    for (const id of [
      ids.folder,
      ids.otherFolder,
      ids.unchangedNote,
      ids.editedNote,
      ids.deletedNote,
      ids.tag,
    ]) {
      expect(await exists(path.join(snapshotDir, `${id}.md`)), `${id}.md`).toBe(true);
    }
    expect(await fs.readFile(path.join(snapshotDir, `${ids.editedNote}.md`), 'utf8')).toContain(
      'Original body.',
    );
    const resourceFiles = (await fs.readdir(path.join(snapshotDir, 'resources'))).filter((f) =>
      f.startsWith(ids.resource),
    );
    expect(resourceFiles).toHaveLength(1);
    expect(await fs.readFile(path.join(snapshotDir, 'resources', resourceFiles[0]))).toEqual(
      ATTACHMENT,
    );

    // The manifest describes every file exactly.
    const manifest = await readManifest(names[0]);
    expect(manifest.snapshotId).toBe(names[0]);
    expect(manifest.joplinVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.fileCount).toBe(manifest.files.length);
    for (const file of manifest.files) {
      const data = await fs.readFile(path.join(snapshotDir, file.path));
      expect(data.length, file.path).toBe(file.size);
      expect(sha256(data), file.path).toBe(file.sha256);
    }

    // Now change the vault for the next run.
    await joplin.updateNote(ids.editedNote, { body: 'Edited body.' });
    await joplin.deleteNotePermanently(ids.deletedNote);
    ids.addedNote = (
      await joplin.createNote({ title: 'Added note', body: 'Brand new.', parent_id: ids.folder })
    ).id;
    await joplin.stop();
    await expectStaging();

    expect(joplin.readPluginSetting('lastSnapshot')).toBe(names[0]);
    expect(joplin.readPluginSetting('lastBackup')).toBeTruthy();
  });

  it('takes a deduplicated second snapshot on catch-up', async () => {
    backdateLastBackup();
    const { changes } = await launchAndAwaitBackup('success');
    await joplin.stop();
    await expectStaging();

    const names = await snapshotNames();
    expect(names).toHaveLength(2);
    const [first, second] = names;
    expect(first).toBe(snapshots[0]);
    snapshots.push(second);
    expect((await fs.readFile(path.join(backupDir, 'latest.txt'), 'utf8')).trim()).toBe(second);

    const inFirst = (rel: string) => path.join(backupDir, first, rel);
    const inSecond = (rel: string) => path.join(backupDir, second, rel);

    // Unchanged files are hardlinks to the previous snapshot.
    const manifest = await readManifest(second);
    expect(manifest.deduplication).toBe('hardlink');
    const resourcePath = manifest.files
      .map((f) => f.path)
      .find((p) => p.startsWith(`resources/${ids.resource}`));
    expect(resourcePath).toBeDefined();
    for (const rel of [`${ids.unchangedNote}.md`, `${ids.folder}.md`, resourcePath!]) {
      const [a, b] = await Promise.all([fs.stat(inFirst(rel)), fs.stat(inSecond(rel))]);
      expect(b.ino, `${rel} should be hardlinked`).toBe(a.ino);
    }

    // The edited note is a new file with the new content.
    const editedRel = `${ids.editedNote}.md`;
    const [oldEdited, newEdited] = await Promise.all([
      fs.stat(inFirst(editedRel)),
      fs.stat(inSecond(editedRel)),
    ]);
    expect(newEdited.ino).not.toBe(oldEdited.ino);
    expect(await fs.readFile(inSecond(editedRel), 'utf8')).toContain('Edited body.');
    expect(await fs.readFile(inFirst(editedRel), 'utf8')).toContain('Original body.');

    // Deleted and added notes.
    expect(await exists(inSecond(`${ids.deletedNote}.md`))).toBe(false);
    expect(await exists(inFirst(`${ids.deletedNote}.md`))).toBe(true);
    expect(await exists(inSecond(`${ids.addedNote}.md`))).toBe(true);

    // The recorded change summary agrees.
    expect(changes?.modified).toContain(editedRel);
    expect(changes?.added).toContain(`${ids.addedNote}.md`);
    expect(changes?.deleted).toContain(`${ids.deletedNote}.md`);
    expect(changes?.modified).not.toContain(`${ids.unchangedNote}.md`);

    for (const file of manifest.files) {
      const data = await fs.readFile(inSecond(file.path));
      expect(sha256(data), file.path).toBe(file.sha256);
    }
  });

  it('skips the run when nothing changed', async () => {
    backdateLastBackup();
    await launchAndAwaitBackup('skipped');
    await joplin.stop();

    expect(await snapshotNames()).toEqual(snapshots);
    expect(joplin.readPluginSetting('lastBackupResult')).toMatch(/^Skipped \(no changes\)/);
  });
});
