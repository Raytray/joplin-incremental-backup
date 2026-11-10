import fs from 'fs/promises';
import path from 'path';
import {
  errorCode,
  hashFile,
  isHardlinkUnsupportedError,
  mapWithConcurrency,
  toDedupeKey,
  toManifestKey,
} from './platform';
import type { FileDigest } from './platform';
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
  /**
   * Matched files left as full copies because the filesystem cannot hardlink.
   * Nothing is copied: the exported file is already identical to the match.
   */
  copied: number;
  unchanged: number;
  /** Files that could not be hardlinked on a filesystem that supports links; the exported file was kept. */
  failed: number;
  /** Normalized relative path (`toManifestKey`) → SHA-256. */
  hashes: Map<string, string>;
  /** Normalized relative path (`toManifestKey`) → size in bytes, as hashed. */
  sizes: Map<string, number>;
}

export interface DedupOptions {
  /** Injectable hasher (used by tests); defaults to `hashFile`. */
  hashFile?: (filePath: string) => Promise<FileDigest>;
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
 * Replace `activePath` with a hardlink to `sourcePath` without ever leaving the
 * destination missing.
 *
 * The link is staged under a temporary name in the same directory and then
 * swapped in with a rename. If anything fails the freshly exported file stays
 * exactly where it is — only the space saving is lost, never the data.
 *
 * Returns `'copy'` when the filesystem cannot hardlink. The exported file is
 * then left untouched: it is already a byte-identical full copy, so copying the
 * previous snapshot's file over it would only cost I/O.
 */
export async function replaceWithLink(
  sourcePath: string,
  activePath: string,
): Promise<'hardlink' | 'copy'> {
  const tempPath = `${activePath}${DEDUP_TEMP_SUFFIX}`;
  await fs.rm(tempPath, { force: true });

  try {
    await fs.link(sourcePath, tempPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    if (isHardlinkUnsupportedError(error)) return 'copy';
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
    // Windows can refuse to rename onto an existing file. The staged link is
    // ready, so removing the destination is safe.
    await fs.rm(activePath, { force: true });
    try {
      await fs.rename(tempPath, activePath);
    } catch (renameError) {
      await fs.rm(tempPath, { force: true });
      throw renameError;
    }
  }

  return 'hardlink';
}

/**
 * Whether hardlinks work between `sourcePath` and `dir`, tested with files this
 * process owns. A link failure on one matched file can be per-file (Linux
 * returns EPERM under protected_hardlinks for files owned by another user), so
 * a failed probe is confirmed here before linking is turned off for the run.
 */
export async function canHardlink(sourcePath: string, dir: string): Promise<boolean> {
  const [source, target] = await Promise.all([fs.stat(sourcePath), fs.stat(dir)]);
  if (source.dev !== target.dev) return false;

  const probePath = path.join(
    dir,
    `.hardlink_probe_${process.pid}_${Math.random().toString(36).slice(2, 8)}${DEDUP_TEMP_SUFFIX}`,
  );
  const linkPath = `${probePath}.link`;
  try {
    await fs.writeFile(probePath, '');
    await fs.link(probePath, linkPath);
    return true;
  } catch (error) {
    if (isHardlinkUnsupportedError(error)) return false;
    throw error;
  } finally {
    await fs.rm(linkPath, { force: true });
    await fs.rm(probePath, { force: true });
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
  activeFiles: readonly string[],
  options: DedupOptions = {},
): Promise<DedupResult> {
  const files = [...activeFiles];
  const index = buildContentIndex(previousManifest);
  const hashes = new Map<string, string>();
  const sizes = new Map<string, number>();
  const digest = options.hashFile ?? ((filePath: string) => hashFile(filePath));
  /**
   * Resolves to whether hardlinks work on this filesystem, settled by the
   * first link attempt of the run. Every later file waits for it, so an
   * unsupported filesystem costs one failed probe, not one per file.
   */
  let linkSupport: Promise<boolean> | null = null;

  const modes = await mapWithConcurrency(
    files,
    DEDUP_CONCURRENCY,
    async (relativePath): Promise<DeduplicationMode | 'failed' | null> => {
      const key = toManifestKey(relativePath);
      const activePath = path.join(activeDir, relativePath);
      const { sha256, size } = await digest(activePath);
      hashes.set(key, sha256);
      sizes.set(key, size);

      if (!previousSnapshotDir) return null;

      const match = findMatch(index, toDedupeKey(relativePath), sha256);
      if (!match) return null;

      const sourcePath = path.join(previousSnapshotDir, match.path);
      if (path.resolve(sourcePath) === path.resolve(activePath)) return null;
      if (!(await fileExists(sourcePath))) return null;

      try {
        let mode: 'hardlink' | 'copy';
        if (linkSupport) {
          // The exported file is identical to the match and stays as a full copy.
          if (!(await linkSupport)) return 'copy';
          mode = await replaceWithLink(sourcePath, activePath);
        } else {
          // First link of the run: it decides for everyone else. An
          // "unsupported" result is confirmed with canHardlink before linking
          // is turned off; any other error is per-file and counts as supported.
          const probe = replaceWithLink(sourcePath, activePath);
          linkSupport = probe
            .then(
              (result) =>
                result === 'hardlink' || canHardlink(sourcePath, path.dirname(activePath)),
            )
            .catch(() => true);
          mode = await probe;
        }
        if (mode === 'hardlink') return mode;
        if (!(await linkSupport)) return 'copy';
        throw new Error('The filesystem supports hardlinks, but this file could not be linked.');
      } catch (error) {
        // The exported file is still in place and has the recorded hash, so the
        // snapshot stays correct — only the deduplication is lost.
        logger.warn(`Could not deduplicate "${relativePath}"; keeping the exported copy.`, error);
        return 'failed';
      }
    },
  );

  return { ...countModes(modes), hashes, sizes };
}

function countModes(
  modes: ReadonlyArray<DeduplicationMode | 'failed' | null>,
): Omit<DedupResult, 'hashes' | 'sizes'> {
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

  return { hardlinked, copied, unchanged, failed };
}

/** Create `targetDir` and a copy of every directory under `sourceDir` in it, without files. */
async function mirrorDirectories(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await mirrorDirectories(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
    }
  }
}

/**
 * Build `targetDir` from an export staged in `localDir`: each file identical
 * to one in the previous snapshot is hardlinked to it, and every other file is
 * copied from `localDir`. Only new or changed content is written to the
 * target's drive.
 *
 * Hashes are computed on the local copies. When the target cannot hardlink,
 * matched files are copied too (`copied`); a link that fails on a filesystem
 * that supports links is also copied, and counted as `failed`.
 */
export async function stageFromLocal(
  localDir: string,
  targetDir: string,
  previousSnapshotDir: string | null,
  previousManifest: Manifest | null,
  files: readonly string[],
  options: DedupOptions = {},
): Promise<DedupResult> {
  const index = buildContentIndex(previousManifest);
  const hashes = new Map<string, string>();
  const sizes = new Map<string, number>();
  const digest = options.hashFile ?? ((filePath: string) => hashFile(filePath));
  /** Settled by the first link attempt of the run, as in `dedup`. */
  let linkSupport: Promise<boolean> | null = null;

  // Mirror every directory of the export, empty ones included (the RAW
  // exporter always creates `resources/`), so the snapshot has the same layout
  // as one staged on the backup drive.
  await mirrorDirectories(localDir, targetDir);

  const modes = await mapWithConcurrency(
    files,
    DEDUP_CONCURRENCY,
    async (relativePath): Promise<DeduplicationMode | 'failed' | null> => {
      const key = toManifestKey(relativePath);
      const localPath = path.join(localDir, relativePath);
      const targetPath = path.join(targetDir, relativePath);
      const { sha256, size } = await digest(localPath);
      hashes.set(key, sha256);
      sizes.set(key, size);

      const match = previousSnapshotDir
        ? findMatch(index, toDedupeKey(relativePath), sha256)
        : null;
      const sourcePath =
        match && previousSnapshotDir ? path.join(previousSnapshotDir, match.path) : null;
      if (!sourcePath || !(await fileExists(sourcePath))) {
        await fs.copyFile(localPath, targetPath);
        return null;
      }

      if (linkSupport && !(await linkSupport)) {
        await fs.copyFile(localPath, targetPath);
        return 'copy';
      }

      let linkError: unknown = null;
      if (linkSupport) {
        linkError = await fs.link(sourcePath, targetPath).then(
          () => null,
          (error: unknown) => error,
        );
      } else {
        // First link of the run: it decides for everyone else. An
        // "unsupported" error is confirmed with canHardlink before linking is
        // turned off; any other error is per-file and counts as supported.
        const attempt = fs.link(sourcePath, targetPath).then(
          () => null,
          (error: unknown) => error,
        );
        linkSupport = attempt
          .then(
            (error) =>
              error === null ||
              !isHardlinkUnsupportedError(error) ||
              canHardlink(sourcePath, path.dirname(targetPath)),
          )
          .catch(() => true);
        linkError = await attempt;
      }
      if (linkError === null) return 'hardlink';

      await fs.copyFile(localPath, targetPath);
      if (!(await linkSupport)) return 'copy';
      logger.warn(`Could not hardlink "${relativePath}"; copied it instead.`, linkError);
      return 'failed';
    },
  );

  return { ...countModes(modes), hashes, sizes };
}
