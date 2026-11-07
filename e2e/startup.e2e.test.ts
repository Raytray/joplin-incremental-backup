/**
 * End-to-end: what the plugin does at startup, before and around the
 * scheduled run, in a real Joplin. Complements backup.e2e.test.ts, which
 * covers the normal snapshot cycle.
 *
 *   1. No usable backup directory (a relative path) → automatic backups are
 *      paused and nothing is written.
 *   2. Upgrading from a version without the root marker, with the drive
 *      missing → the run is refused and the directory is not created.
 *   3. A first snapshot. Then move a note, rename a notebook, trash a note
 *      and attach a new file.
 *   4. A crash left a stale lock and staging directories behind → they are
 *      cleaned up at startup (except one that may belong to a live run), and
 *      the next snapshot records the changes from step 3.
 *   5. Another instance holds a fresh lock → the run backs off and touches
 *      nothing.
 *   6. "Only back up when something changed" off → an unchanged vault still
 *      gets a snapshot, made entirely of hardlinks.
 *   7. Interval 0, or a last backup less than two intervals old → no backup
 *      at startup.
 */
import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../src/retention';
import {
  ACTIVE_DIR_PREFIX,
  backdateLastBackup,
  DAY_MS,
  exists,
  expectNoRunStarted,
  expectSnapshotIntact,
  inode,
  launchAndAwaitBackup,
  LOCK_FILENAME,
  makeWorkDir,
  readLatest,
  removeWorkDir,
  waitForLogLine,
} from './helpers';
import { JoplinInstance } from './joplin';

const HOUR_MS = 60 * 60 * 1000;
/** Older than the plugin's 30-minute stale-lock threshold. */
const STALE_AGE_MS = 2 * HOUR_MS;
const ATTACHMENT = Buffer.from(`first attachment ${Date.now()}\n`.repeat(32));
const SECOND_ATTACHMENT = Buffer.from(`second attachment ${Date.now()}\n`.repeat(32));

describe('startup behaviour in a real Joplin', () => {
  let workDir: string;
  let backupDir: string;
  let joplin: JoplinInstance;
  let failed = false;

  const ids = {
    folder: '',
    otherFolder: '',
    movedNote: '',
    trashedNote: '',
    attachingNote: '',
    resource: '',
    secondResource: '',
  };
  const snapshots: string[] = [];

  const snapshotNames = () => listSnapshots(backupDir);

  /** Launch, wait until the plugin logs `pattern`, and check no run follows. */
  async function launchExpectingNoRun(pattern: RegExp): Promise<void> {
    const before = joplin.readPluginSetting('lastBackupResultJson');
    await joplin.start();
    // Logged when the schedule is set up, so the grace period starts no earlier.
    await waitForLogLine(joplin, pattern);
    await expectNoRunStarted(joplin, before);
    await joplin.stop();
  }

  /** Create a directory (and its parents) and set its mtime `ageMs` in the past. */
  async function plantDir(dir: string, ageMs: number): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'partial.md'), 'left over by a crashed run\n');
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(dir, when, when);
  }

  async function plantLock(ageMs: number): Promise<string> {
    const lockPath = path.join(backupDir, LOCK_FILENAME);
    const when = new Date(Date.now() - ageMs);
    await fs.writeFile(lockPath, when.toISOString());
    await fs.utimes(lockPath, when, when);
    return lockPath;
  }

  beforeAll(async () => {
    try {
      workDir = await makeWorkDir('startup');
      joplin = new JoplinInstance(workDir);
      backupDir = path.join(workDir, 'backups');
    } catch (error) {
      failed = true;
      throw error;
    }
  });

  afterAll(async () => {
    try {
      await joplin?.stop();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await removeWorkDir(workDir, failed);
    }
  });

  // Steps build on each other; stop at the first failure.
  afterEach((context) => {
    if (context.task.result?.state === 'fail') failed = true;
  });
  beforeEach((context) => {
    if (failed) context.skip();
  });

  it('pauses automatic backups while the backup directory is not absolute', async () => {
    await joplin.start();
    ids.folder = (await joplin.createFolder('E2E notebook')).id;
    ids.otherFolder = (await joplin.createFolder('E2E other notebook')).id;
    ids.resource = (await joplin.createResource('first.txt', ATTACHMENT, 'text/plain')).id;
    ids.movedNote = (
      await joplin.createNote({ title: 'Moved note', body: 'Moves.', parent_id: ids.folder })
    ).id;
    ids.trashedNote = (
      await joplin.createNote({ title: 'Trashed note', body: 'Goes.', parent_id: ids.folder })
    ).id;
    ids.attachingNote = (
      await joplin.createNote({
        title: 'Attaching note',
        body: `[first](:/${ids.resource})`,
        parent_id: ids.otherFolder,
      })
    ).id;
    await joplin.stop();

    joplin.writePluginSettings({ backupPath: 'relative/backups' });
    await launchExpectingNoRun(/Auto-backup paused: no usable backup directory/);
    expect(joplin.readPluginSetting('lastBackup') ?? '').toBe('');
  });

  it('refuses to create a missing directory after an upgrade from a version without markers', async () => {
    // Backups were made before (`lastBackup` is set) but no directory was ever
    // marked: the first run after upgrading. A missing directory is most
    // likely an unmounted drive.
    joplin.writePluginSettings({ backupPath: backupDir });
    const lastBackup = backdateLastBackup(joplin);
    const record = await launchAndAwaitBackup(joplin, backupDir, 'failed');
    await joplin.stop();

    expect(record.error).toContain('does not exist, but backups have been made before');
    expect(await exists(backupDir), 'backup directory must not be created').toBe(false);
    expect(joplin.readPluginSetting('lastBackup')).toBe(lastBackup);
    // The refused directory is not remembered as set up, so creating it by
    // hand (the next step) makes it usable.
    expect(joplin.readPluginSetting('initializedBackupRoots') ?? '[]').toBe('[]');
  });

  it('takes a first snapshot once the directory exists', async () => {
    // What the error message tells the user to do for a new location.
    await fs.mkdir(backupDir);
    const { snapshotName } = await launchAndAwaitBackup(joplin, backupDir, 'success');

    // Change the vault for the next run.
    await joplin.updateNote(ids.movedNote, { parent_id: ids.otherFolder });
    await joplin.updateFolder(ids.folder, { title: 'E2E notebook, renamed' });
    await joplin.trashNote(ids.trashedNote);
    ids.secondResource = (
      await joplin.createResource('second.txt', SECOND_ATTACHMENT, 'text/plain')
    ).id;
    await joplin.updateNote(ids.attachingNote, {
      body: `[first](:/${ids.resource}) [second](:/${ids.secondResource})`,
    });
    await joplin.stop();

    expect(await snapshotNames()).toEqual([snapshotName]);
    snapshots.push(snapshotName!);
    expect(await exists(path.join(backupDir, '.joplin-incremental-backup'))).toBe(true);
    expect(JSON.parse(joplin.readPluginSetting('initializedBackupRoots') ?? '[]')).toEqual([
      backupDir,
    ]);
  });

  it('cleans up after a crashed run and records moves, renames, trash and new attachments', async () => {
    const staleDir = `${ACTIVE_DIR_PREFIX}crashed`;
    // Recent enough that it may belong to a run that has only just started.
    const recentDir = `${ACTIVE_DIR_PREFIX}recent`;
    const localLeftover = path.join(joplin.localStagingRoot, `${ACTIVE_DIR_PREFIX}crashed`);
    await plantDir(path.join(backupDir, staleDir), STALE_AGE_MS);
    await plantDir(path.join(backupDir, recentDir), 0);
    await plantDir(localLeftover, STALE_AGE_MS);
    await plantLock(STALE_AGE_MS);

    backdateLastBackup(joplin);
    const { snapshotName, changes } = await launchAndAwaitBackup(joplin, backupDir, 'success', {
      keepStagingDirs: [recentDir],
    });
    await joplin.stop();

    expect(await exists(path.join(backupDir, staleDir)), 'stale staging dir removed').toBe(false);
    expect(await exists(path.join(backupDir, recentDir)), 'recent staging dir kept').toBe(true);
    expect(await exists(localLeftover), 'local staging leftover removed').toBe(false);
    await fs.rm(path.join(backupDir, recentDir), { recursive: true });

    expect(await snapshotNames()).toEqual([...snapshots, snapshotName]);
    snapshots.push(snapshotName!);
    const [first, second] = snapshots;
    const read = (snapshot: string, id: string) =>
      fs.readFile(path.join(backupDir, snapshot, `${id}.md`), 'utf8');

    // Moved note: same file name, new parent.
    expect(changes?.modified).toContain(`${ids.movedNote}.md`);
    expect(await read(first, ids.movedNote)).toContain(`parent_id: ${ids.folder}`);
    expect(await read(second, ids.movedNote)).toContain(`parent_id: ${ids.otherFolder}`);

    // Renamed notebook.
    expect(changes?.modified).toContain(`${ids.folder}.md`);
    expect(await read(second, ids.folder)).toMatch(/^E2E notebook, renamed$/m);

    // Known limitation, not the behaviour we want: Joplin's export (and the
    // Data API's note list) leave out trashed notes, so a note in the trash
    // drops out of the newest snapshot, with no warning, while Joplin can
    // still restore it. Once retention prunes the older snapshots it is in no
    // backup. A fix that backs up the trash should update these assertions.
    expect(changes?.deleted).toEqual([`${ids.trashedNote}.md`]);
    expect(await exists(path.join(backupDir, second, `${ids.trashedNote}.md`))).toBe(false);
    expect(await read(first, ids.trashedNote)).toContain('Goes.');

    // The new attachment is backed up; the old one is shared with the first
    // snapshot.
    const resources = (await fs.readdir(path.join(backupDir, second, 'resources'))).sort();
    const resourceFile = (id: string) => resources.find((f) => f.startsWith(id));
    expect(resourceFile(ids.secondResource)).toBeDefined();
    expect(changes?.added).toContain(`resources/${resourceFile(ids.secondResource)}`);
    expect(
      await fs.readFile(
        path.join(backupDir, second, 'resources', resourceFile(ids.secondResource)!),
      ),
    ).toEqual(SECOND_ATTACHMENT);
    expect(resourceFile(ids.resource)).toBeDefined();
    const firstResource = `resources/${resourceFile(ids.resource)}`;
    expect(await inode(backupDir, second, firstResource)).toBe(
      await inode(backupDir, first, firstResource),
    );
    await expectSnapshotIntact(backupDir, second);
  });

  it('backs off while another instance holds a fresh lock', async () => {
    const lockPath = await plantLock(0);
    const lockBefore = await fs.stat(lockPath);
    const resultBefore = joplin.readPluginSetting('lastBackupResultJson');
    const lastBackup = backdateLastBackup(joplin);
    // The lock must outlive the run's own cleanup check, so watch the log.
    try {
      await joplin.start();
      await waitForLogLine(joplin, /Another backup holds the lock; skipping this scheduled run/);
      // Contention is not a failed run: the lock holder records its own
      // result. The retry is minutes away, so nothing else starts either.
      await expectNoRunStarted(joplin, resultBefore);
      const log = await joplin.pluginLog();
      await joplin.stop();

      expect(log.some((l) => l.includes('leaving staging data in place'))).toBe(true);
      const lockAfter = await fs.stat(lockPath);
      expect(lockAfter.mtimeMs, 'lock left untouched').toBe(lockBefore.mtimeMs);
      expect(await snapshotNames()).toEqual(snapshots);
      expect(joplin.readPluginSetting('lastBackup')).toBe(lastBackup);
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  });

  it('takes a snapshot of an unchanged vault when "only on change" is off', async () => {
    joplin.writePluginSettings({ onlyOnChange: false });
    backdateLastBackup(joplin);
    const { snapshotName, changes } = await launchAndAwaitBackup(joplin, backupDir, 'success');
    await joplin.stop();
    joplin.writePluginSettings({ onlyOnChange: true });

    expect(await snapshotNames()).toEqual([...snapshots, snapshotName]);
    const previous = snapshots[snapshots.length - 1];
    snapshots.push(snapshotName!);
    expect(await readLatest(backupDir)).toBe(snapshotName);

    expect(changes?.added).toEqual([]);
    expect(changes?.modified).toEqual([]);
    expect(changes?.deleted).toEqual([]);
    const manifest = await expectSnapshotIntact(backupDir, snapshotName!);
    for (const file of manifest.files) {
      expect(await inode(backupDir, snapshotName!, file.path), file.path).toBe(
        await inode(backupDir, previous, file.path),
      );
    }
  });

  it('does not back up at startup when automatic backups are off', async () => {
    joplin.writePluginSettings({ backupInterval: 0 });
    backdateLastBackup(joplin, 30 * DAY_MS);
    await launchExpectingNoRun(/Auto-backup disabled \(interval is 0\)/);
    expect(await snapshotNames()).toEqual(snapshots);
  });

  it('waits for the next interval when the last backup is less than two intervals old', async () => {
    // 1.5 intervals old: overdue, but not enough for a catch-up at startup.
    // The next run is due 12 h after the back-date; the log rounds to whole
    // hours, so a slow launch does not change it.
    joplin.writePluginSettings({ backupInterval: 24 });
    backdateLastBackup(joplin, 36 * HOUR_MS);
    await launchExpectingNoRun(/scheduling the next run in 12h/);
    expect(await snapshotNames()).toEqual(snapshots);
  });
});
