import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { logger } from './logger';

const HASH_CHUNK_SIZE_SMALL = 64 * 1024; // ≤ 64 KB files
const HASH_CHUNK_SIZE_LARGE = 1024 * 1024; // > 64 KB files
const HASH_CHUNK_THRESHOLD = 64 * 1024;
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GiB

const HARDLINK_FALLBACK_CODES = new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS']);
const BUSY_CODES = new Set(['EBUSY', 'EPERM']);

/** Extract the `code` property of a Node.js system error, if any. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

/**
 * Write `content` to `targetPath` via a temporary file so readers never observe
 * a partially written file. Renames over an existing target are retried after
 * unlinking, which covers Windows' refusal to rename onto an existing file.
 */
export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf8');
  try {
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST' || code === 'EPERM') {
      await fs.rm(targetPath, { force: true });
      await fs.rename(tmpPath, targetPath);
      return;
    }
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
}

function createLockError(lockPath: string): NodeJS.ErrnoException {
  const error = new Error(`A backup is already in progress (lock: ${lockPath}).`);
  (error as NodeJS.ErrnoException).code = 'EEXIST';
  return error;
}

/**
 * Create an exclusive lock file. `'wx'` maps to O_CREAT | O_EXCL, so only one
 * writer can win the race. A lock older than `staleLimitMs` is assumed to be
 * left over from a crashed run and is reclaimed once.
 */
export async function acquireLock(lockPath: string, staleLimitMs: number): Promise<void> {
  const tryCreate = async (): Promise<boolean> => {
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx');
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    }

    try {
      await handle.writeFile(new Date().toISOString(), 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  };

  if (await tryCreate()) return;

  let stale = false;
  try {
    const stat = await fs.stat(lockPath);
    stale = Date.now() - stat.mtime.getTime() > staleLimitMs;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      // Released between our attempt and the stat; try once more.
      if (await tryCreate()) return;
      throw createLockError(lockPath);
    }
    throw error;
  }

  if (!stale) throw createLockError(lockPath);

  // Steal the stale lock atomically. Renaming moves it out of the way in a
  // single step, so exactly one contender can win: a second contender sees
  // ENOENT and re-checks instead of deleting the winner's fresh lock.
  const stalePath = `${lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.rename(lockPath, stalePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      // Another contender already stole (or released) it; try once more.
      if (await tryCreate()) return;
      throw createLockError(lockPath);
    }
    throw error;
  }

  await fs.rm(stalePath, { force: true });
  if (await tryCreate()) return;
  throw createLockError(lockPath);
}

/**
 * Refresh a held lock so a long-running backup is never mistaken for an
 * abandoned one. The lock's mtime is what `acquireLock` uses to judge
 * staleness, so writing the current timestamp is enough to renew it.
 *
 * The file is opened without `O_CREAT`: a lock that has been released or
 * stolen in the meantime must not be resurrected by the heartbeat.
 */
export async function touchLock(lockPath: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(lockPath, 'r+');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }

  try {
    await handle.truncate(0);
    await handle.write(new Date().toISOString(), 0, 'utf8');
  } finally {
    await handle.close();
  }
}

/** True when a lock file exists and was refreshed within `staleLimitMs`. */
export async function hasFreshLock(lockPath: string, staleLimitMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtime.getTime() <= staleLimitMs;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export async function releaseLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true });
}

/**
 * Hardlink `src` to `dest`, falling back to a copy on platforms/filesystems
 * that do not support hardlinks (notably Windows without privileges).
 */
export async function hardlinkOrCopy(src: string, dest: string): Promise<'hardlink' | 'copy'> {
  try {
    await fs.link(src, dest);
    return 'hardlink';
  } catch (error) {
    if (!HARDLINK_FALLBACK_CODES.has(errorCode(error) ?? '')) throw error;
    await fs.copyFile(src, dest);
    return 'copy';
  }
}

/**
 * Lowercased, forward-slash key used for path matching. The hash check remains
 * the source of truth, so case-only collisions are safe but may reduce dedup.
 */
export function toDedupeKey(relativePath: string): string {
  return relativePath.toLowerCase().replace(/\\/g, '/');
}

/**
 * Normalized relative path used to key per-file data (hashes, sizes). Unlike
 * `toDedupeKey` this preserves case, so two files that differ only in case
 * stay distinct and never share a hash.
 */
export function toManifestKey(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

export async function safeRmDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (error) {
    const code = errorCode(error);
    if (code && BUSY_CODES.has(code)) {
      logger.warn(`Could not remove directory "${dirPath}" (${code}); skipping.`);
      return;
    }
    throw error;
  }
}

export async function ensureBackupRoot(backupRoot: string): Promise<void> {
  await fs.mkdir(backupRoot, { recursive: true });
}

/**
 * Return free bytes at `backupRoot`, or `-1` when it cannot be determined.
 * Only reports; callers decide whether low space is fatal (see
 * `assertDiskSpace`). Unexpected stat failures are rethrown so real errors are
 * not silently swallowed.
 */
export async function checkDiskSpace(
  backupRoot: string,
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): Promise<number> {
  try {
    const stats = await fs.statfs(backupRoot);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (freeBytes < minFreeBytes) {
      logger.warn(
        `Low disk space at "${backupRoot}": ${freeBytes} bytes free (threshold ${minFreeBytes}).`,
      );
    }
    return freeBytes;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOSYS' || code === 'ERR_METHOD_NOT_IMPLEMENTED') {
      logger.warn(`Could not determine free disk space at "${backupRoot}"; continuing.`);
      return -1;
    }
    throw error;
  }
}

/**
 * Throw when the backup root has less than `minFreeBytes` free. An unavailable
 * filesystem (`-1`) is treated as "unknown, proceed" so a platform that cannot
 * report free space is never blocked entirely.
 */
export async function assertDiskSpace(
  backupRoot: string,
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): Promise<number> {
  const freeBytes = await checkDiskSpace(backupRoot, minFreeBytes);
  if (freeBytes >= 0 && freeBytes < minFreeBytes) {
    throw new Error(
      `Not enough free disk space at "${backupRoot}": ${freeBytes} bytes free, ` +
        `but at least ${minFreeBytes} bytes are required. Backup aborted.`,
    );
  }
  return freeBytes;
}

/** Bounded worker pool; results preserve the input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency) || 1);
  // oxlint-disable-next-line unicorn/no-new-array -- pre-sized result slots, filled by index
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** SHA-256 of a file, read in chunks sized by the file size (64 KB for small, 1 MB for large). */
export async function computeFileSha256(filePath: string, sizeHint?: number): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    let size = sizeHint;
    if (size === undefined) {
      const stat = await handle.stat();
      size = stat.size;
    }
    const chunkSize = size > HASH_CHUNK_THRESHOLD ? HASH_CHUNK_SIZE_LARGE : HASH_CHUNK_SIZE_SMALL;
    const buffer = Buffer.alloc(chunkSize);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/** One stat per file, in parallel, returning path and size. */
export async function collectEntries(
  dir: string,
  baseDir: string = dir,
): Promise<Array<{ path: string; size: number }>> {
  const results: Array<{ path: string; size: number }> = [];

  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        results.push({
          path: path.relative(baseDir, fullPath).split(path.sep).join('/'),
          size: stat.size,
        });
      }
    }
  };

  await walk(dir);
  return results;
}

/** Recursively collect file paths relative to `baseDir`, using `/` separators. */
export async function collectFilesRecursive(dir: string, baseDir: string = dir): Promise<string[]> {
  const entries = await collectEntries(dir, baseDir);
  return entries.map((e) => e.path);
}
