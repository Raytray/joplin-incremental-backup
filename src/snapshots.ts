import fs from 'fs/promises';
import path from 'path';
import { ifExists, isDirectory, listSubdirectories, pathExists } from './platform';
import { listSnapshots } from './retention';

export const LOCK_FILENAME = '.backup.lock';
/**
 * Prefix of the per-run staging directories. The name is unique per run so two
 * concurrent runs can never write into the same directory.
 */
export const ACTIVE_DIR_PREFIX = '_joplin_active_';
export const LATEST_FILENAME = 'latest.txt';
const SNAPSHOT_COLLISION_SUFFIX_START = 2;

export function resolveBackupRoot(backupPath: string, profileName?: string): string {
  const base = backupPath.replace(/[/\\]+$/, '');
  if (!profileName || !profileName.trim()) return base;
  return path.join(base, profileName.trim());
}

export function activeDirPath(backupRoot: string): string {
  return path.join(backupRoot, createStagingDirName());
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
  return (await listSubdirectories(backupRoot)).filter((name) =>
    name.startsWith(ACTIVE_DIR_PREFIX),
  );
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
  return isDirectory(path.join(backupRoot, snapshotName));
}

/**
 * Whether anything at all (file, directory, dangling symlink) has this name,
 * so the new snapshot can be renamed into place without removing it first.
 */
async function nameTaken(backupRoot: string, name: string): Promise<boolean> {
  return pathExists(path.join(backupRoot, name));
}

/**
 * Resolve a unique snapshot name, appending `-2`, `-3`, … when a snapshot of the
 * same second already exists so a rapid second run never clobbers the first.
 */
export async function resolveUniqueSnapshotName(
  backupRoot: string,
  baseName: string,
): Promise<string> {
  if (!(await nameTaken(backupRoot, baseName))) return baseName;

  let counter = SNAPSHOT_COLLISION_SUFFIX_START;
  while (await nameTaken(backupRoot, `${baseName}-${counter}`)) {
    counter += 1;
  }
  return `${baseName}-${counter}`;
}

export async function readLatestSnapshotName(backupRoot: string): Promise<string | null> {
  const content = await ifExists(fs.readFile(path.join(backupRoot, LATEST_FILENAME), 'utf8'));
  return content?.trim() || null;
}

/**
 * Determine the previous snapshot from (in order) the explicit preference, the
 * stored `lastSnapshot` setting via `latest.txt`, or the newest directory.
 */
export async function resolveLastSnapshot(
  backupRoot: string,
  preferredSnapshotName?: string,
): Promise<string | null> {
  if (preferredSnapshotName && (await snapshotNameExists(backupRoot, preferredSnapshotName))) {
    return preferredSnapshotName;
  }

  const latest = await readLatestSnapshotName(backupRoot);
  if (latest && (await snapshotNameExists(backupRoot, latest))) return latest;

  const snapshots = await listSnapshots(backupRoot);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}
