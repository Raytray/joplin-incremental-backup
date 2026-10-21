import fs from 'fs/promises';
import path from 'path';
import joplin from 'api';
import { logger } from './logger';
import {
  acquireLock,
  atomicWriteFile,
  checkDiskSpace,
  collectFilesRecursive,
  computeFileSha256,
  ensureBackupRoot,
  mapWithConcurrency,
  releaseLock,
  safeRmDir,
} from './platform';
import { buildManifest, readManifest, writeManifest } from './manifest';
import type { ChangeFingerprint, DeduplicationMode, ManifestMeta } from './manifest';
import { dedup, getDeduplicationMode } from './dedup';
import type { DedupResult } from './dedup';
import { listSnapshots, pruneSnapshots } from './retention';
import { getSettings, setLastBackup, setLastSnapshot, SETTING_KEYS } from './settings';
import type { Settings } from './settings';

export const LOCK_FILENAME = '.backup.lock';
export const ACTIVE_DIR_NAME = '_joplin_active_';
export const LATEST_FILENAME = 'latest.txt';
export const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000;
export const DEFAULT_EXPORT_RETRIES = 3;
export const EXPORT_FORMAT = 'raw';

const PAGE_LIMIT = 100;
const VERIFY_CONCURRENCY = 8;
const SNAPSHOT_COLLISION_SUFFIX_START = 2;

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
  /** Injectable clock for deterministic snapshot names. */
  now?: Date;
  /** Injectable SHA-256 implementation (defaults to the streaming one). */
  computeHash?: (filePath: string) => Promise<string>;
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
  computeHash: (filePath: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

export function resolveBackupRoot(backupPath: string, profileName?: string): string {
  const base = backupPath.replace(/[/\\]+$/, '');
  if (!profileName || !profileName.trim()) return base;
  return path.join(base, profileName.trim());
}

export function activeDirPath(backupRoot: string): string {
  return path.join(backupRoot, ACTIVE_DIR_NAME);
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

    for (const item of items) onItem(item);

    if (!response?.has_more || items.length === 0) break;
    page += 1;
  }
}

export async function getChangeFingerprint(): Promise<ChangeFingerprint> {
  let maxNoteUpdatedTime = 0;
  let noteCount = 0;
  let maxResourceUpdatedTime = 0;

  await paginate('notes', ['id', 'updated_time'], (note) => {
    noteCount += 1;
    const updated = Number(note.updated_time) || 0;
    if (updated > maxNoteUpdatedTime) maxNoteUpdatedTime = updated;
  });

  await paginate('resources', ['updated_time'], (resource) => {
    const updated = Number(resource.updated_time) || 0;
    if (updated > maxResourceUpdatedTime) maxResourceUpdatedTime = updated;
  });

  return { maxNoteUpdatedTime, noteCount, maxResourceUpdatedTime };
}

export async function getAllFolderIds(): Promise<string[]> {
  const ids: string[] = [];
  await paginate('folders', ['id'], (folder) => {
    if (typeof folder.id === 'string') ids.push(folder.id);
  });
  return ids;
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
  await checkDiskSpace(backupRoot);

  await acquireLock(lockPath, context.staleLockMs);

  try {
    const lastSnapshotName = await resolveLastSnapshot(
      backupRoot,
      settings.lastSnapshot || undefined,
    );
    const lastSnapshotDir = lastSnapshotName ? snapshotDirPath(backupRoot, lastSnapshotName) : null;
    const lastManifest = lastSnapshotDir ? await readManifest(lastSnapshotDir) : null;

    const currentFingerprint = await getChangeFingerprint();

    if (
      settings.onlyOnChange &&
      lastManifest &&
      fingerprintsEqual(currentFingerprint, lastManifest.changeFingerprint)
    ) {
      const nowIso = (options.now ?? new Date()).toISOString();
      await setLastBackup(nowIso);
      return { status: 'skipped', message: 'No changes detected; backup skipped.' };
    }

    await safeRmDir(activeDir);
    await fs.mkdir(activeDir, { recursive: true });

    const folderIds = await getAllFolderIds();
    const exportResult = await retryTransient(
      () => joplin.commands.execute('exportFolders', folderIds, EXPORT_FORMAT, activeDir),
      context.exportRetries,
    );
    const exportWarnings = extractExportWarnings(exportResult);
    if (exportWarnings.length > 0) {
      logger.warn(
        `Export reported ${exportWarnings.length} warning(s); the snapshot may be incomplete:`,
        exportWarnings,
      );
    }

    const activeFiles = await collectActiveFiles(activeDir);
    if (activeFiles.length === 0) {
      throw new Error('Export produced no files; aborting backup.');
    }

    const dedupResult: DedupResult = await dedup(
      activeDir,
      lastSnapshotDir,
      lastManifest,
      activeFiles,
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
    const manifest = await buildManifest(activeDir, meta, activeFiles, dedupResult.hashes);
    await writeManifest(activeDir, manifest);

    await safeRmDir(snapshotDir);
    await fs.rename(activeDir, snapshotDir);
    await atomicWriteFile(path.join(backupRoot, LATEST_FILENAME), snapshotName);

    await pruneSnapshots(backupRoot, Math.max(1, settings.backupRetention));

    const nowIso = (options.now ?? new Date()).toISOString();
    await setLastBackup(nowIso);
    await setLastSnapshot(snapshotName);

    return {
      status: 'success',
      snapshotName,
      snapshotDir,
      fileCount: manifest.fileCount,
      deduplication: manifest.deduplication,
      hardlinked: dedupResult.hardlinked,
      copied: dedupResult.copied,
      unchanged: dedupResult.unchanged,
      warnings: exportWarnings,
      message:
        `Backup complete: ${manifest.fileCount} files in ${snapshotName}.` +
        (exportWarnings.length > 0
          ? ` ${exportWarnings.length} item(s) were skipped by the export (see log); the snapshot may be incomplete.`
          : ''),
    };
  } finally {
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
      const actual = await computeHash(filePath);
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

/** Crash-recovery helper used by `onStart`: recreate the root and clear staging. */
export async function recoverBackupDirs(options: BackupOptions = {}): Promise<void> {
  try {
    const settings = await getSettings();
    const backupRoot =
      options.backupRoot ?? resolveBackupRoot(settings.backupPath, options.profileName);
    await ensureBackupRoot(backupRoot);
    await safeRmDir(activeDirPath(backupRoot));
  } catch (error) {
    logger.warn('Backup directory recovery skipped.', error);
  }
}

export { SETTING_KEYS };
export type { Settings };
