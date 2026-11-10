/**
 * Helpers shared by the e2e scenarios: launching Joplin for one scheduled
 * backup run, and checking what that run left on disk.
 */
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect } from 'vitest';
import type { BackupRecord, CompletedRecord, FailedRecord } from '../src/result';
import type { Manifest } from '../src/manifest';
import { JoplinInstance, sleep, waitFor } from './joplin';

export const BACKUP_TIMEOUT_MS = 120_000;
export const DAY_MS = 24 * 60 * 60 * 1000;
// snapshots.ts doesn't import the Joplin plugin API, so it loads outside Joplin.
import { ACTIVE_DIR_PREFIX, LOCK_FILENAME } from '../src/snapshots';

export { ACTIVE_DIR_PREFIX, LOCK_FILENAME };

/**
 * The persisted run record as the tests read it: any field of either record
 * shape may be missing (e.g. `{}` when nothing was recorded yet).
 */
export type RunRecord = { status?: BackupRecord['status'] } & Partial<
  Omit<CompletedRecord, 'status'> & Omit<FailedRecord, 'status'>
>;

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fresh work directory for one scenario: under `JOPLIN_E2E_WORKDIR/<slug>`
 * when set (CI keeps it for the log upload), otherwise a temp directory. Its
 * real path, since the plugin logs real paths (macOS /var → /private/var).
 */
export async function makeWorkDir(slug: string): Promise<string> {
  const root = process.env.JOPLIN_E2E_WORKDIR;
  let dir: string;
  if (root) {
    dir = path.resolve(root, slug);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
  } else {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), `joplin-e2e-${slug}-`));
  }
  return fs.realpath(dir);
}

/**
 * Remove a scenario's work directory and `extraDirs` (directories it uses
 * outside it), unless the scenario failed or `JOPLIN_E2E_KEEP` is set: then
 * say where they are and where its backups are. A work directory under
 * `JOPLIN_E2E_WORKDIR` is kept.
 */
export async function removeWorkDir(
  workDir: string | undefined,
  failed: boolean,
  { backupDir, extraDirs = [] }: { backupDir?: string; extraDirs?: string[] } = {},
): Promise<void> {
  if (!workDir) return;
  if (failed || process.env.JOPLIN_E2E_KEEP) {
    const backups = backupDir ? ` (backups: ${backupDir})` : '';
    console.log(`Kept e2e work directory: ${workDir}${backups}`);
    return;
  }
  for (const dir of extraDirs) await fs.rm(dir, { recursive: true, force: true });
  if (!process.env.JOPLIN_E2E_WORKDIR) await fs.rm(workDir, { recursive: true, force: true });
}

export function readRunRecord(joplin: JoplinInstance): RunRecord {
  return JSON.parse(joplin.readPluginSetting('lastBackupResultJson') || '{}') as RunRecord;
}

/** Back-date `lastBackup` so the next launch runs a catch-up backup; returns the value. */
export function backdateLastBackup(joplin: JoplinInstance, ageMs = 3 * DAY_MS): string {
  const lastBackup = new Date(Date.now() - ageMs).toISOString();
  joplin.writePluginSettings({ lastBackup });
  return lastBackup;
}

export interface LaunchOptions {
  /**
   * Staging directories on the backup drive that are expected to outlive the
   * run (planted by the test), so they do not count as unfinished cleanup.
   */
  keepStagingDirs?: readonly string[];
}

/**
 * Launch Joplin and wait for the scheduled run to record a new result.
 * Settings reach the database 500 ms after the plugin sets them, so the
 * read-only poll sees the run finish without stopping the app.
 */
export async function launchAndAwaitBackup(
  joplin: JoplinInstance,
  backupDir: string,
  expectedStatus: 'success' | 'skipped' | 'failed',
  options: LaunchOptions = {},
): Promise<RunRecord> {
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
    async () => ((await runIsCleanedUp(joplin, backupDir, options)) ? true : undefined),
    BACKUP_TIMEOUT_MS,
  );
  const record = readRunRecord(joplin);
  expect(record.status, record.message ?? record.error).toBe(expectedStatus);
  expect(record.warnings ?? []).toEqual([]);
  return record;
}

async function runIsCleanedUp(
  joplin: JoplinInstance,
  backupDir: string,
  { keepStagingDirs = [] }: LaunchOptions,
): Promise<boolean> {
  if (await exists(path.join(backupDir, LOCK_FILENAME))) return false;
  const onDrive = await fs.readdir(backupDir).catch(() => [] as string[]);
  const leftOver = onDrive.filter(
    (name) => name.startsWith(ACTIVE_DIR_PREFIX) && !keepStagingDirs.includes(name),
  );
  if (leftOver.length > 0) return false;
  const local = await fs.readdir(joplin.localStagingRoot).catch(() => [] as string[]);
  return local.length === 0;
}

/** Wait until the plugin has logged a line matching `pattern`; returns that line. */
export async function waitForLogLine(
  joplin: JoplinInstance,
  pattern: RegExp,
  timeoutMs = BACKUP_TIMEOUT_MS,
): Promise<string> {
  return waitFor(
    `the plugin to log ${pattern}`,
    async () => (await joplin.pluginLog()).find((line) => pattern.test(line)),
    timeoutMs,
  );
}

/**
 * `CATCH_UP_GRACE_MS` from src/scheduler.ts: how long after startup the
 * scheduler starts a due backup.
 */
const CATCH_UP_GRACE_MS = 5_000;
/** Extra time to watch for a run that must not start, beyond the grace period. */
const NO_RUN_MARGIN_MS = 5_000;
const RUN_STARTED = 'Starting backup run';

/**
 * Check that no backup run starts: watch the plugin log until the scheduler's
 * startup grace period (counted from now) has passed with a margin, failing
 * as soon as a run starts, then check no result was recorded since
 * `resultBefore` (the `lastBackupResultJson` before launch).
 */
export async function expectNoRunStarted(
  joplin: JoplinInstance,
  resultBefore: string | undefined,
): Promise<void> {
  const deadline = Date.now() + CATCH_UP_GRACE_MS + NO_RUN_MARGIN_MS;
  let started: string[] = [];
  while (Date.now() < deadline) {
    started = (await joplin.pluginLog()).filter((l) => l.includes(RUN_STARTED));
    if (started.length > 0) break;
    await sleep(500);
  }
  expect(started, 'no backup run started').toEqual([]);
  expect(joplin.readPluginSetting('lastBackupResultJson')).toBe(resultBefore);
}

/**
 * Parsed independently of the plugin's own reader, so the test checks the
 * on-disk format rather than trusting the code under test.
 */
export async function readManifest(backupDir: string, snapshot: string): Promise<Manifest> {
  return JSON.parse(
    await fs.readFile(path.join(backupDir, snapshot, 'manifest.json'), 'utf8'),
  ) as Manifest;
}

/** Every file the snapshot's manifest lists is present with its size and hash. */
export async function expectSnapshotIntact(backupDir: string, snapshot: string): Promise<Manifest> {
  const manifest = await readManifest(backupDir, snapshot);
  expect(manifest.fileCount).toBe(manifest.files.length);
  for (const file of manifest.files) {
    const data = await fs.readFile(path.join(backupDir, snapshot, file.path));
    expect(data.length, `${snapshot}/${file.path}`).toBe(file.size);
    expect(sha256(data), `${snapshot}/${file.path}`).toBe(file.sha256);
  }
  return manifest;
}

export async function inode(backupDir: string, snapshot: string, rel: string): Promise<number> {
  return (await fs.stat(path.join(backupDir, snapshot, rel))).ino;
}

export async function readLatest(backupDir: string): Promise<string> {
  return (await fs.readFile(path.join(backupDir, 'latest.txt'), 'utf8')).trim();
}
