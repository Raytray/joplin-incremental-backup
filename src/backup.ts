import fs from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import type { Dirent } from 'fs';
import joplin from 'api';
import { logger } from './logger';
import {
  acquireLock,
  assertDiskSpace,
  atomicWriteFile,
  collectEntries,
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
import { buildManifest, FINGERPRINT_DIGEST_KEYS, readManifest, writeManifest } from './manifest';
import type { ChangeFingerprint, DeduplicationMode, ManifestMeta } from './manifest';
import { dedup, getDeduplicationMode } from './dedup';
import type { DedupResult } from './dedup';
import { listSnapshots, pruneSnapshots } from './retention';
import {
  addInitializedBackupRoot,
  getSettings,
  isKnownBackupRoot,
  requireBackupPath,
  setLastBackup,
  setLastSnapshot,
  setLastBackupResult,
  setLastBackupResultJson,
} from './settings';
import { ToastType } from 'api/types';
import type { Settings } from './settings';

export const LOCK_FILENAME = '.backup.lock';
/**
 * Prefix of the per-run staging directories. The name is unique per run so two
 * concurrent runs can never write into the same directory.
 */
export const ACTIVE_DIR_PREFIX = '_joplin_active_';
export const LATEST_FILENAME = 'latest.txt';
/**
 * Marker written into every backup directory the plugin sets up. Its absence
 * from a directory that was set up before means the directory is not the one
 * we were writing to (most often: the backup drive is not mounted).
 */
export const ROOT_MARKER_FILENAME = '.joplin-incremental-backup';
export const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000;
export const DEFAULT_EXPORT_RETRIES = 3;
export const EXPORT_FORMAT = 'raw';

const PAGE_LIMIT = 100;
/** Parallel `tags/:id/notes` queries while reading note↔tag links. */
const TAG_QUERY_CONCURRENCY = 8;
const VERIFY_CONCURRENCY = 8;
const SNAPSHOT_COLLISION_SUFFIX_START = 2;
/** Floor for the lock heartbeat interval, regardless of the stale threshold. */
const MIN_HEARTBEAT_INTERVAL_MS = 60 * 1000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * What a warning affects:
 * - `export`: an item the exporter itself reported as skipped.
 * - `completeness`: items inferred missing from a database/export count mismatch.
 * - `storage`: the snapshot is complete, but deduplication was limited, so it
 *   uses more disk space than expected (e.g. no hardlink support).
 */
export type BackupWarningKind = 'export' | 'completeness' | 'storage';

export interface BackupWarning {
  kind: BackupWarningKind;
  /** Full text, shown in the warnings list. */
  message: string;
  /** Short form for the result message (e.g. "3 note(s)"); defaults to `message`. */
  summary?: string;
}

/**
 * Summary sentences for the result message, derived from the tagged warnings
 * so that every warning source is reflected without extra wiring.
 */
export function describeWarnings(warnings: readonly BackupWarning[]): string {
  const ofKind = (kind: BackupWarningKind) => warnings.filter((w) => w.kind === kind);
  const exported = ofKind('export');
  const completeness = ofKind('completeness');
  const storage = ofKind('storage');

  const parts: string[] = [];
  if (exported.length > 0) {
    parts.push(`${exported.length} item(s) were skipped by the export.`);
  }
  if (completeness.length > 0) {
    parts.push(
      `Missing from the export: ${completeness.map((w) => w.summary ?? w.message).join(', ')}.`,
    );
  }
  if (exported.length > 0 || completeness.length > 0) {
    parts.push('The snapshot may be incomplete (see warnings).');
  }
  if (storage.length > 0) {
    parts.push(
      `Deduplication was limited, so this snapshot uses more disk space than expected ` +
        `(${storage.length} warning(s), see warnings).`,
    );
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
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

export interface BackupChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
}

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

export interface VaultInventoryOptions {
  /**
   * Read note↔tag links (one query per tag) into `noteTagDigest`. Only the
   * skip-on-unchanged check needs them, so callers that will export anyway
   * can leave them out.
   */
  includeNoteTags?: boolean;
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
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs?: number;
  /** Human-readable duration, e.g. "1.2s". */
  duration?: string;
  /** Semantic change summary relative to the previous snapshot. */
  changes?: BackupChanges;
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

/**
 * The backup root for this run: the explicit override (tests), otherwise the
 * configured directory. Throws a user-facing error when the directory is unset
 * or not absolute, so a bad setting can never resolve to a path in the
 * working directory. This is the only place that decision is made.
 */
function configuredBackupRoot(settings: Settings, options: BackupOptions): string {
  if (options.backupRoot !== undefined) return options.backupRoot;
  return resolveBackupRoot(requireBackupPath(settings), options.profileName);
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

const FINGERPRINT_KEYS: ReadonlyArray<keyof ChangeFingerprint> = [
  'maxNoteUpdatedTime',
  'noteCount',
  'maxResourceUpdatedTime',
  ...FINGERPRINT_DIGEST_KEYS,
];

/**
 * True only when every fingerprint field matches. A field missing on one side
 * (a manifest written by an older version) counts as a difference.
 */
export function fingerprintsEqual(
  a: ChangeFingerprint | null | undefined,
  b: ChangeFingerprint | null | undefined,
): boolean {
  if (!a || !b) return false;
  return FINGERPRINT_KEYS.every((key) => a[key] !== undefined && a[key] === b[key]);
}

async function paginate(
  resource: string | string[],
  fields: string[],
  onItem: (item: Record<string, unknown>) => void,
): Promise<void> {
  const dataPath = Array.isArray(resource) ? resource : [resource];
  let page = 1;
  for (;;) {
    const response = await joplin.data.get(dataPath, { fields, page, limit: PAGE_LIMIT });
    const items: Array<Record<string, unknown>> = Array.isArray(response?.items)
      ? response.items
      : [];

    if (page === 1) {
      logger.debug(
        `joplin.data.get("${dataPath.join('/')}") returned page size ${items.length} (requested ${PAGE_LIMIT})`,
      );
    }

    for (const item of items) onItem(item);

    if (!response?.has_more || items.length === 0) break;
    page += 1;
  }
}

export async function getChangeFingerprint(
  options?: VaultInventoryOptions,
): Promise<ChangeFingerprint> {
  return (await collectVaultInventory(options)).fingerprint;
}

/**
 * SHA-256 over `key:value` pairs in sorted order, so the digest does not depend
 * on the order the API returned them in. Pairs are fed to the hash one at a
 * time rather than joined into a single string first.
 */
export function digestPairs(pairs: Array<readonly [string, string]>): string {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  pairs.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
  const hash = createHash('sha256');
  for (const [key, value] of pairs) hash.update(`${key}:${value}\n`);
  return hash.digest('hex');
}

/**
 * Read every `id:updated_time` pair of one item type, tracking the newest
 * `updated_time` along the way.
 */
async function readItemTimes(
  resource: string,
  onId?: (id: string) => void,
): Promise<{ pairs: Array<[string, string]>; maxUpdatedTime: number }> {
  const pairs: Array<[string, string]> = [];
  let maxUpdatedTime = 0;
  await paginate(resource, ['id', 'updated_time'], (item) => {
    const updated = Number(item.updated_time) || 0;
    if (updated > maxUpdatedTime) maxUpdatedTime = updated;
    if (typeof item.id !== 'string') return;
    pairs.push([item.id, String(updated)]);
    onId?.(item.id);
  });
  return { pairs, maxUpdatedTime };
}

/**
 * Read the vault inventory: notes, resources, notebooks and tags, plus (when
 * requested) the note↔tag links.
 *
 * Each item type is reduced to a digest of its sorted `id:updated_time`
 * pairs, so any added, removed or changed item alters the fingerprint, even
 * one that arrives through sync with an older timestamp than the newest
 * local edit.
 *
 * Note↔tag links have no endpoint of their own, so they are read per tag
 * (`tags/:id/notes`), with bounded concurrency.
 */
export async function collectVaultInventory(
  options: VaultInventoryOptions = {},
): Promise<VaultInventory> {
  const { includeNoteTags = true } = options;
  const noteIds: string[] = [];

  const notes = await readItemTimes('notes', (id) => noteIds.push(id));
  const resources = await readItemTimes('resources');
  const folders = await readItemTimes('folders');
  const tags = await readItemTimes('tags');

  let noteTagDigest: string | undefined;
  if (includeNoteTags) {
    const tagIds = tags.pairs.map(([id]) => id);
    const perTag = await mapWithConcurrency(tagIds, TAG_QUERY_CONCURRENCY, async (tagId) => {
      const links: Array<[string, string]> = [];
      await paginate(['tags', tagId, 'notes'], ['id'], (note) => {
        if (typeof note.id === 'string') links.push([tagId, note.id]);
      });
      return links;
    });
    noteTagDigest = digestPairs(perTag.flat());
  }

  return {
    fingerprint: {
      maxNoteUpdatedTime: notes.maxUpdatedTime,
      noteCount: notes.pairs.length,
      maxResourceUpdatedTime: resources.maxUpdatedTime,
      noteDigest: digestPairs(notes.pairs),
      resourceDigest: digestPairs(resources.pairs),
      folderDigest: digestPairs(folders.pairs),
      tagDigest: digestPairs(tags.pairs),
      noteTagDigest,
    },
    noteIds,
    resourceCount: resources.pairs.length,
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
export function checkExportCompleteness(input: CompletenessCheckInput): BackupWarning[] {
  const { exportedFiles, inventory, folderIds } = input;
  const exported = new Set(exportedFiles);
  const warnings: BackupWarning[] = [];

  const missingNotes = inventory.noteIds.filter((id) => !exported.has(`${id}.md`));
  if (missingNotes.length > 0) {
    warnings.push({
      kind: 'completeness',
      message:
        `${missingNotes.length} note(s) are missing from the export ` +
        `(e.g. ${missingNotes.slice(0, 3).join(', ')}); they may still be encrypted.`,
      summary: `${missingNotes.length} note(s)`,
    });
  }

  const missingFolders = folderIds.filter((id) => !exported.has(`${id}.md`));
  if (missingFolders.length > 0) {
    warnings.push({
      kind: 'completeness',
      message:
        `${missingFolders.length} notebook(s) are missing from the export ` +
        `(e.g. ${missingFolders.slice(0, 3).join(', ')}).`,
      summary: `${missingFolders.length} notebook(s)`,
    });
  }

  const resourcePrefix = `${RESOURCES_DIR_NAME}/`;
  const exportedResources = exportedFiles.filter((file) => file.startsWith(resourcePrefix)).length;
  if (exportedResources < inventory.resourceCount) {
    warnings.push({
      kind: 'completeness',
      message:
        `Only ${exportedResources} of ${inventory.resourceCount} resource(s) are in the export; ` +
        'some attachments may be missing.',
      summary: `${inventory.resourceCount - exportedResources} of ${inventory.resourceCount} resource(s)`,
    });
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
  const backupRoot = configuredBackupRoot(settings, options);

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
 * it. Persistence errors are swallowed: they must never mask the original.
 */
async function recordFailure(startTime: number, finishedAt: Date, error: unknown): Promise<void> {
  const durationMs = Date.now() - startTime;
  const duration = `${(durationMs / 1000).toFixed(1)}s`;
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Backup failed.', error);
  void joplin.views.dialogs
    .showToast({
      message: `Backup failed after ${duration}.`,
      type: ToastType.Error,
      duration: 6000,
    })
    .catch(() => undefined);
  const finishedIso = finishedAt.toISOString();
  try {
    const record = JSON.stringify({
      status: 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: finishedIso,
      durationMs,
      error: message,
    });
    await setLastBackupResult(`${finishedIso} — failed — ${duration} — ${message}`);
    await setLastBackupResultJson(record);
  } catch {
    // Persistence must never mask the original error.
  }
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
    // Setup failures (no/invalid directory, low disk space) are recorded like
    // any other failed run. Lock contention below is not: it means another
    // run is in progress and will record its own result.
    await recordFailure(startTime, options.now ?? new Date(), error);
    throw error;
  }
  const { settings, backupRoot, lockPath, activeDir } = context;

  await acquireLock(lockPath, context.staleLockMs);
  const heartbeat = startLockHeartbeat(lockPath, context.staleLockMs);

  try {
    logger.info('Starting backup run...');
    void joplin.views.dialogs
      .showToast({ message: 'Backup started…', type: ToastType.Info })
      .catch(() => undefined);

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
      const duration = `${(durationMs / 1000).toFixed(1)}s`;
      const changes: BackupChanges = {
        added: [],
        modified: [],
        deleted: [],
        unchanged: lastManifest?.files.length ?? 0,
      };
      const result: BackupResult = {
        status: 'skipped',
        durationMs,
        duration,
        changes,
        message: 'No changes detected; backup skipped.',
      };
      void joplin.views.dialogs
        .showToast({ message: `Backup skipped (no changes) in ${duration}.`, type: ToastType.Info })
        .catch(() => undefined);
      const record = JSON.stringify({
        status: 'skipped',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: nowIso,
        durationMs,
        changes,
        warnings: [],
        message: result.message,
      });
      await setLastBackupResult(`Skipped (no changes) at ${nowIso} — ${duration}`);
      await setLastBackupResultJson(record);
      logger.info('No changes detected; backup skipped.');
      return result;
    }

    let folderIds: string[] = [];
    const exportResult = await retryTransient(async () => {
      // Read the notebook list right before each attempt so a notebook created
      // or deleted during the inventory scan (or between retries) is not
      // missed or passed to the exporter after it is gone.
      folderIds = await getAllFolderIds();
      logger.info(`Exporting ${folderIds.length} notebook(s)...`);
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

    logger.info('Collecting exported files...');
    const activeEntries = await collectEntries(activeDir, activeDir);
    if (activeEntries.length === 0) {
      throw new Error('Export produced no files; aborting backup.');
    }
    const activeFiles = activeEntries.map((e) => e.path);
    const fileSizes = new Map<string, number>(
      activeEntries.map((e) => [toManifestKey(e.path), e.size]),
    );
    logger.info(
      `Exported ${activeFiles.length} file(s) (${formatBytes(activeEntries.reduce((s, e) => s + e.size, 0))}).`,
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
      logger.warn(
        'The export looks incomplete:',
        completenessWarnings.map((w) => w.message),
      );
    }
    const warnings: BackupWarning[] = [
      ...exportWarnings.map((message): BackupWarning => ({ kind: 'export', message })),
      ...completenessWarnings,
    ];

    logger.info('Deduplicating against previous snapshot...');
    const dedupResult: DedupResult = await dedup(
      activeDir,
      lastSnapshotDir,
      lastManifest,
      activeFiles,
      { computeHash: context.computeHash, fileSizes },
    );

    // Semantic change summary relative to the previous snapshot.
    const previousFiles = lastManifest?.files ?? [];
    const previousByPath = new Map(previousFiles.map((f) => [toManifestKey(f.path), f.sha256]));
    const currentPaths = activeFiles.map((f) => toManifestKey(f));
    const previousPathSet = new Set(previousByPath.keys());
    const currentPathSet = new Set(currentPaths);
    const added = [...currentPathSet].filter((p) => !previousPathSet.has(p)).sort();
    const deleted = [...previousPathSet].filter((p) => !currentPathSet.has(p)).sort();
    const modified: string[] = [];
    let unchangedFiles = 0;
    for (const p of currentPathSet) {
      if (!previousPathSet.has(p)) continue;
      const prevHash = previousByPath.get(p);
      const currHash = dedupResult.hashes.get(p);
      if (prevHash && currHash && prevHash !== currHash) {
        modified.push(p);
      } else {
        unchangedFiles += 1;
      }
    }
    modified.sort();
    const changes: BackupChanges = { added, modified, deleted, unchanged: unchangedFiles };

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
    const elapsed = (durationMs / 1000).toFixed(1);
    const duration = `${elapsed}s`;
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
      durationMs,
      duration,
      changes,
      message:
        `Backup complete: ${manifest.fileCount} files in ${snapshotName} in ${duration}.` +
        (changes.added.length + changes.modified.length + changes.deleted.length > 0
          ? ` Changes: +${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}.`
          : ' No file changes.') +
        describeWarnings(warnings),
    };

    const record = JSON.stringify({
      status: 'success',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: finishedIso,
      durationMs,
      snapshotName,
      fileCount: manifest.fileCount,
      changes,
      warnings: warningMessages,
      message: result.message,
    });
    await setLastBackupResult(
      `${finishedIso} — success — ${duration} — ${manifest.fileCount} files — ` +
        `+${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}`,
    );
    await setLastBackupResultJson(record);

    // Only announce completion once everything has been persisted.
    logger.info(
      `Backup complete in ${elapsed}s: ${manifest.fileCount} files, ` +
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
    await recordFailure(startTime, options.now ?? new Date(), error);
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
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export async function verifyBackup(options: BackupOptions = {}): Promise<VerifyResult> {
  const settings = await getSettings();
  const backupRoot = configuredBackupRoot(settings, options);
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
 * Crash-recovery helper used by `onStart`: clear staging directories left
 * behind by a crashed run. It never creates the backup directory: a missing
 * one (e.g. an unplugged drive) simply has nothing to recover.
 *
 * A live backup holds the lock; when the lock is fresh nothing is removed, so
 * a second Joplin instance pointed at the same backup root cannot destroy a
 * run that is in progress.
 */
export async function recoverBackupDirs(options: BackupOptions = {}): Promise<void> {
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
