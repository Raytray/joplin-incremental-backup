import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger';
import {
  acquireLock,
  collectFilesRecursive,
  computeFileSha256,
  DEFAULT_STALE_LOCK_MS,
  errorCode,
  mapWithConcurrency,
  releaseLock,
  startLockHeartbeat,
} from './platform';
import { MANIFEST_FILENAME, readManifest } from './manifest';
import { createVerifyLease } from './retention';
import { configuredBackupRoot, getSettings } from './settings';
import { LOCK_FILENAME, resolveLastSnapshot, snapshotDirPath } from './snapshots';
import type { BackupOptions } from './backup';

const VERIFY_CONCURRENCY = 8;

export interface VerifyResult {
  ok: boolean;
  snapshotName: string | null;
  snapshotDir: string | null;
  total: number;
  matched: number;
  mismatches: string[];
  /**
   * Files in the snapshot that its manifest does not list (besides the
   * manifest itself). Reported as a warning: they don't make it fail.
   */
  extraFiles: string[];
  /** A backup was running, so nothing was verified. */
  busy?: boolean;
  message: string;
}

/** How many extra file paths the verify message lists by name. */
const EXTRA_FILES_SHOWN = 10;

/** Errors that mean the backup drive can't be written to at all. */
const READ_ONLY_CODES = new Set(['EROFS', 'EACCES', 'EPERM']);

function emptyVerifyResult(
  snapshotName: string | null,
  snapshotDir: string | null,
  message: string,
  extra: Partial<VerifyResult> = {},
): VerifyResult {
  return {
    ok: false,
    snapshotName,
    snapshotDir,
    total: 0,
    matched: 0,
    mismatches: [],
    extraFiles: [],
    message,
    ...extra,
  };
}

/**
 * Verify the latest snapshot against its manifest.
 *
 * The backup lock is only held while choosing the snapshot and leasing it:
 * hashing a whole snapshot can take minutes, and holding the lock that long
 * would make scheduled backups fail. Prunes skip a leased snapshot, and they
 * only run under the lock, so none can start between choosing and leasing.
 */
export async function verifyBackup(options: BackupOptions = {}): Promise<VerifyResult> {
  const settings = await getSettings();
  const backupRoot = configuredBackupRoot(settings, options);
  const computeHash = options.computeHash ?? computeFileSha256;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const lockPath = path.join(backupRoot, LOCK_FILENAME);
  const resolve = () => resolveLastSnapshot(backupRoot, settings.lastSnapshot || undefined);

  let snapshotName: string | null;
  let leasePath: string | null = null;
  try {
    await acquireLock(lockPath, staleLockMs);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST') {
      return emptyVerifyResult(
        null,
        null,
        'A backup is in progress. Verify again once it has finished.',
        { busy: true },
      );
    }
    // No backup directory yet: nothing to verify (reported below).
    if (code === 'ENOENT') return emptyVerifyResult(null, null, 'No snapshot found to verify.');
    // A read-only drive can't be backed up to, so nothing can prune it.
    if (!code || !READ_ONLY_CODES.has(code)) throw error;
    logger.warn(`Verifying without a lease: the backup drive is not writable (${code}).`);
    snapshotName = await resolve();
    return snapshotName
      ? verifySnapshot(backupRoot, snapshotName, computeHash)
      : emptyVerifyResult(null, null, 'No snapshot found to verify.');
  }

  try {
    snapshotName = await resolve();
    if (snapshotName) leasePath = await createVerifyLease(backupRoot, snapshotName);
  } finally {
    await releaseLock(lockPath).catch((error) =>
      logger.warn('Failed to release backup lock.', error),
    );
  }

  if (!snapshotName) return emptyVerifyResult(null, null, 'No snapshot found to verify.');

  const heartbeat = startLockHeartbeat(leasePath!, staleLockMs, 'verify lease');
  try {
    return await verifySnapshot(backupRoot, snapshotName, computeHash);
  } finally {
    heartbeat.stop();
    await fs
      .rm(leasePath!, { force: true })
      .catch((error) => logger.warn('Failed to remove the verify lease.', error));
  }
}

/** Check every file of one snapshot against its manifest, and look for unlisted files. */
async function verifySnapshot(
  backupRoot: string,
  snapshotName: string,
  computeHash: NonNullable<BackupOptions['computeHash']>,
): Promise<VerifyResult> {
  const snapshotDir = snapshotDirPath(backupRoot, snapshotName);
  const manifest = await readManifest(snapshotDir);
  if (!manifest) {
    return emptyVerifyResult(
      snapshotName,
      snapshotDir,
      `No valid manifest found in ${snapshotName}.`,
    );
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

  const listed = new Set(manifest.files.map((file) => file.path));
  listed.add(MANIFEST_FILENAME);
  const extraFiles = (await collectFilesRecursive(snapshotDir))
    .filter((filePath) => !listed.has(filePath))
    .sort();

  const ok = mismatches.length === 0 && total > 0;
  let message = ok
    ? `Verified ${total} files in ${snapshotName}.`
    : `Verification failed in ${snapshotName}: ${mismatches.length} of ${total} files mismatch.`;
  if (extraFiles.length > 0) {
    const shown = extraFiles.slice(0, EXTRA_FILES_SHOWN);
    const more = extraFiles.length - shown.length;
    message +=
      `\n\nWarning: ${extraFiles.length} file(s) in the snapshot are not listed in its ` +
      `manifest:\n${shown.join('\n')}` +
      (more > 0 ? `\n… and ${more} more` : '');
  }

  return { ok, snapshotName, snapshotDir, total, matched, mismatches, extraFiles, message };
}
