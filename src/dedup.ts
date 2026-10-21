import fs from 'fs/promises';
import path from 'path';
import {
  collectFilesRecursive,
  computeFileSha256,
  errorCode,
  hardlinkOrCopy,
  mapWithConcurrency,
  toDedupeKey,
  toManifestKey,
} from './platform';
import { logger } from './logger';
import type { DeduplicationMode, FileEntry, Manifest } from './manifest';

const DEDUP_CONCURRENCY = 8;

/** Suffix of the staging file used to prepare a hardlink before swapping it in. */
const DEDUP_TEMP_SUFFIX = '.dedup_tmp';

export interface ContentIndex {
  pathIndex: Map<string, FileEntry>;
  hashIndex: Map<string, FileEntry>;
}

export interface DedupResult {
  hardlinked: number;
  copied: number;
  unchanged: number;
  /** Files whose link/copy could not be staged; the exported copy was kept. */
  failed: number;
  /** Normalized relative path (`toManifestKey`) → SHA-256. */
  hashes: Map<string, string>;
}

export interface DedupOptions {
  /** Injectable SHA-256 implementation (defaults to the streaming one). */
  computeHash?: (filePath: string, sizeHint?: number) => Promise<string>;
  /** Known file sizes, keyed by `toManifestKey` relative path. */
  fileSizes?: ReadonlyMap<string, number>;
}

export function buildContentIndex(manifest: Manifest | null | undefined): ContentIndex {
  const pathIndex = new Map<string, FileEntry>();
  const hashIndex = new Map<string, FileEntry>();

  if (!manifest) return { pathIndex, hashIndex };

  for (const entry of manifest.files) {
    pathIndex.set(toDedupeKey(entry.path), entry);
    if (!hashIndex.has(entry.sha256)) hashIndex.set(entry.sha256, entry);
  }

  return { pathIndex, hashIndex };
}

export async function collectFiles(dir: string): Promise<string[]> {
  return collectFilesRecursive(dir, dir);
}

export function getDeduplicationMode(
  result: Pick<DedupResult, 'hardlinked' | 'copied'>,
): DeduplicationMode {
  if (result.copied > 0) return 'copy';
  if (result.hardlinked > 0) return 'hardlink';
  return 'none';
}

function findMatch(index: ContentIndex, key: string, sha256: string): FileEntry | null {
  const byPath = index.pathIndex.get(key);
  if (byPath && byPath.sha256 === sha256) return byPath;
  return index.hashIndex.get(sha256) ?? null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Replace `activePath` with a hardlink (or a copy) of `sourcePath` without ever
 * leaving the destination missing.
 *
 * The replacement is staged under a temporary name in the same directory and
 * then swapped in with a rename. If anything fails the freshly exported file
 * stays exactly where it is — only the space saving is lost, never the data.
 */
export async function replaceWithLink(
  sourcePath: string,
  activePath: string,
): Promise<'hardlink' | 'copy'> {
  const tempPath = `${activePath}${DEDUP_TEMP_SUFFIX}`;
  await fs.rm(tempPath, { force: true });

  let mode: 'hardlink' | 'copy';
  try {
    mode = await hardlinkOrCopy(sourcePath, tempPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  try {
    await fs.rename(tempPath, activePath);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EEXIST' && code !== 'EPERM') {
      // Not a "destination exists" problem: keep the exported file untouched.
      await fs.rm(tempPath, { force: true });
      throw error;
    }
    // Windows can refuse to rename onto an existing file. The staged copy is
    // ready, so removing the destination is safe.
    await fs.rm(activePath, { force: true });
    try {
      await fs.rename(tempPath, activePath);
    } catch (renameError) {
      await fs.rm(tempPath, { force: true });
      throw renameError;
    }
  }

  return mode;
}

/**
 * Replace files in `activeDir` with hardlinks to identical files in the
 * previous snapshot. Files with no matching content are left untouched.
 */
export async function dedup(
  activeDir: string,
  previousSnapshotDir: string | null,
  previousManifest: Manifest | null,
  activeFiles?: readonly string[],
  options: DedupOptions = {},
): Promise<DedupResult> {
  const files = activeFiles ? [...activeFiles] : await collectFiles(activeDir);
  const index = buildContentIndex(previousManifest);
  const hashes = new Map<string, string>();
  const computeHash = options.computeHash ?? computeFileSha256;

  const modes = await mapWithConcurrency(
    files,
    DEDUP_CONCURRENCY,
    async (relativePath): Promise<DeduplicationMode | 'failed' | null> => {
      const key = toManifestKey(relativePath);
      const activePath = path.join(activeDir, relativePath);
      const sha256 = await computeHash(activePath, options.fileSizes?.get(key));
      hashes.set(key, sha256);

      if (!previousSnapshotDir) return null;

      const match = findMatch(index, toDedupeKey(relativePath), sha256);
      if (!match) return null;

      const sourcePath = path.join(previousSnapshotDir, match.path);
      if (path.resolve(sourcePath) === path.resolve(activePath)) return null;
      if (!(await fileExists(sourcePath))) return null;

      try {
        return await replaceWithLink(sourcePath, activePath);
      } catch (error) {
        // The exported file is still in place and has the recorded hash, so the
        // snapshot stays correct — only the deduplication is lost.
        logger.warn(`Could not deduplicate "${relativePath}"; keeping the exported copy.`, error);
        return 'failed';
      }
    },
  );

  let hardlinked = 0;
  let copied = 0;
  let unchanged = 0;
  let failed = 0;

  for (const mode of modes) {
    if (mode === 'hardlink') hardlinked += 1;
    else if (mode === 'copy') copied += 1;
    else if (mode === 'failed') failed += 1;
    else unchanged += 1;
  }

  return { hardlinked, copied, unchanged, failed, hashes };
}
