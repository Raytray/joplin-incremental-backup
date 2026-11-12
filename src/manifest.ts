import fs from 'fs/promises';
import path from 'path';
import { atomicWriteFile, hashFile, ifExists, mapWithConcurrency, toManifestKey } from './platform';

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
  /*
   * Digests: SHA-256 over the sorted `id:updated_time` pairs of each item type
   * (and the `tagId:noteId` links). Unlike a max timestamp they also catch
   * changes that arrive with an *older* timestamp — e.g. an edit made on
   * another device that syncs in after a newer local edit — as well as
   * deletions and additions that leave counts unchanged.
   *
   * They are optional so manifests written by older versions still validate;
   * a missing digest never matches, which costs one extra snapshot after
   * upgrading.
   */
  noteDigest?: string;
  resourceDigest?: string;
  folderDigest?: string;
  tagDigest?: string;
  /**
   * Tagging a note changes neither the note's nor the tag's `updated_time`,
   * so the links are hashed directly. Only collected when skip-on-unchanged
   * is enabled.
   */
  noteTagDigest?: string;
}

export const FINGERPRINT_DIGEST_KEYS = [
  'noteDigest',
  'resourceDigest',
  'folderDigest',
  'tagDigest',
  'noteTagDigest',
] as const;

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
    typeof fingerprint.maxResourceUpdatedTime === 'number' &&
    FINGERPRINT_DIGEST_KEYS.every(
      (key) => fingerprint[key] === undefined || typeof fingerprint[key] === 'string',
    )
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

  const raw = await ifExists(fs.readFile(manifestPath, 'utf8'));
  if (raw === null) return null;

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

/**
 * Build the manifest for the files of `snapshotDir` in `fileList` (paths
 * relative to it, with their sizes). Files with a hash in `precomputedHashes`
 * (from `dedup()`) are not read again; the others are hashed.
 */
export async function buildManifest(
  snapshotDir: string,
  meta: ManifestMeta,
  fileList: readonly { path: string; size: number }[],
  precomputedHashes?: ReadonlyMap<string, string>,
): Promise<Manifest> {
  const entries = fileList.map((entry) => ({ path: toManifestKey(entry.path), size: entry.size }));
  const uniqueSortedEntries = [...new Map(entries.map((e) => [e.path, e])).values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  const files = await mapWithConcurrency(
    uniqueSortedEntries,
    MANIFEST_HASH_CONCURRENCY,
    async ({ path: relativePath, size }): Promise<FileEntry> => {
      const absolutePath = path.join(snapshotDir, relativePath);
      const precomputed = precomputedHashes?.get(toManifestKey(relativePath));
      const sha256 = precomputed ?? (await hashFile(absolutePath, size)).sha256;
      return { path: relativePath, size, sha256 };
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
