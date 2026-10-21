/**
 * Step 1D — Deduplication Engine
 *
 * Replaces files in the active export with hardlinks to the previous snapshot
 * where content is identical.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as nodePath from 'path';
import { hardlinkOrCopy, toDedupeKey, mapWithConcurrency, computeFileSha256 } from './platform';
import { readManifest, Manifest, FileEntry, DeduplicationMode } from './manifest';

export interface DedupResult {
  hardlinked: number;
  copied: number;
  unchanged: number;
}

/**
 * Compute the SHA-256 hex digest of a file.
 */
export async function computeSha256(filePath: string): Promise<string> {
  return computeFileSha256(filePath);
}

/**
 * Determine the overall deduplication mode for the snapshot manifest.
 */
export function getDeduplicationMode(result: DedupResult): DeduplicationMode {
  if (result.hardlinked > 0) return 'hardlink';
  if (result.copied > 0) return 'copy';
  return 'none';
}

/**
 * Recursively collect all file paths under `dir`.
 * Skips `manifest.json` and temporary `.tmp` files.
 */
export async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  const files: string[] = [];

  for (const name of entries) {
    if (name === 'manifest.json' || name.endsWith('.tmp')) {
      continue;
    }

    const fullPath = nodePath.join(dir, name);
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory()) {
      const nested = await collectFiles(fullPath);
      files.push(...nested);
    } else if (stat.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Replace files in `activeDir` with hardlinks to `lastSnapshotDir` where content
 * is identical, falling back to file copying if hardlinks are unsupported.
 *
 * @param activeDir Directory containing the fresh export
 * @param lastSnapshotDir Path to the previous snapshot directory (optional)
 * @param previousManifest Optional pre-parsed manifest from the previous snapshot
 * @returns Counts of hardlinked, copied, and unchanged files
 */
export interface ContentIndex {
  pathIndex: Map<string, FileEntry>;
  hashIndex: Map<string, FileEntry>;
}

/**
 * Build a content-addressed index of a previous snapshot manifest exactly once.
 * `pathIndex` maps a normalized relative path to its manifest entry.
 * `hashIndex` maps a SHA-256 digest to a manifest entry (content-addressed).
 */
export function buildContentIndex(manifest: Manifest): ContentIndex {
  const pathIndex = new Map<string, FileEntry>();
  const hashIndex = new Map<string, FileEntry>();

  for (const entry of manifest.files) {
    const key = toDedupeKey(entry.path);
    if (!pathIndex.has(key)) {
      pathIndex.set(key, entry);
    }
    if (!hashIndex.has(entry.sha256)) {
      hashIndex.set(entry.sha256, entry);
    }
  }

  return { pathIndex, hashIndex };
}

export async function dedup(
  activeDir: string,
  lastSnapshotDir?: string | null,
  previousManifest?: Manifest | null,
  activeFiles?: string[] | null,
): Promise<DedupResult> {
  const result: DedupResult = {
    hardlinked: 0,
    copied: 0,
    unchanged: 0,
  };

  // Check if activeDir exists
  try {
    const stat = await fs.stat(activeDir);
    if (!stat.isDirectory()) {
      return result;
    }
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return result;
    }
    throw err;
  }

  // 1. Walk all files in activeDir recursively (or reuse a pre-collected list)
  const resolvedActiveFiles = activeFiles && activeFiles.length > 0
    ? [...activeFiles]
    : await collectFiles(activeDir);
  const activeFileList = resolvedActiveFiles.sort((a, b) => a.localeCompare(b));

  if (activeFileList.length === 0) {
    return result;
  }

  // Load previous manifest if not supplied directly
  let prevManifest = previousManifest;
  if (prevManifest === undefined && lastSnapshotDir) {
    prevManifest = await readManifest(lastSnapshotDir);
  }

  // If no previous snapshot or manifest, keep all files as-is
  if (!prevManifest || !lastSnapshotDir || !Array.isArray(prevManifest.files) || prevManifest.files.length === 0) {
    result.unchanged = activeFileList.length;
    return result;
  }

  // Build a content-addressed index of the previous snapshot exactly once per run.
  const { pathIndex, hashIndex } = buildContentIndex(prevManifest);

  // Compute SHA-256 for all active files in parallel (bounded concurrency)
  const activeHashes = await mapWithConcurrency(activeFileList, 4, (filePath) =>
    computeSha256(filePath),
  );
  const hashMap = new Map<string, string>(
    activeFileList.map((filePath, index) => [filePath, activeHashes[index]]),
  );

  for (const activeFilePath of activeFileList) {
    const relPath = nodePath.relative(activeDir, activeFilePath).replace(/\\/g, '/');
    const sha256 = hashMap.get(activeFilePath)!;
    const key = toDedupeKey(relPath);

    let match: FileEntry | null = null;

    // 4. Look up path in previous snapshot manifest:
    //    - Same path + same hash → hardlink to previous snapshot's file
    //    - Different path but same hash → hardlink to that file (content-addressed fallback)
    //    - No match → keep as-is (new or changed file)
    const pathMatch = pathIndex.get(key);
    if (pathMatch && pathMatch.sha256 === sha256) {
      match = pathMatch;
    } else if (hashIndex.has(sha256)) {
      match = hashIndex.get(sha256)!;
    }

    if (!match) {
      // No match: keep as-is (new or changed file)
      result.unchanged++;
      continue;
    }

    const prevFilePath = nodePath.join(lastSnapshotDir, match.path);

    // Prevent replacing if the paths resolve to the exact same file
    if (nodePath.resolve(prevFilePath) === nodePath.resolve(activeFilePath)) {
      result.unchanged++;
      continue;
    }

    // Ensure the source file in previous snapshot actually exists on disk
    try {
      await fs.access(prevFilePath);
    } catch {
      // Missing source file in previous snapshot; keep active file as-is
      result.unchanged++;
      continue;
    }

    // 5. Use hardlinkOrCopy — remove the active file and link or copy from previous snapshot
    try {
      await fs.unlink(activeFilePath);
    } catch {
      result.unchanged++;
      continue;
    }

    try {
      const mode = await hardlinkOrCopy(prevFilePath, activeFilePath);
      if (mode === 'hardlink') {
        result.hardlinked++;
      } else {
        result.copied++;
      }
    } catch (err) {
      // Attempt recovery by copying original content from prevFilePath if linking failed unexpectedly
      try {
        await fs.copyFile(prevFilePath, activeFilePath);
        result.copied++;
      } catch {
        throw err;
      }
    }
  }

  return result;
}
