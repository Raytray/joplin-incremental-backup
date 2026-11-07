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
 *   5. Tag an existing note (nothing else) → the change is detected.
 *   6. Lower retention to 2 → the next snapshot prunes the two oldest,
 *      without damaging the hardlinked files the survivors share with them.
 *   7. Move the backup directory away (an unmounted drive) → the run is
 *      refused and the directory is not recreated.
 *
 * The scenario runs twice: staging the export on the backup drive (the
 * default), and with "Stage the export on this computer" on, with the backups
 * on a different filesystem so local staging is not skipped.
 */
import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../src/retention';
import {
  backdateLastBackup as backdate,
  exists,
  expectSnapshotIntact as expectIntact,
  inode as inodeIn,
  launchAndAwaitBackup as launchAndAwait,
  makeWorkDir,
  readLatest as readLatestIn,
  removeWorkDir,
} from './helpers';
import { JoplinInstance } from './joplin';

/** A directory on a different filesystem from the work directory (tmpfs). */
const OTHER_DEVICE_ROOT = process.env.JOPLIN_E2E_OTHER_DEVICE ?? '/dev/shm';

const MODES = [
  { name: 'staging on the backup drive', slug: 'drive', stageLocally: false },
  { name: 'staging locally', slug: 'local', stageLocally: true },
] as const;
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

  const snapshotNames = () => listSnapshots(backupDir);
  const launchAndAwaitBackup = (expectedStatus: 'success' | 'skipped' | 'failed') =>
    launchAndAwait(joplin, backupDir, expectedStatus);
  const backdateLastBackup = () => backdate(joplin);
  const readLatest = () => readLatestIn(backupDir);
  const expectSnapshotIntact = (snapshot: string) => expectIntact(backupDir, snapshot);
  const inode = (snapshot: string, rel: string) => inodeIn(backupDir, snapshot, rel);

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

  beforeAll(async () => {
    try {
      await setUp();
    } catch (error) {
      failed = true;
      throw error;
    }
  });

  async function setUp(): Promise<void> {
    workDir = await makeWorkDir(mode.slug);
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
    const otherDevice = backupParent && backupParent !== workDir ? [backupParent] : [];
    await removeWorkDir(workDir, failed, otherDevice);
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

    expect(await readLatest()).toBe(names[0]);
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
    const manifest = await expectSnapshotIntact(names[0]);
    expect(manifest.snapshotId).toBe(names[0]);
    expect(manifest.joplinVersion).toMatch(/^\d+\.\d+\.\d+/);

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
    expect(await readLatest()).toBe(second);

    const inFirst = (rel: string) => path.join(backupDir, first, rel);
    const inSecond = (rel: string) => path.join(backupDir, second, rel);

    // Unchanged files are hardlinks to the previous snapshot.
    const manifest = await expectSnapshotIntact(second);
    expect(manifest.deduplication).toBe('hardlink');
    const resourcePath = manifest.files
      .map((f) => f.path)
      .find((p) => p.startsWith(`resources/${ids.resource}`));
    expect(resourcePath).toBeDefined();
    for (const rel of [`${ids.unchangedNote}.md`, `${ids.folder}.md`, resourcePath!]) {
      expect(await inode(second, rel), `${rel} should be hardlinked`).toBe(await inode(first, rel));
    }

    // The edited note is a new file with the new content.
    const editedRel = `${ids.editedNote}.md`;
    expect(await inode(second, editedRel)).not.toBe(await inode(first, editedRel));
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
  });

  it('skips the run when nothing changed', async () => {
    backdateLastBackup();
    await launchAndAwaitBackup('skipped');
    // A tag-only change for the next step, made while the app is up.
    await joplin.tagNote(ids.tag, ids.editedNote);
    await joplin.stop();

    expect(await snapshotNames()).toEqual(snapshots);
    expect(joplin.readPluginSetting('lastBackupResult')).toMatch(/^Skipped \(no changes\)/);
  });

  it('detects a tag-only change', async () => {
    // The previous step tagged a note and changed nothing else.
    backdateLastBackup();
    const { changes, snapshotName } = await launchAndAwaitBackup('success');
    // Change the vault for the retention step while the app is up.
    await joplin.updateNote(ids.addedNote, { body: 'Brand new, edited.' });
    await joplin.stop();

    const names = await snapshotNames();
    expect(names).toEqual([...snapshots, snapshotName]);
    snapshots.push(snapshotName!);

    // The only change is one new file, the note↔tag link.
    expect(changes?.modified).toEqual([]);
    expect(changes?.deleted).toEqual([]);
    expect(changes?.added).toHaveLength(1);
    const link = await fs.readFile(path.join(backupDir, snapshotName!, changes!.added[0]), 'utf8');
    expect(link).toContain(`note_id: ${ids.editedNote}`);
    expect(link).toContain(`tag_id: ${ids.tag}`);
    await expectSnapshotIntact(snapshotName!);
  });

  it('prunes old snapshots without damaging the ones it keeps', async () => {
    joplin.writePluginSettings({ backupRetention: 2 });
    backdateLastBackup();
    const { snapshotName } = await launchAndAwaitBackup('success');
    await joplin.stop();

    const kept = [snapshots[snapshots.length - 1], snapshotName!];
    expect(await snapshotNames()).toEqual(kept);
    expect(await readLatest()).toBe(kept[1]);
    snapshots.splice(0, snapshots.length, ...kept);

    // The survivors shared hardlinks with the pruned snapshots; every file
    // must still be present and intact.
    for (const snapshot of kept) await expectSnapshotIntact(snapshot);
    const unchanged = `${ids.unchangedNote}.md`;
    expect(await inode(kept[1], unchanged), `${unchanged} still hardlinked`).toBe(
      await inode(kept[0], unchanged),
    );
  });

  it('refuses to back up when the backup drive is missing', async () => {
    // What an unmounted drive looks like: the configured directory is gone.
    const unmounted = `${backupDir}.unmounted`;
    const lastSnapshot = joplin.readPluginSetting('lastSnapshot');
    const latest = await readLatest();
    await fs.rename(backupDir, unmounted);
    let recreated: boolean;
    try {
      const lastBackup = backdateLastBackup();
      const record = await launchAndAwaitBackup('failed');
      await joplin.stop();

      expect(record.error).toContain('is not available');
      expect(record.error).toContain('.joplin-incremental-backup');
      // A failed run must not count as a backup, or the retry would be
      // pushed back a full interval.
      expect(joplin.readPluginSetting('lastBackup')).toBe(lastBackup);
      expect(joplin.readPluginSetting('lastSnapshot')).toBe(lastSnapshot);
    } finally {
      // Put the real backups back even if the run did not fail as expected,
      // so a kept work directory shows them where the log says they are.
      recreated = await exists(backupDir);
      await fs.rm(backupDir, { recursive: true, force: true });
      await fs.rename(unmounted, backupDir);
    }

    expect(recreated, 'backup directory must not be recreated').toBe(false);
    expect(await snapshotNames()).toEqual(snapshots);
    expect(await readLatest()).toBe(latest);
  });
});
