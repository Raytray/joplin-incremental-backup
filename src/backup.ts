import fs from 'fs/promises';
import path from 'path';
import joplin from 'api';
import { logger } from './logger';
import {
  acquireLock,
  LockError,
  assertDiskSpace,
  atomicWriteFile,
  collectFilesRecursive,
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_STALE_LOCK_MS,
  ensureBackupRoot,
  errorCode,
  hasFreshLock,
  releaseLock,
  safeRmDir,
  startLockHeartbeat,
  toManifestKey,
} from './platform';
import { buildManifest, readManifest, writeManifest } from './manifest';
import type { DeduplicationMode, Manifest, ManifestMeta } from './manifest';
import { dedup, getDeduplicationMode, stageFromLocal } from './dedup';
import type { DedupResult } from './dedup';
import { pruneSnapshots } from './retention';
import {
  addInitializedBackupRoot,
  getLastBackup,
  configuredBackupRoot,
  getSettings,
  isKnownBackupRoot,
  parseLastBackup,
  setLastBackup,
  setLastSnapshot,
} from './settings';
import { ToastType } from 'api/types';
import {
  computeChanges,
  describeWarnings,
  formatSeconds,
  persistResult,
  recordChanges,
  recordWarnings,
} from './result';
import type { BackupChanges, BackupWarning } from './result';
import {
  checkExportCompleteness,
  collectVaultInventory,
  fingerprintsEqual,
  getAllFolderIds,
} from './inventory';
import {
  activeDirPath,
  generateSnapshotName,
  LATEST_FILENAME,
  listStagingDirs,
  LOCK_FILENAME,
  resolveLastSnapshot,
  resolveUniqueSnapshotName,
  snapshotDirPath,
} from './snapshots';
import type { Settings } from './settings';

/**
 * Folder under the plugin's data directory that holds local staging
 * directories when "Stage the export on this computer" is on.
 */
export const LOCAL_STAGING_DIR_NAME = 'staging';
/**
 * Marker written into every backup directory the plugin sets up. Its absence
 * from a directory that was set up before means the directory is not the one
 * we were writing to (most often: the backup drive is not mounted).
 */
export const ROOT_MARKER_FILENAME = '.joplin-incremental-backup';
export const DEFAULT_EXPORT_RETRIES = 3;
export const EXPORT_FORMAT = 'raw';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const TRANSIENT_EXPORT_ERROR_PATTERNS = [
  /database is locked/i,
  /SQLITE_BUSY/i,
  /resource temporarily unavailable/i,
  /EBUSY/,
  /ETIMEDOUT/,
  /ECONNRESET/,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupStatus = 'success' | 'skipped';

export interface BackupResult {
  status: BackupStatus;
  snapshotName?: string;
  snapshotDir?: string;
  fileCount?: number;
  deduplication?: DeduplicationMode;
  hardlinked?: number;
  copied?: number;
  unchanged?: number;
  /**
   * Warnings reported by `exportFolders` (e.g. items skipped because they are
   * still encrypted). An empty array means the export was clean.
   */
  warnings?: string[];
  message: string;
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs?: number;
  /** Semantic change summary relative to the previous snapshot. */
  changes?: BackupChanges;
  /** Whether the export was staged on this computer rather than on the backup drive. */
  stagedLocally?: boolean;
  /**
   * Set when the run was skipped because another backup was recorded after
   * `skipIfBackedUpAfter`: that backup's `lastBackup` time, in ms since the epoch.
   */
  supersededBy?: number;
}

export interface BackupOptions {
  /** Optional profile name; snapshots are namespaced into a subfolder. */
  profileName?: string;
  /** Override the configured backup root (used by tests). */
  backupRoot?: string;
  /** Lock age after which it is considered abandoned. */
  staleLockMs?: number;
  /** Retry attempts for transient export failures. */
  exportRetries?: number;
  /** Minimum free bytes required at the backup root before running. */
  minFreeBytes?: number;
  /** Injectable clock for deterministic snapshot names. */
  now?: Date;
  /**
   * Injectable SHA-256 implementation for `verifyBackup` (used by tests;
   * defaults to the streaming one). `sizeHint` is the size from the manifest.
   * A backup run hashes with `hashFile`, which also gives the sizes.
   */
  computeHash?: (filePath: string, sizeHint?: number) => Promise<string>;
  /**
   * Skip the run if `lastBackup` is later than this time (ms since the epoch;
   * `-Infinity` for "never backed up") once the lock is held. Scheduled runs
   * pass the `lastBackup` their timer was armed with, so a backup that
   * finished while they waited to start is not repeated.
   */
  skipIfBackedUpAfter?: number;
  /**
   * Override the folder that holds local staging directories (used by tests).
   * Defaults to `staging/` under the plugin's data directory.
   */
  localStagingRoot?: string;
  /**
   * Leave out the "Backup started…" and "Backup failed" toasts (default
   * `false`). The scheduler sets it on retries after a failure, so an
   * unplugged drive does not raise a toast on every retry. Failures are still
   * logged and recorded as the last backup result, and a success still toasts.
   */
  quiet?: boolean;
}

interface ResolvedContext {
  settings: Settings;
  backupRoot: string;
  lockPath: string;
  activeDir: string;
  staleLockMs: number;
  exportRetries: number;
  /** Undefined means use `assertDiskSpace`'s default threshold. */
  minFreeBytes?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isTransientExportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return TRANSIENT_EXPORT_ERROR_PATTERNS.some(
    (pattern) => pattern.test(message) || (code ? pattern.test(code) : false),
  );
}

/**
 * Extract warnings from the `exportFolders` return value. Joplin's RAW exporter
 * reports skipped items (e.g. still-encrypted notes/resources) here rather than
 * failing, so a "successful" export can silently omit data. The shape is
 * `{ warnings: string[] }`, but the result is typed loosely by the plugin API,
 * so guard defensively.
 */
export function extractExportWarnings(result: unknown): string[] {
  if (typeof result !== 'object' || result === null || !('warnings' in result)) return [];
  const { warnings } = result as { warnings?: unknown };
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === 'string');
}

export async function retryTransient<T>(
  fn: () => Promise<T>,
  retries: number = DEFAULT_EXPORT_RETRIES,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(retries));
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientExportError(error) || attempt === maxAttempts - 1) throw error;
      logger.warn(`Transient export error (attempt ${attempt + 1}/${maxAttempts}); retrying.`);
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError;
}

async function resolveJoplinVersion(): Promise<string> {
  try {
    const info = await joplin.versionInfo();
    return info?.version ?? '';
  } catch (error) {
    logger.warn('Could not read joplin.versionInfo(); storing an empty version.', error);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

function localStagingWarning(error: unknown): BackupWarning {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    kind: 'staging',
    message: `The export could not be staged on this computer (${reason}); it was written to the backup drive instead.`,
  };
}

async function resolveLocalStagingRoot(options: BackupOptions): Promise<string> {
  if (options.localStagingRoot !== undefined) return options.localStagingRoot;
  return path.join(await joplin.plugins.dataDir(), LOCAL_STAGING_DIR_NAME);
}

/** Total size of the files in `manifest`, or 0 without one. */
function manifestBytes(manifest: Manifest | null): number {
  return manifest?.files.reduce((sum, file) => sum + file.size, 0) ?? 0;
}

/**
 * Prepare a local directory to export into, or explain why there is none.
 *
 * The export needs local space for a full copy of the vault. The previous
 * snapshot's size is the best estimate available before exporting, so the
 * local disk must have that much free on top of the usual minimum.
 *
 * When the local folder is on the same device as the backup root, staging
 * locally would write the full export to that device anyway and then copy the
 * changed files to it again, so `sameDevice` tells the caller to skip it.
 */
async function prepareLocalStaging(
  stagingRoot: string,
  backupRoot: string,
  runName: string,
  previousManifest: Manifest | null,
  minFreeBytes: number | undefined,
): Promise<{ dir: string } | { sameDevice: true } | { error: unknown }> {
  try {
    await fs.mkdir(stagingRoot, { recursive: true });
    const [local, backup] = await Promise.all([fs.stat(stagingRoot), fs.stat(backupRoot)]);
    if (local.dev === backup.dev) return { sameDevice: true };
    const required = (minFreeBytes ?? DEFAULT_MIN_FREE_BYTES) + manifestBytes(previousManifest);
    await assertDiskSpace(stagingRoot, required);
    return { dir: path.join(stagingRoot, runName) };
  } catch (error) {
    return { error };
  }
}

async function resolveContext(options: BackupOptions): Promise<ResolvedContext> {
  const settings = await getSettings();
  const backupRoot = configuredBackupRoot(settings, options);

  return {
    settings,
    backupRoot,
    lockPath: path.join(backupRoot, LOCK_FILENAME),
    activeDir: activeDirPath(backupRoot),
    staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
    exportRetries: options.exportRetries ?? DEFAULT_EXPORT_RETRIES,
    minFreeBytes: options.minFreeBytes,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export function legacyBackupRootMissingMessage(backupRoot: string): string {
  return (
    `The backup directory "${backupRoot}" does not exist, but backups have been made ` +
    'before. If the backup drive is disconnected or not mounted, reconnect it and try ' +
    'again. If this is a new location, create the directory first, or choose a ' +
    'different one in Tools > Options > Incremental Backup.'
  );
}

export function backupRootUnavailableMessage(backupRoot: string): string {
  return (
    `The backup directory "${backupRoot}" is not available: its marker file ` +
    `(${ROOT_MARKER_FILENAME}) is missing. If the backup drive is disconnected or not ` +
    'mounted, reconnect it and try again. If you moved or deleted the backups on purpose, ' +
    `create an empty file named ${ROOT_MARKER_FILENAME} in that directory, or choose a ` +
    'different one in Tools > Options > Incremental Backup.'
  );
}

/**
 * Make sure `backupRoot` is the directory this plugin has been writing to
 * before anything is written there.
 *
 * Creating the directory blindly (`mkdir -p`) is dangerous when it lives on a
 * drive that is not mounted: the path is recreated on the internal disk, the
 * disk-space check measures the wrong filesystem, and the snapshots end up
 * hidden underneath the mount point once the drive comes back.
 *
 * - Marker present → ready, and remembered so its later disappearance is
 *   caught (covers markers created by hand or by another profile).
 * - Marker missing, directory set up before → refuse (drive likely missing).
 * - Marker missing, directory never set up → create it and write the marker.
 *   This includes directories used by versions before the marker existed,
 *   with one exception: if backups were made before (`hasBackedUpBefore`) but
 *   no directory has been recorded yet, this is the first run after upgrading,
 *   and a directory that does not exist is far more likely an unmounted drive
 *   than a new location. Creating it would put the marker on the internal
 *   disk and lock the real drive out once it is mounted, so refuse instead.
 */
export async function prepareBackupRoot(
  backupRoot: string,
  initializedRoots: readonly string[],
  hasBackedUpBefore = false,
): Promise<void> {
  const markerPath = path.join(backupRoot, ROOT_MARKER_FILENAME);
  const known = isKnownBackupRoot(backupRoot, initializedRoots);
  if (await fileExists(markerPath)) {
    if (!known) await addInitializedBackupRoot(backupRoot);
    return;
  }

  if (known) {
    throw new Error(backupRootUnavailableMessage(backupRoot));
  }

  if (hasBackedUpBefore && initializedRoots.length === 0 && !(await pathExists(backupRoot))) {
    throw new Error(legacyBackupRootMissingMessage(backupRoot));
  }

  await ensureBackupRoot(backupRoot);
  await atomicWriteFile(
    markerPath,
    'This directory holds Joplin Incremental Backup snapshots. Do not delete this file.\n',
  );
  await addInitializedBackupRoot(backupRoot);
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Log, toast and persist a failed run so "Show last backup result" reflects
 * it.
 */
async function recordFailure(
  startTime: number,
  finishedAt: Date,
  error: unknown,
  notify: boolean,
): Promise<void> {
  const durationMs = Date.now() - startTime;
  const duration = formatSeconds(durationMs);
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Backup failed.', error);
  if (notify) {
    void joplin.views.dialogs
      .showToast({
        message: `Backup failed after ${duration}.`,
        type: ToastType.Error,
        duration: 6000,
      })
      .catch(() => undefined);
  }
  const finishedIso = finishedAt.toISOString();
  // persistResult never throws, so it cannot mask the original error.
  await persistResult(`${finishedIso} — failed — ${duration} — ${message}`, {
    status: 'failed',
    startedAt: new Date(startTime).toISOString(),
    finishedAt: finishedIso,
    durationMs,
    error: message,
  });
}

/**
 * The `lastBackup` time if a backup was recorded after `threshold`, else null.
 * A failed read also gives null: the run then goes ahead, as it would without
 * the check.
 */
async function backupRecordedAfter(threshold: number | undefined): Promise<number | null> {
  if (threshold === undefined) return null;
  try {
    const latest = parseLastBackup(await getLastBackup());
    return latest !== null && latest > threshold ? latest : null;
  } catch (error) {
    logger.warn('Could not read the last backup time; running the backup anyway.', error);
    return null;
  }
}

/** Skip result for a run made redundant by a backup recorded at `supersededBy`. */
function supersededResult(supersededBy: number): BackupResult {
  logger.info('Another backup finished while this one was starting; skipping.');
  return {
    status: 'skipped',
    supersededBy,
    message: 'Another backup finished while this one was starting; backup skipped.',
  };
}

export async function runBackup(options: BackupOptions = {}): Promise<BackupResult> {
  const startTime = Date.now();

  let context: ResolvedContext;
  try {
    context = await resolveContext(options);
    await prepareBackupRoot(
      context.backupRoot,
      context.settings.initializedBackupRoots,
      context.settings.lastBackup !== '',
    );
    // Gate before locking: never commit to a run (or leave a lock behind) when
    // there is provably not enough space.
    await assertDiskSpace(context.backupRoot, context.minFreeBytes);
  } catch (error) {
    // A run made redundant by a backup that finished meanwhile is skipped,
    // not failed: e.g. that backup may have just used the free space. (The
    // check cannot move ahead of setup: the lock lives in the backup root,
    // and setup is what refuses a root whose drive is missing.)
    const supersededBy = await backupRecordedAfter(options.skipIfBackedUpAfter);
    if (supersededBy !== null) return supersededResult(supersededBy);

    // Setup failures (no/invalid directory, low disk space) are recorded like
    // any other failed run. Lock contention below is not: it means another
    // run is in progress and will record its own result.
    await recordFailure(startTime, options.now ?? new Date(), error, !options.quiet);
    throw error;
  }
  const { settings, backupRoot, lockPath, activeDir } = context;

  try {
    await acquireLock(lockPath, context.staleLockMs);
  } catch (error) {
    // Contention is not a failure: the run holding the lock records its own
    // result. Anything else (e.g. a read-only drive) is.
    if (!(error instanceof LockError)) {
      await recordFailure(startTime, options.now ?? new Date(), error, !options.quiet);
    }
    throw error;
  }
  const heartbeat = startLockHeartbeat(lockPath, context.staleLockMs);
  /** Local directory the export goes to, when staging locally. */
  let localDir: string | null = null;

  try {
    const supersededBy = await backupRecordedAfter(options.skipIfBackedUpAfter);
    if (supersededBy !== null) return supersededResult(supersededBy);

    logger.info('Starting backup run...');
    if (!options.quiet) {
      void joplin.views.dialogs
        .showToast({ message: 'Backup started…', type: ToastType.Info })
        .catch(() => undefined);
    }

    const lastSnapshotName = await resolveLastSnapshot(
      backupRoot,
      settings.lastSnapshot || undefined,
    );
    const lastSnapshotDir = lastSnapshotName ? snapshotDirPath(backupRoot, lastSnapshotName) : null;
    const lastManifest = lastSnapshotDir ? await readManifest(lastSnapshotDir) : null;

    logger.info('Scanning vault for changes...');
    // Reading the inventory is many Data API calls; retry the same transient
    // errors (e.g. "database is locked" during sync) that the export retries.
    const inventory = await retryTransient(
      () => collectVaultInventory({ includeNoteTags: settings.onlyOnChange }),
      context.exportRetries,
    );
    const currentFingerprint = inventory.fingerprint;

    if (
      settings.onlyOnChange &&
      lastManifest &&
      fingerprintsEqual(currentFingerprint, lastManifest.changeFingerprint)
    ) {
      const nowIso = (options.now ?? new Date()).toISOString();
      await setLastBackup(nowIso);
      const durationMs = Date.now() - startTime;
      const duration = formatSeconds(durationMs);
      const changes: BackupChanges = {
        added: [],
        modified: [],
        deleted: [],
        unchanged: lastManifest?.files.length ?? 0,
      };
      const result: BackupResult = {
        status: 'skipped',
        durationMs,
        changes,
        message: 'No changes detected; backup skipped.',
      };
      void joplin.views.dialogs
        .showToast({ message: `Backup skipped (no changes) in ${duration}.`, type: ToastType.Info })
        .catch(() => undefined);
      await persistResult(`Skipped (no changes) at ${nowIso} — ${duration}`, {
        status: 'skipped',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: nowIso,
        durationMs,
        changes: recordChanges(changes),
        ...recordWarnings([]),
        message: result.message,
      });
      logger.info('No changes detected; backup skipped.');
      return result;
    }

    const stagingWarnings: BackupWarning[] = [];
    if (settings.stageLocally) {
      const staging = await prepareLocalStaging(
        await resolveLocalStagingRoot(options),
        backupRoot,
        path.basename(activeDir),
        lastManifest,
        context.minFreeBytes,
      );
      if ('dir' in staging) {
        localDir = staging.dir;
        logger.info(`Staging the export locally in "${localDir}".`);
      } else if ('sameDevice' in staging) {
        logger.info(
          'The backup directory is on the same disk as the plugin data; staging on the backup drive.',
        );
      } else {
        logger.warn(
          'Could not stage the export locally; staging on the backup drive.',
          staging.error,
        );
        stagingWarnings.push(localStagingWarning(staging.error));
      }
    }

    let folderIds: string[] = [];
    const exportTo = (dir: string): Promise<unknown> =>
      retryTransient(async () => {
        // Read the notebook list right before each attempt so a notebook created
        // or deleted during the inventory scan (or between retries) is not
        // missed or passed to the exporter after it is gone.
        folderIds = await getAllFolderIds();
        logger.info(`Exporting ${folderIds.length} notebook(s)...`);
        // Each attempt starts from an empty directory so a partial export from
        // a failed attempt can never end up in the snapshot.
        await safeRmDir(dir);
        await fs.mkdir(dir, { recursive: true });
        return joplin.commands.execute('exportFolders', folderIds, EXPORT_FORMAT, dir);
      }, context.exportRetries);

    let exportResult: unknown;
    if (localDir) {
      try {
        exportResult = await exportTo(localDir);
      } catch (error) {
        // The space check can only estimate the vault's size (and has nothing
        // to go on for a first backup), so the local disk may still fill up.
        // Fall back to staging on the backup drive rather than failing.
        logger.warn('Local export failed; staging on the backup drive instead.', error);
        await safeRmDir(localDir);
        localDir = null;
        stagingWarnings.push(localStagingWarning(error));
        exportResult = await exportTo(activeDir);
      }
    } else {
      exportResult = await exportTo(activeDir);
    }
    // The export was written here: the local staging directory, or the
    // staging directory on the backup drive.
    const exportDir = localDir ?? activeDir;
    const exportWarnings = extractExportWarnings(exportResult);
    if (exportWarnings.length > 0) {
      logger.warn(
        `Export reported ${exportWarnings.length} warning(s); the snapshot may be incomplete:`,
        exportWarnings,
      );
    }

    logger.info('Collecting exported files...');
    // Paths only: hashing reads every byte anyway and gives the sizes, so a
    // `stat` per file here would only add I/O on the backup drive.
    const activeFiles = await collectFilesRecursive(exportDir);
    if (activeFiles.length === 0) {
      throw new Error('Export produced no files; aborting backup.');
    }
    logger.info(`Exported ${activeFiles.length} file(s).`);

    // Joplin's RAW exporter silently skips items it cannot handle (still-encrypted
    // notes, resources of trashed notes, …) while still reporting success. Compare
    // what is on disk with what the database says exists and surface the
    // difference as warnings rather than aborting the run.
    const completenessWarnings = checkExportCompleteness({
      exportedFiles: activeFiles,
      inventory,
      folderIds,
    });
    if (completenessWarnings.length > 0) {
      logger.warn(
        'The export looks incomplete:',
        completenessWarnings.map((w) => w.message),
      );
    }
    const warnings: BackupWarning[] = [
      ...exportWarnings.map((message): BackupWarning => ({ kind: 'export', message })),
      ...completenessWarnings,
      ...stagingWarnings,
    ];

    const dedupOptions = {};
    let dedupResult: DedupResult;
    if (localDir) {
      logger.info('Writing new and changed files to the backup drive...');
      dedupResult = await stageFromLocal(
        localDir,
        activeDir,
        lastSnapshotDir,
        lastManifest,
        activeFiles,
        dedupOptions,
      );
    } else {
      logger.info('Deduplicating against previous snapshot...');
      dedupResult = await dedup(
        activeDir,
        lastSnapshotDir,
        lastManifest,
        activeFiles,
        dedupOptions,
      );
    }

    const exportedBytes = [...dedupResult.sizes.values()].reduce((sum, size) => sum + size, 0);
    logger.info(`Hashed ${activeFiles.length} file(s) (${formatBytes(exportedBytes)}).`);

    // Semantic change summary relative to the previous snapshot.
    const changes = computeChanges(lastManifest, activeFiles, dedupResult.hashes);

    const joplinVersion = await resolveJoplinVersion();
    const requestedName = generateSnapshotName(options.now ?? new Date());
    const snapshotName = await resolveUniqueSnapshotName(backupRoot, requestedName);
    const snapshotDir = snapshotDirPath(backupRoot, snapshotName);
    if (lastSnapshotName && snapshotName < lastSnapshotName) {
      logger.warn(
        `New snapshot ${snapshotName} sorts before the previous one (${lastSnapshotName}); ` +
          'the system clock may have gone backwards. Retention still keeps the new snapshot.',
      );
    }

    const meta: ManifestMeta = {
      snapshotId: snapshotName,
      joplinVersion,
      changeFingerprint: currentFingerprint,
      createdAt: Date.now(),
      deduplication: getDeduplicationMode(dedupResult),
    };
    const manifestEntries = activeFiles.map((filePath) => {
      const size = dedupResult.sizes.get(toManifestKey(filePath));
      // Every exported file was hashed, so this is a bug, not a runtime state.
      if (size === undefined) throw new Error(`No size was recorded for ${filePath}.`);
      return { path: filePath, size };
    });
    const manifest = await buildManifest(activeDir, meta, manifestEntries, dedupResult.hashes);
    await writeManifest(activeDir, manifest);

    // resolveUniqueSnapshotName chose a name nothing in the root has yet.
    await fs.rename(activeDir, snapshotDir);
    await atomicWriteFile(path.join(backupRoot, LATEST_FILENAME), snapshotName);

    await pruneSnapshots(backupRoot, settings.backupRetention, snapshotName, context.staleLockMs);

    // Persist the committed snapshot immediately so settings never lag behind
    // what is on disk, even if later result/message building throws.
    const finishedIso = (options.now ?? new Date()).toISOString();
    await setLastBackup(finishedIso);
    await setLastSnapshot(snapshotName);

    // Warn if hardlinks are unsupported — the user may not realize each snapshot
    // consumes full vault size when the filesystem falls back to copies.
    if (lastSnapshotDir && dedupResult.copied > 0 && dedupResult.hardlinked === 0) {
      warnings.push({
        kind: 'storage',
        message:
          'Hardlinks are not supported on this filesystem — unchanged files are kept as full copies, so each snapshot consumes the full vault size.',
      });
    }
    if (dedupResult.failed > 0) {
      warnings.push({
        kind: 'storage',
        message:
          `${dedupResult.failed} file(s) could not be deduplicated against the previous snapshot; ` +
          'full copies were kept instead (see the log for details).',
      });
    }
    const warningMessages = warnings.map((w) => w.message);

    const durationMs = Date.now() - startTime;
    const duration = formatSeconds(durationMs);
    const result: BackupResult = {
      status: 'success',
      snapshotName,
      snapshotDir,
      fileCount: manifest.fileCount,
      deduplication: manifest.deduplication,
      hardlinked: dedupResult.hardlinked,
      copied: dedupResult.copied,
      unchanged: dedupResult.unchanged,
      warnings: warningMessages,
      stagedLocally: localDir !== null,
      durationMs,
      changes,
      message:
        `Backup complete: ${manifest.fileCount} files in ${snapshotName} in ${duration}.` +
        (changes.added.length + changes.modified.length + changes.deleted.length > 0
          ? ` Changes: +${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}.`
          : ' No file changes.') +
        describeWarnings(warnings),
    };

    await persistResult(
      `${finishedIso} — success — ${duration} — ${manifest.fileCount} files — ` +
        `+${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}`,
      {
        status: 'success',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: finishedIso,
        durationMs,
        snapshotName,
        fileCount: manifest.fileCount,
        // Counts plus the first paths: the full lists of a first backup would
        // put every path in the vault into Joplin's settings database.
        changes: recordChanges(changes),
        ...recordWarnings(warningMessages),
        message: result.message,
      },
    );

    // Only announce completion once everything has been persisted.
    logger.info(
      `Backup complete in ${duration}: ${manifest.fileCount} files, ` +
        `${dedupResult.hardlinked} hardlinked, ${dedupResult.copied} copied, ${dedupResult.unchanged} unchanged` +
        (dedupResult.failed ? `, ${dedupResult.failed} failed` : '') +
        (warnings.length ? `, ${warnings.length} warning(s)` : ''),
    );
    void joplin.views.dialogs
      .showToast({
        message:
          `Backup complete in ${duration}: ${manifest.fileCount} files ` +
          `(+${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}).`,
        type: ToastType.Success,
        duration: 6000,
      })
      .catch(() => undefined);

    return result;
  } catch (error) {
    await recordFailure(startTime, options.now ?? new Date(), error, !options.quiet);
    throw error;
  } finally {
    heartbeat.stop();
    try {
      await releaseLock(lockPath);
    } catch (error) {
      logger.warn('Failed to release backup lock.', error);
    }
    try {
      await safeRmDir(activeDir);
    } catch (error) {
      logger.warn('Failed to clean the staging directory.', error);
    }
    if (localDir) {
      try {
        await safeRmDir(localDir);
      } catch (error) {
        logger.warn('Failed to clean the local staging directory.', error);
      }
    }
  }
}

/**
 * Clear local staging directories left behind by a crashed run. They live in
 * this profile's plugin data directory, and Joplin opens a profile in only
 * one instance, so at startup none of them can belong to a running backup.
 * Runs whatever the current setting, since staging may have been turned off
 * after the crash.
 */
async function recoverLocalStagingDirs(options: BackupOptions): Promise<void> {
  try {
    const stagingRoot = await resolveLocalStagingRoot(options);
    for (const name of await listStagingDirs(stagingRoot)) {
      await safeRmDir(path.join(stagingRoot, name));
    }
  } catch (error) {
    logger.warn('Local staging directory recovery skipped.', error);
  }
}

/**
 * Crash-recovery helper used by `onStart`: clear staging directories left
 * behind by a crashed run. It never creates the backup directory: a missing
 * one (e.g. an unplugged drive) simply has nothing to recover.
 *
 * A live backup holds the lock; when the lock is fresh nothing is removed, so
 * a second Joplin instance pointed at the same backup root cannot destroy a
 * run that is in progress.
 */
export async function recoverBackupDirs(options: BackupOptions = {}): Promise<void> {
  await recoverLocalStagingDirs(options);
  try {
    const settings = await getSettings();
    let backupRoot: string;
    try {
      backupRoot = configuredBackupRoot(settings, options);
    } catch (error) {
      // No usable directory configured: nothing to recover, and not worth a warning.
      logger.info(`Skipping backup directory recovery: ${(error as Error).message}`);
      return;
    }

    const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    if (await hasFreshLock(path.join(backupRoot, LOCK_FILENAME), staleLockMs)) {
      logger.info('Another backup appears to be running; leaving staging data in place.');
      return;
    }

    for (const name of await listStagingDirs(backupRoot)) {
      const dir = path.join(backupRoot, name);
      // Skip directories that were touched recently: they may belong to a run
      // that has only just started.
      const stat = await fs.stat(dir).catch(() => null);
      if (stat && Date.now() - stat.mtime.getTime() <= staleLockMs) continue;
      await safeRmDir(dir);
    }
  } catch (error) {
    logger.warn('Backup directory recovery skipped.', error);
  }
}
