import fs from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';
import { safeRmDir } from './platform';

/** `YYYYMMDDTHHMMSS` with an optional `-N` suffix for same-second runs. */
export const SNAPSHOT_DIR_PATTERN = /^\d{8}T\d{6}(-\d+)?$/;

const MIN_RETENTION = 1;

/** Snapshot directory names, sorted oldest-first (lexicographic == chronological). */
export async function listSnapshots(backupRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(backupRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && SNAPSHOT_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Delete the oldest snapshots until at most `retentionCount` remain. A value of
 * less than 1 is clamped to 1.
 *
 * `keepSnapshot` (the snapshot just created) is never deleted and counts
 * towards the limit. Snapshots are ordered by name, i.e. by the wall clock at
 * creation, so after the clock goes backwards a new snapshot can sort as the
 * oldest one — without this exclusion it would be pruned straight away.
 */
export async function pruneSnapshots(
  backupRoot: string,
  retentionCount: number,
  keepSnapshot?: string,
): Promise<string[]> {
  const keep = Number.isFinite(retentionCount)
    ? Math.max(MIN_RETENTION, Math.floor(retentionCount))
    : MIN_RETENTION;

  const snapshots = await listSnapshots(backupRoot);
  const deleteCount = Math.max(0, snapshots.length - keep);
  const candidates = snapshots.filter((name) => name !== keepSnapshot);
  const removed: string[] = [];

  for (const snapshot of candidates.slice(0, deleteCount)) {
    await safeRmDir(path.join(backupRoot, snapshot));
    removed.push(snapshot);
  }

  return removed;
}
