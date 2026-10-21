import fs from 'fs/promises';
import path from 'path';
import {
  collectFilesRecursive,
  computeFileSha256,
  hardlinkOrCopy,
  mapWithConcurrency,
  toDedupeKey,
} from './platform';
import type { DeduplicationMode, FileEntry, Manifest } from './manifest';

const DEDUP_CONCURRENCY = 8;

export interface ContentIndex {
  pathIndex: Map<string, FileEntry>;
  hashIndex: Map<string, FileEntry>;
}

export interface DedupResult {
  hardlinked: number;
  copied: number;
  unchanged: number;
  /** Normalized relative path (`toDedupeKey`) → SHA-256. */
  hashes: Map<string, string>;
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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
): Promise<DedupResult> {
  const files = activeFiles ? [...activeFiles] : await collectFiles(activeDir);
  const index = buildContentIndex(previousManifest);
  const hashes = new Map<string, string>();

  const modes = await mapWithConcurrency(
    files,
    DEDUP_CONCURRENCY,
    async (relativePath): Promise<DeduplicationMode | null> => {
      const key = toDedupeKey(relativePath);
      const activePath = path.join(activeDir, relativePath);
      const sha256 = await computeFileSha256(activePath);
      hashes.set(key, sha256);

      if (!previousSnapshotDir) return null;

      const match = findMatch(index, key, sha256);
      if (!match) return null;

      const sourcePath = path.join(previousSnapshotDir, match.path);
      if (path.resolve(sourcePath) === path.resolve(activePath)) return null;
      if (!(await fileExists(sourcePath))) return null;

      await fs.rm(activePath, { force: true });
      return hardlinkOrCopy(sourcePath, activePath);
    },
  );

  let hardlinked = 0;
  let copied = 0;
  let unchanged = 0;

  for (const mode of modes) {
    if (mode === 'hardlink') hardlinked += 1;
    else if (mode === 'copy') copied += 1;
    else unchanged += 1;
  }

  return { hardlinked, copied, unchanged, hashes };
}
