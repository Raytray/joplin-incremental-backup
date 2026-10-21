import fs from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';
import joplin from 'api';
import { logger } from './logger';
import {
  acquireLock,
  assertDiskSpace,
  atomicWriteFile,
  collectEntries,
  collectFilesRecursive,
  computeFileSha256,
  ensureBackupRoot,
  errorCode,
  hasFreshLock,
  mapWithConcurrency,
  releaseLock,
  safeRmDir,
  toManifestKey,
  touchLock,
} from './platform';
import { buildManifest, readManifest, writeManifest } from './manifest';
import type { ChangeFingerprint, DeduplicationMode, ManifestMeta } from './manifest';
import { dedup, getDeduplicationMode } from './dedup';
import type { DedupResult } from './dedup';
import { listSnapshots, pruneSnapshots } from './retention';
import { getSettings, setLastBackup, setLastSnapshot, SETTING_KEYS } from './settings';
import type { Settings } from './settings';

export const LOCK_FILENAME = '.backup.lock';
/**
 * Prefix of the per-run staging directories. The name is unique per run so two
 * concurrent runs can never write into the same directory.
 */
export const ACTIVE_DIR_PREFIX = '_joplin_active_';
export const LATEST_FILENAME = 'latest.txt';
export const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000;
export const DEFAULT_EXPORT_RETRIES = 3;
export const EXPORT_FORMAT = 'raw';

const PAGE_LIMIT = 1000;
const VERIFY_CONCURRENCY = 8;
const SNAPSHOT_COLLISION_SUFFIX_START = 2;
/** Floor for the lock heartbeat interval, regardless of the stale threshold. */
const MIN_HEARTBEAT_INTERVAL_MS = 60 * 1000;

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

/** Directory the RAW exporter writes attachments into. */
export const RESOURCES_DIR_NAME = 'resources';

/**
 * What the database says the vault contains. Read in a single pass so the
 * completeness check costs no extra queries.
 */
export interface VaultInventory {
  /** Fingerprint used to detect "nothing changed since the last snapshot". */
  fingerprint: ChangeFingerprint;
  /** Ids of every note in the database. */
  noteIds: string[];
  /** Number of resources in the database. */
  resourceCount: number;
}

export interface CompletenessCheckInput {
  /** Relative paths of every file the export produced. */
  exportedFiles: readonly string[];
  /** Inventory read from the database. */
  inventory: VaultInventory;
  /** Folder ids that were handed to the exporter. */
  folderIds: readonly string[];
}

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
   * Injectable SHA-256 implementation (defaults to the streaming one). The
   * optional `sizeHint` lets the implementation pick a chunk size without an
   * extra `stat` call.
   */
  computeHash?: (filePath: string, sizeHint?: number) => Promise<string>;
}

export interface VerifyResult {
  ok: boolean;
  snapshotName: string | null;
  snapshotDir: string | null;
  total: number;
  matched: number;
  mismatches: string[];
  message: string;
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
  computeHash: (filePath: string, sizeHint?: number) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function resolveBackupRoot(backupPath: string, profileName?: string): string {
  const base = backupPath.replace(/[/\\]+$/, '');
  if (!profileName || !profileName.trim()) return base;
  return path.join(base, profileName.trim());
}

export function activeDirPath(backupRoot: string, runName?: string): string {
  return path.join(backupRoot, runName ?? createStagingDirName());
}

/**
 * Name of the staging directory used by one backup run. It embeds the start
 * time, the process id and a random suffix so that two runs — even ones that
 * overlap because a lock was wrongly stolen — never share a directory.
 */
export function createStagingDirName(now: Date = new Date()): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${ACTIVE_DIR_PREFIX}${generateSnapshotName(now)}_${process.pid}_${suffix}`;
}

/** Names of the staging directories currently present under `backupRoot`. */
export async function listStagingDirs(backupRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(backupRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(ACTIVE_DIR_PREFIX))
    .map((entry) => entry.name);
}

export function snapshotDirPath(backupRoot: string, snapshotName: string): string {
  return path.join(backupRoot, snapshotName);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYYMMDDTHHMMSS` in UTC. */
export function generateSnapshotName(date: Date = new Date()): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

async function snapshotNameExists(backupRoot: string, snapshotName: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(backupRoot, snapshotName))).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Resolve a unique snapshot name, appending `-2`, `-3`, … when a snapshot of the
 * same second already exists so a rapid second run never clobbers the first.
 */
export async function resolveUniqueSnapshotName(
  backupRoot: string,
  baseName: string,
): Promise<string> {
  if (!(await snapshotNameExists(backupRoot, baseName))) return baseName;

  let counter = SNAPSHOT_COLLISION_SUFFIX_START;
  while (await snapshotNameExists(backupRoot, `${baseName}-${counter}`)) {
    counter += 1;
  }
  return `${baseName}-${counter}`;
}

export async function readLatestSnapshotName(backupRoot: string): Promise<string | null> {
  try {
    const name = (await fs.readFile(path.join(backupRoot, LATEST_FILENAME), 'utf8')).trim();
    return name || null;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Determine the previous snapshot from (in order) the explicit preference, the
 * stored `lastSnapshot` setting via `latest.txt`, or the newest directory.
 */
export async function resolveLastSnapshot(
  backupRoot: string,
  preferredSnapshotName?: string,
): Promise<string | null> {
  if (preferredSnapshotName) {
    if (await snapshotNameExists(backupRoot, preferredSnapshotName)) {
      return preferredSnapshotName;
    }
  }

  const latest = await readLatestSnapshotName(backupRoot);
  if (latest && (await snapshotNameExists(backupRoot, latest))) return latest;

  const snapshots = await listSnapshots(backupRoot);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

export function fingerprintsEqual(
  a: ChangeFingerprint | null | undefined,
  b: ChangeFingerprint | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.maxNoteUpdatedTime === b.maxNoteUpdatedTime &&
    a.noteCount === b.noteCount &&
    a.maxResourceUpdatedTime === b.maxResourceUpdatedTime
  );
}

async function paginate(
  resource: string,
  fields: string[],
  onItem: (item: Record<string, unknown>) => void,
): Promise<void> {
  let page = 1;
  for (;;) {
    const response = await joplin.data.get([resource], { fields, page, limit: PAGE_LIMIT });
    const items: Array<Record<string, unknown>> = Array.isArray(response?.items)
      ? response.items
      : [];

    if (page === 1) {
      logger.debug(
        `joplin.data.get("${resource}") returned page size ${items.length} (requested ${PAGE_LIMIT})`,
      );
    }

    for (const item of items) onItem(item);

    if (!response?.has_more || items.length === 0) break;
    page += 1;
  }
}

export async function getChangeFingerprint(): Promise<ChangeFingerprint> {
  return (await collectVaultInventory()).fingerprint;
}

/**
 * Read the vault inventory in a single pass over notes and resources.
 *
 * The notes query already asks for `id`, so collecting the ids costs nothing
 * extra and the completeness check can reuse them.
 */
export async function collectVaultInventory(): Promise<VaultInventory> {
  let maxNoteUpdatedTime = 0;
  let noteCount = 0;
  let maxResourceUpdatedTime = 0;
  let resourceCount = 0;
  const noteIds: string[] = [];

  await paginate('notes', ['id', 'updated_time'], (note) => {
    noteCount += 1;
    if (typeof note.id === 'string') noteIds.push(note.id);
    const updated = Number(note.updated_time) || 0;
    if (updated > maxNoteUpdatedTime) maxNoteUpdatedTime = updated;
  });

  await paginate('resources', ['updated_time'], (resource) => {
    resourceCount += 1;
    const updated = Number(resource.updated_time) || 0;
    if (updated > maxResourceUpdatedTime) maxResourceUpdatedTime = updated;
  });

  return {
    fingerprint: { maxNoteUpdatedTime, noteCount, maxResourceUpdatedTime },
    noteIds,
    resourceCount,
  };
}

export async function getAllFolderIds(): Promise<string[]> {
  const ids: string[] = [];
  await paginate('folders', ['id'], (folder) => {
    if (typeof folder.id === 'string') ids.push(folder.id);
  });
  return ids;
}

/**
 * Compare the exported tree with the database inventory.
 *
 * Joplin's RAW exporter silently skips items it cannot handle — still-encrypted
 * notes, resources of trashed notes — and still reports success, so the only
 * way to notice a partial export is to compare what is on disk with what the
 * database says exists.
 *
 * The result is a list of warnings, never an error: encrypted or trashed items
 * legitimately produce false positives, and refusing to back up at all would be
 * worse than an incomplete snapshot.
 *
 * Tags and note-tags are not checked — verifying them needs extra scans that
 * cost more than they are worth.
 */
export function checkExportCompleteness(input: CompletenessCheckInput): string[] {
  const { exportedFiles, inventory, folderIds } = input;
  const exported = new Set(exportedFiles);
  const warnings: string[] = [];

  const missingNotes = inventory.noteIds.filter((id) => !exported.has(`${id}.md`));
  if (missingNotes.length > 0) {
    warnings.push(
      `${missingNotes.length} note(s) are missing from the export ` +
        `(e.g. ${missingNotes.slice(0, 3).join(', ')}); they may still be encrypted.`,
    );
  }

  const missingFolders = folderIds.filter((id) => !exported.has(`${id}.md`));
  if (missingFolders.length > 0) {
    warnings.push(
      `${missingFolders.length} notebook(s) are missing from the export ` +
        `(e.g. ${missingFolders.slice(0, 3).join(', ')}).`,
    );
  }

  const resourcePrefix = `${RESOURCES_DIR_NAME}/`;
  const exportedResources = exportedFiles.filter((file) => file.startsWith(resourcePrefix)).length;
  if (exportedResources < inventory.resourceCount) {
    warnings.push(
      `Only ${exportedResources} of ${inventory.resourceCount} resource(s) are in the export; ` +
        'some attachments may be missing.',
    );
  }

  return warnings;
}

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

export async function collectActiveFiles(activeDir: string): Promise<string[]> {
  return collectFilesRecursive(activeDir, activeDir);
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

/**
 * Refresh the lock while a backup runs. A large vault can take longer than the
 * stale threshold to export, and a lock that is still being renewed must never
 * be mistaken for an abandoned one.
 */
function startLockHeartbeat(lockPath: string, staleLockMs: number): { stop: () => void } {
  const intervalMs = Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(staleLockMs / 3));
  const timer = setInterval(() => {
    void touchLock(lockPath).catch((error) => {
      logger.warn('Failed to refresh the backup lock.', error);
    });
  }, intervalMs);

  // The heartbeat must not keep the plugin's event loop alive on its own.
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === 'function') unref.call(timer);

  return { stop: () => clearInterval(timer) };
}

async function resolveContext(options: BackupOptions): Promise<ResolvedContext> {
  const settings = await getSettings();
  const backupRoot =
    options.backupRoot ?? resolveBackupRoot(settings.backupPath, options.profileName);

  return {
    settings,
    backupRoot,
    lockPath: path.join(backupRoot, LOCK_FILENAME),
    activeDir: activeDirPath(backupRoot),
    staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
    exportRetries: options.exportRetries ?? DEFAULT_EXPORT_RETRIES,
    minFreeBytes: options.minFreeBytes,
    computeHash: options.computeHash ?? computeFileSha256,
  };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export async function runBackup(options: BackupOptions = {}): Promise<BackupResult> {
  const context = await resolveContext(options);
  const { settings, backupRoot, lockPath, activeDir } = context;

  await ensureBackupRoot(backupRoot);
  // Gate before locking: never commit to a run (or leave a lock behind) when
  // there is provably not enough space.
  await assertDiskSpace(backupRoot, context.minFreeBytes);

  await acquireLock(lockPath, context.staleLockMs);
  const heartbeat = startLockHeartbeat(lockPath, context.staleLockMs);

  try {
    const lastSnapshotName = await resolveLastSnapshot(
      backupRoot,
      settings.lastSnapshot || undefined,
    );
    const lastSnapshotDir = lastSnapshotName ? snapshotDirPath(backupRoot, lastSnapshotName) : null;
    const lastManifest = lastSnapshotDir ? await readManifest(lastSnapshotDir) : null;

    const inventory = await collectVaultInventory();
    const currentFingerprint = inventory.fingerprint;

    if (
      settings.onlyOnChange &&
      lastManifest &&
      fingerprintsEqual(currentFingerprint, lastManifest.changeFingerprint)
    ) {
      const nowIso = (options.now ?? new Date()).toISOString();
      await setLastBackup(nowIso);
      return { status: 'skipped', message: 'No changes detected; backup skipped.' };
    }

    const folderIds = await getAllFolderIds();
    const exportResult = await retryTransient(async () => {
      // Each attempt starts from an empty directory so a partial export from
      // a failed attempt can never end up in the snapshot.
      await safeRmDir(activeDir);
      await fs.mkdir(activeDir, { recursive: true });
      return joplin.commands.execute('exportFolders', folderIds, EXPORT_FORMAT, activeDir);
    }, context.exportRetries);
    const exportWarnings = extractExportWarnings(exportResult);
    if (exportWarnings.length > 0) {
      logger.warn(
        `Export reported ${exportWarnings.length} warning(s); the snapshot may be incomplete:`,
        exportWarnings,
      );
    }

    const activeEntries = await collectEntries(activeDir, activeDir);
    if (activeEntries.length === 0) {
      throw new Error('Export produced no files; aborting backup.');
    }
    const activeFiles = activeEntries.map((e) => e.path);
    const fileSizes = new Map<string, number>(
      activeEntries.map((e) => [toManifestKey(e.path), e.size]),
    );

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
      logger.warn('The export looks incomplete:', completenessWarnings);
    }
    const warnings = [...exportWarnings, ...completenessWarnings];

    const dedupResult: DedupResult = await dedup(
      activeDir,
      lastSnapshotDir,
      lastManifest,
      activeFiles,
      { computeHash: context.computeHash, fileSizes },
    );

    const joplinVersion = await resolveJoplinVersion();
    const requestedName = generateSnapshotName(options.now ?? new Date());
    const snapshotName = await resolveUniqueSnapshotName(backupRoot, requestedName);
    const snapshotDir = snapshotDirPath(backupRoot, snapshotName);

    const meta: ManifestMeta = {
      snapshotId: snapshotName,
      joplinVersion,
      changeFingerprint: currentFingerprint,
      createdAt: Date.now(),
      deduplication: getDeduplicationMode(dedupResult),
    };
    const manifest = await buildManifest(activeDir, meta, activeEntries, dedupResult.hashes);
    await writeManifest(activeDir, manifest);

    await safeRmDir(snapshotDir);
    await fs.rename(activeDir, snapshotDir);
    await atomicWriteFile(path.join(backupRoot, LATEST_FILENAME), snapshotName);

    await pruneSnapshots(backupRoot, Math.max(1, settings.backupRetention));

    const nowIso = (options.now ?? new Date()).toISOString();
    await setLastBackup(nowIso);
    await setLastSnapshot(snapshotName);

    // Warn if hardlinks are unsupported — the user may not realize each snapshot
    // consumes full vault size when the filesystem falls back to copies.
    if (lastSnapshotDir && dedupResult.copied > 0 && dedupResult.hardlinked === 0) {
      warnings.push(
        'Hardlinks are not supported on this filesystem — every file was copied, so each snapshot consumes the full vault size.',
      );
    }

    return {
      status: 'success',
      snapshotName,
      snapshotDir,
      fileCount: manifest.fileCount,
      deduplication: manifest.deduplication,
      hardlinked: dedupResult.hardlinked,
      copied: dedupResult.copied,
      unchanged: dedupResult.unchanged,
      warnings,
      message:
        `Backup complete: ${manifest.fileCount} files in ${snapshotName}.` +
        (warnings.length > 0
          ? ` ${warnings.length} item(s) were skipped by the export (see log); the snapshot may be incomplete.`
          : ''),
    };
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
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export async function verifyBackup(options: BackupOptions = {}): Promise<VerifyResult> {
  const settings = await getSettings();
  const backupRoot =
    options.backupRoot ?? resolveBackupRoot(settings.backupPath, options.profileName);
  const computeHash = options.computeHash ?? computeFileSha256;

  const snapshotName = await resolveLastSnapshot(backupRoot, settings.lastSnapshot || undefined);

  if (!snapshotName) {
    return {
      ok: false,
      snapshotName: null,
      snapshotDir: null,
      total: 0,
      matched: 0,
      mismatches: [],
      message: 'No snapshot found to verify.',
    };
  }

  const snapshotDir = snapshotDirPath(backupRoot, snapshotName);
  const manifest = await readManifest(snapshotDir);
  if (!manifest) {
    return {
      ok: false,
      snapshotName,
      snapshotDir,
      total: 0,
      matched: 0,
      mismatches: [],
      message: `No valid manifest found in ${snapshotName}.`,
    };
  }

  const results = await mapWithConcurrency(manifest.files, VERIFY_CONCURRENCY, async (file) => {
    const filePath = path.join(snapshotDir, file.path);
    try {
      const stat = await fs.stat(filePath);
      // Size mismatch is conclusive — no need to hash.
      if (stat.size !== file.size) {
        return { path: file.path, ok: false };
      }
      // Size matches; pass the known size as the hint so the hasher can skip its stat.
      const actual = await computeHash(filePath, file.size);
      return actual === file.sha256
        ? { path: file.path, ok: true }
        : { path: file.path, ok: false };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { path: file.path, ok: false };
      throw error;
    }
  });

  const mismatches = results.filter((result) => !result.ok).map((result) => result.path);
  const total = manifest.files.length;
  const matched = total - mismatches.length;
  const ok = mismatches.length === 0 && matched === total && total > 0;

  return {
    ok,
    snapshotName,
    snapshotDir,
    total,
    matched,
    mismatches,
    message: ok
      ? `Verified ${total} files in ${snapshotName}.`
      : `Verification failed in ${snapshotName}: ${mismatches.length} of ${total} files mismatch.`,
  };
}

/**
 * Crash-recovery helper used by `onStart`: recreate the root and clear staging
 * directories left behind by a crashed run.
 *
 * A live backup holds the lock; when the lock is fresh nothing is removed, so
 * a second Joplin instance pointed at the same backup root cannot destroy a
 * run that is in progress.
 */
export async function recoverBackupDirs(options: BackupOptions = {}): Promise<void> {
  try {
    const settings = await getSettings();
    const backupRoot =
      options.backupRoot ?? resolveBackupRoot(settings.backupPath, options.profileName);
    await ensureBackupRoot(backupRoot);

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

export { SETTING_KEYS };
export type { Settings };
