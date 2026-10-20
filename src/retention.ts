/**
 * Step 1E — Retention & Pruning
 *
 * Enforce the snapshot retention limit after each successful backup.
 * Deletes the oldest snapshots until the remaining count is less than
 * or equal to retentionCount.
 */

import * as fs from 'fs/promises';
import * as nodePath from 'path';
import * as platform from './platform';

/**
 * Pattern matching snapshot directory names: YYYYMMDDTHHMMSS (e.g. 20261019T140000).
 */
export const SNAPSHOT_PATTERN = /^\d{8}T\d{6}$/;

/**
 * List all snapshot directory names within `backupRoot`, sorted oldest-first.
 * Only directory names matching `SNAPSHOT_PATTERN` are returned.
 * Non-directory files or non-matching directories are ignored.
 * If `backupRoot` does not exist, returns an empty array.
 *
 * @param backupRoot Absolute path to backup root directory
 * @returns Array of snapshot directory names sorted oldest-first
 */
export async function listSnapshots(backupRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(backupRoot, { withFileTypes: true });
    const snapshots: string[] = [];

    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!SNAPSHOT_PATTERN.test(name)) {
        continue;
      }

      let isDir = false;
      if (typeof entry !== 'string' && typeof entry.isDirectory === 'function') {
        isDir = entry.isDirectory();
      } else {
        try {
          const stat = await fs.stat(nodePath.join(backupRoot, name));
          isDir = stat.isDirectory();
        } catch {
          isDir = false;
        }
      }

      if (isDir) {
        snapshots.push(name);
      }
    }

    // Since names are fixed-format timestamps (YYYYMMDDTHHMMSS),
    // lexicographical sorting is identical to chronological sorting (oldest first).
    return snapshots.sort((a, b) => a.localeCompare(b));
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Prune snapshots in `backupRoot` so that no more than `retentionCount` snapshots remain.
 *
 * Deletes the oldest snapshots first using `safeRmDir`.
 * If `safeRmDir` fails (e.g. simulated or real EBUSY), the failure is caught and logged,
 * leaving remaining snapshots unaffected.
 *
 * @param backupRoot Absolute path to backup root directory
 * @param retentionCount Maximum number of snapshots to keep
 * @returns Array of snapshot directory names that were deleted
 */
export async function pruneSnapshots(
  backupRoot: string,
  retentionCount: number,
): Promise<string[]> {
  const safeRetention = Math.max(0, retentionCount);
  const snapshots = await listSnapshots(backupRoot);

  const numToDelete = snapshots.length - safeRetention;
  if (numToDelete <= 0) {
    return [];
  }

  const toDelete = snapshots.slice(0, numToDelete);
  const pruned: string[] = [];

  for (const snapshot of toDelete) {
    const snapshotPath = nodePath.join(backupRoot, snapshot);
    try {
      await platform.safeRmDir(snapshotPath);
      pruned.push(snapshot);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (
        nodeErr.code === 'EBUSY' ||
        (err instanceof Error && err.message.toLowerCase().includes('busy'))
      ) {
        console.warn(
          `[IncrementalBackup] pruneSnapshots: could not remove ${snapshotPath} — directory busy (EBUSY). Skipping.`,
        );
      } else {
        throw err;
      }
    }
  }

  return pruned;
}
