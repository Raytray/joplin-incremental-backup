/**
 * Step 1B — Cross-Platform Utilities
 *
 * All OS-sensitive primitives live here so every other module can remain
 * platform-agnostic.  Each function is independently testable via memfs.
 */

import * as fs from 'fs/promises';
import * as nodePath from 'path';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------

/**
 * Atomically write `content` to `targetPath`.
 *
 * Strategy: write to `<target>.tmp`, then `fs.rename`.
 * On Windows, rename throws EEXIST if the destination already exists, so we
 * unlink the destination first and retry once.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(nodePath.dirname(targetPath), { recursive: true });
  const tmpPath = targetPath + '.tmp';
  await fs.writeFile(tmpPath, content, 'utf8');
  try {
    await fs.rename(tmpPath, targetPath);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'EEXIST') {
      await fs.unlink(targetPath);
      await fs.rename(tmpPath, targetPath);
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// acquireLock / releaseLock
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive lock file at `lockPath` using the O_EXCL `'wx'` flag.
 *
 * If the existing lock is older than `staleLimitMs` milliseconds it is
 * considered stale: we delete it and retry once.  If the lock is still held
 * after the retry, we throw with code `'EEXIST'`.
 *
 * The lock file stores the creation time (ISO string) so the stale check can
 * be performed without relying on OS-level mtime (which can be unreliable
 * across platforms).
 */
export async function acquireLock(
  lockPath: string,
  staleLimitMs: number,
): Promise<void> {
  await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });

  const tryAcquire = async (): Promise<boolean> => {
    try {
      const fh = await fs.open(lockPath, 'wx');
      await fh.writeFile(new Date().toISOString(), 'utf8');
      await fh.close();
      return true;
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'EEXIST') {
        return false;
      }
      throw err;
    }
  };

  if (await tryAcquire()) return;

  // Lock exists — check whether it is stale.
  let stale = false;
  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const created = new Date(content).getTime();
    if (!isNaN(created) && Date.now() - created > staleLimitMs) {
      stale = true;
    }
  } catch {
    // If we cannot read the lock file, treat it as stale.
    stale = true;
  }

  if (stale) {
    await fs.unlink(lockPath);
    if (await tryAcquire()) return;
  }

  // Still blocked.
  const err: NodeJS.ErrnoException = new Error(
    `Lock already held: ${lockPath}`,
  );
  err.code = 'EEXIST';
  throw err;
}

/**
 * Release (delete) the lock file at `lockPath`.
 * Silently ignores ENOENT — the lock may already have been cleaned up.
 */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') throw err;
  }
}

// ---------------------------------------------------------------------------
// hardlinkOrCopy
// ---------------------------------------------------------------------------

/** Error codes that indicate hardlinks are not supported on this path/OS. */
const HARDLINK_UNSUPPORTED_CODES = new Set([
  'EPERM',
  'ENOTSUP',
  'EXDEV',
  'ENOSYS',
]);

/**
 * Attempt to create a hardlink from `src` to `dest`.
 * Falls back to a regular file copy when hardlinks are unsupported (e.g.
 * cross-device, FAT32, network share, or insufficient permissions on Windows).
 *
 * @returns `'hardlink'` when a hardlink was created, `'copy'` otherwise.
 */
export async function hardlinkOrCopy(
  src: string,
  dest: string,
): Promise<'hardlink' | 'copy'> {
  // Ensure the destination directory exists.
  await fs.mkdir(nodePath.dirname(dest), { recursive: true });

  try {
    await fs.link(src, dest);
    return 'hardlink';
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code && HARDLINK_UNSUPPORTED_CODES.has(nodeErr.code)) {
      await fs.copyFile(src, dest);
      return 'copy';
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// toDedupeKey
// ---------------------------------------------------------------------------

/**
 * Produce a case-insensitive, forward-slash-normalised key for use in the
 * deduplication map.  This makes dedup work correctly on case-insensitive
 * file systems (Windows, macOS) where `Notes/foo.md` and `notes/FOO.MD`
 * are the same file.
 */
export function toDedupeKey(relativePath: string): string {
  return relativePath.toLowerCase().replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// safeRmDir
// ---------------------------------------------------------------------------

/**
 * Recursively remove `dirPath`.
 *
 * On Windows, `EBUSY` errors (e.g. an Explorer window is open inside the
 * directory) are caught and logged as warnings rather than thrown, so a
 * transient lock does not abort the whole backup run.
 */
export async function safeRmDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'EBUSY') {
      logger.warn(
        `safeRmDir: could not remove ${dirPath} — directory busy (EBUSY). Skipping.`,
      );
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// ensureBackupRoot
// ---------------------------------------------------------------------------

export async function checkDiskSpace(
  backupRoot: string,
  minFreeBytes: number = 10 * 1024 * 1024,
): Promise<number> {
  if (typeof fs.statfs !== 'function') {
    return 0;
  }
  try {
    const stat = await fs.statfs(backupRoot);
    const available = Number(stat.bavail) * Number(stat.bsize);
    if (minFreeBytes > 0 && available < minFreeBytes) {
      throw new Error(
        `Insufficient disk space for backup: ${available} bytes available, ` +
          `${minFreeBytes} bytes required.`,
      );
    }
    return available;
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    // If statfs is unsupported on this platform/fs, don't block the backup.
    if (nodeErr && (nodeErr.code === 'ENOSYS' || nodeErr.code === 'ENOTSUP')) {
      return 0;
    }
    if (err instanceof Error && err.message.includes('Insufficient disk space')) {
      throw err;
    }
    return 0;
  }
}

/**
 * Run an async mapper over `items` with a bounded number of concurrent workers.
 * Results are returned in the original input order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const workerCount = Math.max(1, Math.min(concurrency || 1, items.length));
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) break;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function ensureBackupRoot(backupRoot: string): Promise<void> {
  if (!backupRoot || !backupRoot.trim()) {
    throw new Error('Backup path is empty. Please configure a valid backup directory in settings.');
  }

  try {
    const stat = await fs.stat(backupRoot);
    if (!stat.isDirectory()) {
      throw new Error(`Backup path exists but is not a directory: ${backupRoot}`);
    }
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      await fs.mkdir(backupRoot, { recursive: true });
    } else if (err instanceof Error && err.message.includes('not a directory')) {
      throw err;
    } else {
      throw err;
    }
  }

  try {
    await fs.access(backupRoot, fs.constants.W_OK);
  } catch {
    throw new Error(`Backup path is not writable: ${backupRoot}`);
  }
}
