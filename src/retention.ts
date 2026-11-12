import fs from 'fs/promises';
import path from 'path';
import { ifExists, listSubdirectories, safeRmDir } from './platform';

export const DEFAULT_RETENTION = 5;
export const MIN_RETENTION = 1;

/**
 * Snapshots to keep for a setting value: at least `MIN_RETENTION`, and
 * `DEFAULT_RETENTION` for anything that isn't a finite number.
 */
export function clampRetention(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION;
  return Math.max(MIN_RETENTION, Math.floor(parsed));
}

/** `YYYYMMDDTHHMMSS` with an optional `-N` suffix for same-second runs. */
export const SNAPSHOT_DIR_PATTERN = /^\d{8}T\d{6}(-\d+)?$/;

/**
 * A verification in progress keeps its snapshot from being pruned by leaving
 * `.verifying.<snapshot>.<id>` in the backup root. The verify refreshes the
 * file's mtime; one older than the stale threshold was left by a verify that
 * crashed, and no longer protects anything.
 */
export const VERIFY_LEASE_PREFIX = '.verifying.';

/** Same default as the backup lock's stale threshold. */
export const DEFAULT_STALE_LEASE_MS = 30 * 60 * 1000;

/** Create a verify lease on `snapshotName`; returns its path. */
export async function createVerifyLease(backupRoot: string, snapshotName: string): Promise<string> {
  const id = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const leasePath = path.join(backupRoot, `${VERIFY_LEASE_PREFIX}${snapshotName}.${id}`);
  await fs.writeFile(leasePath, new Date().toISOString(), { flag: 'wx' });
  return leasePath;
}

/**
 * Snapshots with a fresh verify lease. Stale leases are removed on the way,
 * best-effort.
 */
export async function leasedSnapshots(
  backupRoot: string,
  staleLeaseMs = DEFAULT_STALE_LEASE_MS,
): Promise<Set<string>> {
  const leased = new Set<string>();
  for (const name of (await ifExists(fs.readdir(backupRoot))) ?? []) {
    if (!name.startsWith(VERIFY_LEASE_PREFIX)) continue;
    const rest = name.slice(VERIFY_LEASE_PREFIX.length);
    const snapshot = rest.slice(0, rest.lastIndexOf('.'));
    if (!SNAPSHOT_DIR_PATTERN.test(snapshot)) continue;
    const leasePath = path.join(backupRoot, name);
    const stat = await fs.stat(leasePath).catch(() => null);
    if (!stat) continue;
    if (Date.now() - stat.mtime.getTime() <= staleLeaseMs) {
      leased.add(snapshot);
    } else {
      await fs.rm(leasePath, { force: true }).catch(() => undefined);
    }
  }
  return leased;
}

/** Snapshot directory names, sorted oldest-first (lexicographic == chronological). */
export async function listSnapshots(backupRoot: string): Promise<string[]> {
  return (await listSubdirectories(backupRoot))
    .filter((name) => SNAPSHOT_DIR_PATTERN.test(name))
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
 *
 * A snapshot that is being verified (fresh verify lease) is skipped and kept
 * until a later run, so the verify never sees its files disappear.
 */
export async function pruneSnapshots(
  backupRoot: string,
  retentionCount: number,
  keepSnapshot?: string,
  staleLeaseMs = DEFAULT_STALE_LEASE_MS,
): Promise<string[]> {
  const keep = clampRetention(retentionCount);

  const snapshots = await listSnapshots(backupRoot);
  const deleteCount = Math.max(0, snapshots.length - keep);
  const candidates = snapshots.filter((name) => name !== keepSnapshot);
  const removed: string[] = [];
  const toDelete = candidates.slice(0, deleteCount);
  const leased = toDelete.length > 0 ? await leasedSnapshots(backupRoot, staleLeaseMs) : new Set();

  for (const snapshot of toDelete) {
    if (leased.has(snapshot)) continue;
    await safeRmDir(path.join(backupRoot, snapshot));
    removed.push(snapshot);
  }

  return removed;
}
