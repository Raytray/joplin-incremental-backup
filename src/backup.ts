/**
 * Step 2 — Backup Engine
 *
 * Orchestrates one full incremental backup run:
 *  1. Acquires cross-platform exclusive lock.
 *  2. Reads & validates plugin settings.
 *  3. Checks onlyOnChange condition to skip snapshot if no notes modified.
 *  4. Cleans up and creates the active staging directory `_joplin_active_`.
 *  5. Exports all Joplin folders via Joplin's native raw export.
 *  6. Verifies export produced files (throws on empty).
 *  7. Deduplicates files against the previous snapshot (hardlink or copy fallback).
 *  8. Builds and writes manifest.json.
 *  9. Atomically moves staging directory to timestamped snapshot directory.
 * 10. Updates latest.txt pointer.
 * 11. Enforces retention limits via pruning.
 * 12. Updates lastBackup and lastSnapshot in settings.
 * 13. Always releases lock and cleans up leftover staging directory in finally.
 */

import * as fs from 'fs/promises';
import * as nodePath from 'path';
import joplin from 'api';
import { getSettings, setLastBackup, setLastSnapshot, BackupSettings } from './settings';
import {
  acquireLock,
  releaseLock,
  atomicWriteFile,
  safeRmDir,
  ensureBackupRoot,
  checkDiskSpace,
  computeFileSha256,
  mapWithConcurrency,
} from './platform';
import { buildManifest, writeManifest, readManifest, Manifest, collectFilesFromPaths } from './manifest';
import {
  dedup,
  collectFiles as collectActiveFiles,
  getDeduplicationMode,
  DedupResult,
} from './dedup';
import { pruneSnapshots, listSnapshots, SNAPSHOT_PATTERN } from './retention';
import { logger } from './logger';

export const LOCK_FILENAME = '.backup.lock';
export const ACTIVE_DIR_NAME = '_joplin_active_';
export const LATEST_FILENAME = 'latest.txt';
export const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000; // 30 minutes

export interface BackupOptions {
  staleLimitMs?: number;
  lockPath?: string;
  now?: Date;
  snapshotName?: string;
  platform?: NodeJS.Platform;
  profileName?: string;
  minFreeBytes?: number;
  exportRetries?: number;
  snapshotToVerify?: string;
}

export interface BackupResult {
  status: 'success' | 'skipped';
  snapshotDir?: string;
  snapshotName?: string;
  manifest?: Manifest;
  dedupStats?: DedupResult;
  prunedSnapshots?: string[];
  skippedReason?: string;
}

/**
 * Format a Date into the snapshot directory format: YYYYMMDDTHHMMSS (UTC).
 * Matches SNAPSHOT_PATTERN (/^\d{8}T\d{6}$/).
 */
export function generateSnapshotName(date: Date = new Date()): string {
  const pad = (n: number, width: number = 2) => n.toString().padStart(width, '0');
  const yyyy = pad(date.getUTCFullYear(), 4);
  const mm = pad(date.getUTCMonth() + 1, 2);
  const dd = pad(date.getUTCDate(), 2);
  const hh = pad(date.getUTCHours(), 2);
  const min = pad(date.getUTCMinutes(), 2);
  const ss = pad(date.getUTCSeconds(), 2);
  return `${yyyy}${mm}${dd}T${hh}${min}${ss}`;
}

/**
 * Recursively count all regular files in a directory.
 * Ignores temporary .tmp files and the active lock file if present.
 */
export async function countFilesInDir(dir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (name.endsWith('.tmp') || name === LOCK_FILENAME) {
        continue;
      }

      const fullPath = nodePath.join(dir, name);
      let isDirectory = false;
      let isFile = false;

      if (typeof entry !== 'string' && typeof entry.isDirectory === 'function') {
        isDirectory = entry.isDirectory();
        isFile = entry.isFile();
      } else {
        const stat = await fs.stat(fullPath);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      }

      if (isDirectory) {
        count += await countFilesInDir(fullPath);
      } else if (isFile) {
        count++;
      }
    }
  } catch {
    return 0;
  }
  return count;
}

/**
 * Retrieve the maximum updated_time across all notes in Joplin.
 * Handles pagination if notes exceed a single page.
 */
export async function getMaxNotesUpdatedTime(): Promise<number> {
  let maxTime = 0;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await joplin.data.get<{ updated_time?: number | string }>(['notes'], {
      fields: ['updated_time'],
      page,
    });

    if (response && Array.isArray(response.items)) {
      for (const item of response.items) {
        if (item && item.updated_time !== undefined && item.updated_time !== null) {
          const num =
            typeof item.updated_time === 'number' ? item.updated_time : Number(item.updated_time);
          if (!isNaN(num) && num > maxTime) {
            maxTime = num;
          }
        }
      }
      hasMore = !!response.has_more;
      page++;
    } else {
      hasMore = false;
    }
  }

  return maxTime;
}

/**
 * Collect all folder (notebook) IDs across Joplin.
 * Handles pagination.
 */
export async function getAllFolderIds(): Promise<string[]> {
  const folderIds: string[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await joplin.data.get<{ id: string }>(['folders'], {
      fields: ['id'],
      page,
    });

    if (response && Array.isArray(response.items)) {
      for (const item of response.items) {
        if (item && typeof item.id === 'string' && item.id.trim()) {
          folderIds.push(item.id.trim());
        }
      }
      hasMore = !!response.has_more;
      page++;
    } else {
      hasMore = false;
    }
  }

  return folderIds;
}

/**
 * Resolve the directory of the previous snapshot.
 * Checks settings.lastSnapshot first, then latest.txt, then lists snapshots in backupRoot.
 */
export async function resolveLastSnapshot(
  backupRoot: string,
  preferredSnapshotName?: string,
): Promise<{ name: string; dir: string } | null> {
  // 1. Try preferred snapshot name (from settings.lastSnapshot)
  if (preferredSnapshotName && preferredSnapshotName.trim()) {
    const candidateName = preferredSnapshotName.trim();
    if (SNAPSHOT_PATTERN.test(candidateName)) {
      const candidateDir = nodePath.join(backupRoot, candidateName);
      try {
        const stat = await fs.stat(candidateDir);
        if (stat.isDirectory()) {
          return { name: candidateName, dir: candidateDir };
        }
      } catch {
        // Preferred snapshot directory does not exist on disk
      }
    }
  }

  // 2. Try latest.txt
  const latestTxtPath = nodePath.join(backupRoot, LATEST_FILENAME);
  try {
    const content = (await fs.readFile(latestTxtPath, 'utf8')).trim();
    if (content && SNAPSHOT_PATTERN.test(content)) {
      const candidateDir = nodePath.join(backupRoot, content);
      const stat = await fs.stat(candidateDir);
      if (stat.isDirectory()) {
        return { name: content, dir: candidateDir };
      }
    }
  } catch {
    // latest.txt absent or unreadable
  }

  // 3. Fallback: list all valid snapshots sorted oldest-first, pick the newest
  try {
    const snapshots = await listSnapshots(backupRoot);
    if (snapshots.length > 0) {
      const newestName = snapshots[snapshots.length - 1];
      return { name: newestName, dir: nodePath.join(backupRoot, newestName) };
    }
  } catch {
    // backupRoot may not exist yet
  }

  return null;
}

/**
 * Orchestrate one full backup run.
 */
export function sanitizeProfileName(profileName: string): string {
  return profileName.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function resolveBackupRoot(basePath: string, profileName?: string): string {
  const profile = profileName?.trim();
  if (!profile) return basePath;
  return nodePath.join(basePath, sanitizeProfileName(profile));
}

const TRANSIENT_EXPORT_CODES = new Set([
  'EAGAIN',
  'EBUSY',
  'ETIMEDOUT',
  'ECONNRESET',
  'ENFILE',
  'EMFILE',
  'EINTR',
]);

export function isTransientExportError(err: unknown): boolean {
  const nodeErr = err as { code?: string; message?: string } | null;
  if (!nodeErr) return false;
  if (nodeErr.code && TRANSIENT_EXPORT_CODES.has(nodeErr.code)) return true;
  const message = typeof nodeErr.message === 'string' ? nodeErr.message : '';
  return /timeout|temporarily unavailable|resource busy|try again/i.test(message);
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 3,
): Promise<T> {
  let lastError: unknown;
  const attempts = Math.max(1, Math.floor(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isTransientExportError(err)) {
        throw err;
      }
    }
  }
  throw lastError;
}

export async function runBackup(options: BackupOptions = {}): Promise<BackupResult> {
  // Validate and read configuration
  const settings: BackupSettings = await getSettings(options.platform);
  const backupRoot = resolveBackupRoot(settings.backupPath, options.profileName);

  // Ensure the backup root exists and is writable (auto-create if absent).
  await ensureBackupRoot(backupRoot);

  // Pre-flight: verify sufficient free disk space.
  await checkDiskSpace(backupRoot, options.minFreeBytes);

  // Determine lock file path
  const lockPath = options.lockPath ?? nodePath.join(backupRoot, LOCK_FILENAME);
  const staleLimitMs = options.staleLimitMs ?? DEFAULT_STALE_LOCK_MS;

  // Acquire exclusive cross-platform lock.
  // If already held, throws EEXIST immediately.
  await acquireLock(lockPath, staleLimitMs);
  let lockAcquired = true;

  const activeDir = nodePath.join(backupRoot, ACTIVE_DIR_NAME);

  try {
    // Resolve last snapshot (if any) and read its manifest
    const lastSnapshotInfo = await resolveLastSnapshot(backupRoot, settings.lastSnapshot);
    let lastManifest: Manifest | null = null;
    if (lastSnapshotInfo) {
      lastManifest = await readManifest(lastSnapshotInfo.dir);
    }

    // Determine max updated_time from Joplin notes
    const maxUpdatedTime = await getMaxNotesUpdatedTime();

    // Check onlyOnChange condition:
    // If onlyOnChange is true, lastSnapshot exists with valid manifest, and no notes changed:
    // skip creating a new snapshot, but update lastBackup timestamp.
    if (settings.onlyOnChange && lastSnapshotInfo && lastManifest) {
      const lastChangeTime = lastManifest.lastChangeTime;
      const lastBackupMs = settings.lastBackup ? new Date(settings.lastBackup).getTime() : NaN;

      const isUnchanged =
        maxUpdatedTime === lastChangeTime ||
        (!isNaN(lastBackupMs) && maxUpdatedTime === lastBackupMs) ||
        maxUpdatedTime <= lastChangeTime;

      if (isUnchanged) {
        const nowIso = (options.now ?? new Date()).toISOString();
        await setLastBackup(nowIso);
        return {
          status: 'skipped',
          skippedReason: 'No changes detected since last backup',
        };
      }
    }

    // Ensure backupRoot directory exists
    await fs.mkdir(backupRoot, { recursive: true });

    // Clean up any leftover staging activeDir, then re-create it
    await safeRmDir(activeDir);
    await fs.mkdir(activeDir, { recursive: true });

    // Retrieve all folder IDs from Joplin
    const notebookIds = await getAllFolderIds();

    // Trigger Joplin's native raw export to activeDir (retry transient failures)
    await retryTransient(
      () => joplin.commands.execute('exportFolders', notebookIds, 'raw', activeDir),
      options.exportRetries ?? 3,
    );

    // Collect the exported files once (avoid repeated directory walks)
    const activeFileList = await collectActiveFiles(activeDir);
    if (activeFileList.length === 0) {
      throw new Error('Export verification failed: export produced zero files.');
    }

    // Compute file entries (path, size, streaming SHA-256) once for both dedup and manifest.
    const activeEntries = await collectFilesFromPaths(activeFileList, activeDir);
    const activeHashes = new Map<string, string>(
      activeFileList.map((filePath, index) => [filePath, activeEntries[index].sha256]),
    );

    // Deduplicate against last snapshot
    const lastSnapshotDir = lastSnapshotInfo ? lastSnapshotInfo.dir : undefined;
    const dedupStats: DedupResult = await dedup(
      activeDir,
      lastSnapshotDir,
      lastManifest,
      activeFileList,
      activeHashes,
    );

    // Prepare timestamp and snapshot naming
    const now = options.now ?? new Date();
    const snapshotName = options.snapshotName ?? generateSnapshotName(now);
    const snapshotDir = nodePath.join(backupRoot, snapshotName);

    // Query Joplin version (prefer versionInfo on Joplin 3.x; fall back to
    // appVersion for older releases where versionInfo is unavailable).
    let joplinVersion = '';
    try {
      if (typeof joplin.versionInfo === 'function') {
        const info = await joplin.versionInfo();
        joplinVersion = (info && typeof info.version === 'string') ? info.version : '';
      } else if (typeof joplin.appVersion === 'function') {
        joplinVersion = await joplin.appVersion();
      }
    } catch {
      // Fall back to appVersion if versionInfo failed (e.g. older shim).
      try {
        if (typeof joplin.appVersion === 'function') {
          joplinVersion = await joplin.appVersion();
        }
      } catch {
        joplinVersion = '';
      }
    }

    // Build and atomically write manifest in activeDir
    const manifest = await buildManifest(
      activeDir,
      {
        snapshotId: snapshotName,
        createdAt: now.getTime(),
        joplinVersion,
        lastChangeTime: maxUpdatedTime,
        deduplication: getDeduplicationMode(dedupStats),
      },
      null,
      activeEntries,
    );
    await writeManifest(activeDir, manifest);

    // Move staging directory activeDir to final snapshotDir
    try {
      await safeRmDir(snapshotDir);
    } catch {
      // Dest dir didn't exist, proceed
    }
    await fs.rename(activeDir, snapshotDir);

    // Atomically write latest.txt pointing to the new snapshot name
    const latestTxtPath = nodePath.join(backupRoot, LATEST_FILENAME);
    await atomicWriteFile(latestTxtPath, snapshotName);

    // Prune old snapshots exceeding retention limit
    const prunedSnapshots = await pruneSnapshots(backupRoot, settings.backupRetention);

    // Update settings: lastBackup (ISO string) and lastSnapshot (directory name)
    const nowIso = now.toISOString();
    await setLastBackup(nowIso);
    await setLastSnapshot(snapshotName);

    return {
      status: 'success',
      snapshotDir,
      snapshotName,
      manifest,
      dedupStats,
      prunedSnapshots,
    };
  } finally {
    if (lockAcquired) {
      try {
        await releaseLock(lockPath);
      } catch (err) {
        logger.warn('Failed to release lock:', err);
      }
    }
    try {
      await safeRmDir(activeDir);
    } catch (err) {
      logger.warn('Failed to clean up active directory:', err);
    }
  }
}

export interface VerifyResult {
  ok: boolean;
  snapshotName: string;
  snapshotDir: string;
  total: number;
  matched: number;
  mismatches: string[];
  message: string;
}

/**
 * Verify the latest (or specified) snapshot against its manifest.
 * Checks that every recorded file exists and its SHA-256 matches.
 */
export async function verifyBackup(options: BackupOptions = {}): Promise<VerifyResult> {
  const settings = await getSettings(options.platform);
  const backupRoot = resolveBackupRoot(settings.backupPath, options.profileName);

  const requestedSnapshot = options.snapshotToVerify ?? options.snapshotName;
  let snapshotInfo: { name: string; dir: string } | null = null;
  if (requestedSnapshot) {
    const candidateDir = nodePath.join(backupRoot, requestedSnapshot);
    try {
      const stat = await fs.stat(candidateDir);
      if (stat.isDirectory() && SNAPSHOT_PATTERN.test(requestedSnapshot)) {
        snapshotInfo = { name: requestedSnapshot, dir: candidateDir };
      }
    } catch {
      // fall through to resolveLastSnapshot
    }
  }
  if (!snapshotInfo) {
    snapshotInfo = await resolveLastSnapshot(backupRoot, settings.lastSnapshot);
  }
  if (!snapshotInfo) {
    throw new Error('No snapshot found to verify.');
  }

  const snapshotDir = snapshotInfo.dir;
  const snapshotName = snapshotInfo.name;
  const manifest = await readManifest(snapshotDir);
  if (!manifest) {
    throw new Error(`Manifest missing or malformed in snapshot ${snapshotName}.`);
  }

  const verificationResults = await mapWithConcurrency(manifest.files, 8, async (entry) => {
    const filePath = nodePath.join(snapshotDir, entry.path);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size !== entry.size) {
        return false;
      }
      const hash = await computeFileSha256(filePath);
      return hash === entry.sha256;
    } catch {
      return false;
    }
  });

  let matched = 0;
  const mismatches: string[] = [];
  verificationResults.forEach((isOk, index) => {
    if (isOk) {
      matched++;
    } else {
      mismatches.push(manifest.files[index].path);
    }
  });

  const total = manifest.files.length;
  const ok = mismatches.length === 0 && matched === total && total > 0;
  const message = ok
    ? `✅ All ${matched} files match`
    : mismatches.length > 0
      ? `❌ Hash mismatch: ${mismatches.join(', ')}`
      : `❌ Verification failed`;

  return {
    ok,
    snapshotName,
    snapshotDir,
    total,
    matched,
    mismatches,
    message,
  };
}

export const verifyIncrementalBackup = verifyBackup;
export const verify = verifyBackup;
export { verifyBackup as runVerify };
export { verifyBackup as verifySnapshot };
export { verifyBackup as checkBackup };
