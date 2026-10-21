import fs from 'fs/promises';
import path from 'path';
import {
  atomicWriteFile,
  collectEntries,
  collectFilesRecursive,
  computeFileSha256,
  mapWithConcurrency,
  toManifestKey,
} from './platform';

export const MANIFEST_FILENAME = 'manifest.json';
const MANIFEST_HASH_CONCURRENCY = 8;

export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}

export type DeduplicationMode = 'hardlink' | 'copy' | 'none';

export interface ChangeFingerprint {
  maxNoteUpdatedTime: number;
  noteCount: number;
  maxResourceUpdatedTime: number;
}

export interface Manifest {
  snapshotId: string;
  createdAt: number;
  joplinVersion: string;
  lastChangeTime: number;
  changeFingerprint: ChangeFingerprint;
  fileCount: number;
  files: FileEntry[];
  deduplication: DeduplicationMode;
}

export interface ManifestMeta {
  snapshotId: string;
  joplinVersion: string;
  changeFingerprint: ChangeFingerprint;
  createdAt?: number;
  lastChangeTime?: number;
  deduplication?: DeduplicationMode;
}

function isFileEntry(value: unknown): value is FileEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === 'string' &&
    typeof entry.size === 'number' &&
    typeof entry.sha256 === 'string'
  );
}

function isValidFingerprint(value: unknown): value is ChangeFingerprint {
  if (typeof value !== 'object' || value === null) return false;
  const fingerprint = value as Record<string, unknown>;
  return (
    typeof fingerprint.maxNoteUpdatedTime === 'number' &&
    typeof fingerprint.noteCount === 'number' &&
    typeof fingerprint.maxResourceUpdatedTime === 'number'
  );
}

export function isValidManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Record<string, unknown>;

  return (
    typeof manifest.snapshotId === 'string' &&
    typeof manifest.createdAt === 'number' &&
    typeof manifest.joplinVersion === 'string' &&
    typeof manifest.lastChangeTime === 'number' &&
    isValidFingerprint(manifest.changeFingerprint) &&
    typeof manifest.fileCount === 'number' &&
    Array.isArray(manifest.files) &&
    manifest.files.every(isFileEntry) &&
    (manifest.deduplication === 'hardlink' ||
      manifest.deduplication === 'copy' ||
      manifest.deduplication === 'none')
  );
}

export async function readManifest(snapshotDir: string): Promise<Manifest | null> {
  const manifestPath = path.join(snapshotDir, MANIFEST_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeManifest(snapshotDir: string, manifest: Manifest): Promise<void> {
  const manifestPath = path.join(snapshotDir, MANIFEST_FILENAME);
  await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function normalizeRelativePath(relativePath: string): string {
  return toManifestKey(relativePath);
}

/** Recursively list files under `dir` as paths relative to `baseDir`. */
export function collectFiles(dir: string, baseDir: string = dir): Promise<string[]> {
  return collectFilesRecursive(dir, baseDir);
}

/** Convert absolute file paths to paths relative to `baseDir`. */
export function collectFilesFromPaths(filePaths: readonly string[], baseDir: string): string[] {
  return filePaths.map((filePath) =>
    normalizeRelativePath(path.isAbsolute(filePath) ? path.relative(baseDir, filePath) : filePath),
  );
}

/**
 * Build a complete manifest for `snapshotDir`. When `precomputedHashes` is
 * supplied (from `dedup()`), matching hashes are reused instead of re-reading
 * every file.
 *
 * `filePaths` can be either plain relative paths (legacy) or objects with
 * `path` and `size`. Supplying sizes avoids a `stat` per file.
 */
export async function buildManifest(
  snapshotDir: string,
  meta: ManifestMeta,
  filePaths?: readonly (string | { path: string; size: number })[],
  precomputedHashes?: ReadonlyMap<string, string>,
): Promise<Manifest> {
  const entries = filePaths
    ? filePaths.map((entry) =>
        typeof entry === 'string'
          ? { path: normalizeRelativePath(entry), size: undefined }
          : { path: normalizeRelativePath(entry.path), size: entry.size },
      )
    : await collectEntries(snapshotDir, snapshotDir);
  const uniqueSortedEntries = [...new Map(entries.map((e) => [e.path, e])).values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  const files = await mapWithConcurrency(
    uniqueSortedEntries,
    MANIFEST_HASH_CONCURRENCY,
    async ({ path: relativePath, size }): Promise<FileEntry> => {
      const absolutePath = path.join(snapshotDir, relativePath);
      const precomputed = precomputedHashes?.get(toManifestKey(relativePath));
      const sha256 = precomputed ?? (await computeFileSha256(absolutePath, size));
      return { path: relativePath, size: size ?? (await fs.stat(absolutePath)).size, sha256 };
    },
  );

  return {
    snapshotId: meta.snapshotId,
    createdAt: meta.createdAt ?? Date.now(),
    joplinVersion: meta.joplinVersion,
    lastChangeTime: meta.lastChangeTime ?? meta.changeFingerprint.maxNoteUpdatedTime,
    changeFingerprint: meta.changeFingerprint,
    fileCount: files.length,
    files,
    deduplication: meta.deduplication ?? 'none',
  };
}
