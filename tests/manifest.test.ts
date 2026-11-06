import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return { default: memfs.fs.promises, ...memfs.fs.promises };
});

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { vol } from 'memfs';
import {
  buildManifest,
  isValidManifest,
  MANIFEST_FILENAME,
  readManifest,
  writeManifest,
} from '../src/manifest';
import type { ManifestMeta } from '../src/manifest';

const SNAPSHOT = '/snapshots/20260101T000000';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function meta(): ManifestMeta {
  return {
    snapshotId: '20260101T000000',
    joplinVersion: '3.7.0',
    changeFingerprint: {
      maxNoteUpdatedTime: 1_700_000_000_000,
      noteCount: 2,
      maxResourceUpdatedTime: 1_600_000_000_000,
    },
  };
}

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(SNAPSHOT, { recursive: true });
});

describe('readManifest', () => {
  it('returns null when the manifest is missing', async () => {
    await expect(readManifest(SNAPSHOT)).resolves.toBeNull();
    await expect(readManifest('/does/not/exist')).resolves.toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    await fs.writeFile(path.join(SNAPSHOT, MANIFEST_FILENAME), '{not json');
    await expect(readManifest(SNAPSHOT)).resolves.toBeNull();
  });

  it('returns null for a structurally invalid manifest', async () => {
    await fs.writeFile(path.join(SNAPSHOT, MANIFEST_FILENAME), JSON.stringify({ version: 1 }));
    await expect(readManifest(SNAPSHOT)).resolves.toBeNull();
  });
});

describe('writeManifest / readManifest', () => {
  it('round-trips a manifest', async () => {
    await fs.writeFile(path.join(SNAPSHOT, 'note.md'), 'hello');
    const manifest = await buildManifest(SNAPSHOT, meta());

    await writeManifest(SNAPSHOT, manifest);

    await expect(readManifest(SNAPSHOT)).resolves.toEqual(manifest);
  });
});

describe('buildManifest', () => {
  it('produces the correct file count, sizes, and hashes', async () => {
    await fs.mkdir(path.join(SNAPSHOT, 'sub'), { recursive: true });
    await fs.writeFile(path.join(SNAPSHOT, 'a.txt'), 'hello');
    await fs.writeFile(path.join(SNAPSHOT, 'sub', 'b.txt'), 'world!');

    const manifest = await buildManifest(SNAPSHOT, meta());

    expect(manifest.fileCount).toBe(2);
    expect(manifest.files.map((file) => file.path)).toEqual(['a.txt', 'sub/b.txt']);

    const a = manifest.files.find((file) => file.path === 'a.txt');
    const b = manifest.files.find((file) => file.path === 'sub/b.txt');
    expect(a).toEqual({ path: 'a.txt', size: 5, sha256: sha256('hello') });
    expect(b).toEqual({ path: 'sub/b.txt', size: 6, sha256: sha256('world!') });
    expect(manifest.deduplication).toBe('none');
    expect(manifest.lastChangeTime).toBe(meta().changeFingerprint.maxNoteUpdatedTime);
  });

  it('reuses precomputed hashes instead of re-reading files', async () => {
    await fs.writeFile(path.join(SNAPSHOT, 'a.txt'), 'hello');

    const precomputed = new Map([['a.txt', 'deadbeef']]);
    const manifest = await buildManifest(SNAPSHOT, meta(), ['a.txt'], precomputed);

    expect(manifest.files).toEqual([{ path: 'a.txt', size: 5, sha256: 'deadbeef' }]);
  });

  it('sorts and de-duplicates the provided paths', async () => {
    await fs.writeFile(path.join(SNAPSHOT, 'b.txt'), 'b');
    await fs.writeFile(path.join(SNAPSHOT, 'a.txt'), 'a');

    const manifest = await buildManifest(SNAPSHOT, meta(), ['b.txt', 'a.txt', 'a.txt']);

    expect(manifest.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt']);
  });
});

describe('isValidManifest', () => {
  it('accepts a complete manifest', async () => {
    await fs.writeFile(path.join(SNAPSHOT, 'a.txt'), 'a');
    const manifest = await buildManifest(SNAPSHOT, meta());
    expect(isValidManifest(manifest)).toBe(true);
  });

  it('rejects null and incomplete objects', () => {
    expect(isValidManifest(null)).toBe(false);
    expect(isValidManifest({})).toBe(false);
    expect(isValidManifest({ snapshotId: 'x', files: 'nope' })).toBe(false);
  });

  it('rejects a manifest with an invalid fingerprint', async () => {
    await fs.writeFile(path.join(SNAPSHOT, 'a.txt'), 'a');
    const manifest = await buildManifest(SNAPSHOT, meta());
    expect(isValidManifest({ ...manifest, changeFingerprint: { noteCount: 1 } })).toBe(false);
  });

  it('accepts a legacy fingerprint without digests', async () => {
    await fs.writeFile(path.join(SNAPSHOT, 'a.txt'), 'a');
    const manifest = await buildManifest(SNAPSHOT, meta());
    const { maxNoteUpdatedTime, noteCount, maxResourceUpdatedTime } = manifest.changeFingerprint;
    expect(
      isValidManifest({
        ...manifest,
        changeFingerprint: { maxNoteUpdatedTime, noteCount, maxResourceUpdatedTime },
      }),
    ).toBe(true);
  });

  it('rejects a fingerprint whose digests have the wrong type', async () => {
    await fs.writeFile(path.join(SNAPSHOT, 'a.txt'), 'a');
    const manifest = await buildManifest(SNAPSHOT, meta());
    for (const bad of [{ noteTagDigest: 123 }, { folderDigest: null }, { noteDigest: ['x'] }]) {
      expect(
        isValidManifest({
          ...manifest,
          changeFingerprint: { ...manifest.changeFingerprint, ...bad },
        }),
      ).toBe(false);
    }
  });
});
