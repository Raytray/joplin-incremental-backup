/**
 * Step 1C — Manifest
 *
 * Tracks snapshot state and per-file integrity data (SHA-256 hashes, file sizes).
 * Provides functions to build, read, and atomically write snapshot manifests.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as nodePath from 'path';
import { atomicWriteFile, mapWithConcurrency, computeFileSha256 } from './platform';

export interface FileEntry {
  /** Relative path within snapshot (forward-slash normalized) */
  path: string;
  /** File size in bytes */
  size: number;
  /** SHA-256 hex digest of file contents */
  sha256: string;
}

export type DeduplicationMode = 'hardlink' | 'copy' | 'none';

export interface Manifest {
  /** ISO timestamp string representing the snapshot identifier */
  snapshotId: string;
  /** Creation time as Unix timestamp in milliseconds */
  createdAt: number;
  /** Version of Joplin that generated or is associated with the snapshot */
  joplinVersion: string;
  /** Last detected data change time (Unix ms) */
  lastChangeTime: number;
  /** Total number of files tracked in the snapshot */
  fileCount: number;
  /** Array of file entries with path, size, and sha256 */
  files: FileEntry[];
  /** Deduplication strategy used for this snapshot */
  deduplication: DeduplicationMode;
}

export interface BuildManifestMeta {
  snapshotId?: string;
  createdAt?: number;
  joplinVersion?: string;
  lastChangeTime?: number;
  deduplication?: DeduplicationMode;
}

const MANIFEST_FILENAME = 'manifest.json';

/**
 * Validate that an unknown value conforms to the Manifest interface.
 */
export function isValidManifest(obj: unknown): obj is Manifest {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }

  const m = obj as Record<string, unknown>;

  if (typeof m.snapshotId !== 'string') return false;
  if (typeof m.createdAt !== 'number' || isNaN(m.createdAt)) return false;
  if (typeof m.joplinVersion !== 'string') return false;
  if (typeof m.lastChangeTime !== 'number' || isNaN(m.lastChangeTime)) return false;
  if (typeof m.fileCount !== 'number' || isNaN(m.fileCount)) return false;
  if (!Array.isArray(m.files)) return false;
  if (m.deduplication !== 'hardlink' && m.deduplication !== 'copy' && m.deduplication !== 'none') {
    return false;
  }

  for (const f of m.files) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
    const fe = f as Record<string, unknown>;
    if (typeof fe.path !== 'string') return false;
    if (typeof fe.size !== 'number' || isNaN(fe.size)) return false;
    if (typeof fe.sha256 !== 'string') return false;
  }

  return true;
}

/**
 * Read and parse `manifest.json` from the specified snapshot directory.
 * Returns `null` if the file is missing, unreadable, or malformed.
 */
export async function readManifest(snapshotDir: string): Promise<Manifest | null> {
  const manifestPath = nodePath.join(snapshotDir, MANIFEST_FILENAME);
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isValidManifest(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Atomically write `manifest` to `manifest.json` in `snapshotDir`.
 * Uses `atomicWriteFile` from `platform.ts` for crash and cross-platform safety.
 */
export async function writeManifest(
  snapshotDir: string,
  manifest: Manifest,
): Promise<void> {
  const manifestPath = nodePath.join(snapshotDir, MANIFEST_FILENAME);
  const content = JSON.stringify(manifest, null, 2);
  await atomicWriteFile(manifestPath, content);
}

/**
 * Recursively walk `dir` and collect file entries with SHA-256 digests.
 * Ignores `manifest.json` and temporary `.tmp` files.
 */
async function collectFilePaths(
  dir: string,
  baseDir: string = dir,
): Promise<string[]> {
  const entries = await fs.readdir(dir);
  const paths: string[] = [];

  for (const name of entries) {
    if (name === MANIFEST_FILENAME || name.endsWith('.tmp')) {
      continue;
    }

    const fullPath = nodePath.join(dir, name);
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory()) {
      const nested = await collectFilePaths(fullPath, baseDir);
      paths.push(...nested);
    } else if (stat.isFile()) {
      paths.push(fullPath);
    }
  }

  return paths;
}

async function collectFiles(
  dir: string,
  baseDir: string = dir,
): Promise<FileEntry[]> {
  const filePaths = await collectFilePaths(dir, baseDir);

  // Hash files in parallel with bounded concurrency
  const entries = await mapWithConcurrency(filePaths, 4, async (fullPath) => {
    const stat = await fs.stat(fullPath);
    const content = await fs.readFile(fullPath);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const relativePath = nodePath.relative(baseDir, fullPath).replace(/\\/g, '/');
    return {
      path: relativePath,
      size: stat.size,
      sha256,
    } as FileEntry;
  });

  return entries;
}

async function collectFilesFromPaths(
  filePaths: string[],
  baseDir: string,
): Promise<FileEntry[]> {
  return mapWithConcurrency(filePaths, 4, async (fullPath) => {
    const stat = await fs.stat(fullPath);
    const sha256 = await computeFileSha256(fullPath);
    const relativePath = nodePath.relative(baseDir, fullPath).replace(/\\/g, '/');
    return {
      path: relativePath,
      size: stat.size,
      sha256,
    } as FileEntry;
  });
}

/**
 * Walk `snapshotDir`, compute SHA-256 and size for each file, and construct
 * a complete `Manifest`.
 */
export async function buildManifest(
  snapshotDir: string,
  meta?: BuildManifestMeta,
  filePaths?: string[] | null,
): Promise<Manifest> {
  const files =
    filePaths && filePaths.length > 0
      ? await collectFilesFromPaths(filePaths, snapshotDir)
      : await collectFiles(snapshotDir, snapshotDir);

  // Sort files by path for deterministic ordering
  files.sort((a, b) => a.path.localeCompare(b.path));

  const now = Date.now();
  const snapshotId = meta?.snapshotId ?? new Date(now).toISOString();
  const createdAt = meta?.createdAt ?? now;
  const joplinVersion = meta?.joplinVersion ?? '';
  const lastChangeTime = meta?.lastChangeTime ?? 0;
  const deduplication = meta?.deduplication ?? 'none';

  return {
    snapshotId,
    createdAt,
    joplinVersion,
    lastChangeTime,
    fileCount: files.length,
    files,
    deduplication,
  };
}
