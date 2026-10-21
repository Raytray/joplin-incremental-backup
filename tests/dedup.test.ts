import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return { default: memfs.fs.promises, ...memfs.fs.promises };
});

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { vol } from 'memfs';
import { buildContentIndex, dedup, getDeduplicationMode } from '../src/dedup';
import type { FileEntry, Manifest } from '../src/manifest';

const PREVIOUS = '/snapshots/20260101T000000';
const ACTIVE = '/export/active';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeManifest(files: Array<{ path: string; content: string }>): Manifest {
  const entries: FileEntry[] = files.map((file) => ({
    path: file.path,
    size: Buffer.byteLength(file.content),
    sha256: sha256(file.content),
  }));

  return {
    snapshotId: '20260101T000000',
    createdAt: 0,
    joplinVersion: '3.7.0',
    lastChangeTime: 0,
    changeFingerprint: {
      maxNoteUpdatedTime: 0,
      noteCount: files.length,
      maxResourceUpdatedTime: 0,
    },
    fileCount: entries.length,
    files: entries,
    deduplication: 'none',
  };
}

async function writeFiles(root: string, files: Array<{ path: string; content: string }>) {
  for (const file of files) {
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }
}

beforeEach(async () => {
  vol.reset();
  await fs.mkdir(PREVIOUS, { recursive: true });
  await fs.mkdir(ACTIVE, { recursive: true });
});

describe('buildContentIndex', () => {
  it('builds path and hash indexes', () => {
    const manifest = makeManifest([
      { path: 'a.txt', content: 'a' },
      { path: 'b.txt', content: 'b' },
    ]);

    const index = buildContentIndex(manifest);

    expect(index.pathIndex.get('a.txt')?.sha256).toBe(sha256('a'));
    expect(index.hashIndex.get(sha256('b'))?.path).toBe('b.txt');
  });

  it('handles a missing manifest', () => {
    const index = buildContentIndex(null);
    expect(index.pathIndex.size).toBe(0);
    expect(index.hashIndex.size).toBe(0);
  });
});

describe('dedup', () => {
  it('hardlinks an identical file and increments hardlinked', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'hello' }]);
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'hello' }]);
    const manifest = makeManifest([{ path: 'a.txt', content: 'hello' }]);

    const result = await dedup(ACTIVE, PREVIOUS, manifest, ['a.txt']);

    expect(result).toMatchObject({ hardlinked: 1, copied: 0, unchanged: 0 });
    expect(result.hashes.get('a.txt')).toBe(sha256('hello'));
    expect(await fs.readFile(path.join(ACTIVE, 'a.txt'), 'utf8')).toBe('hello');
  });

  it('keeps a changed file and increments unchanged', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'old' }]);
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'new' }]);
    const manifest = makeManifest([{ path: 'a.txt', content: 'old' }]);

    const result = await dedup(ACTIVE, PREVIOUS, manifest, ['a.txt']);

    expect(result).toMatchObject({ hardlinked: 0, copied: 0, unchanged: 1 });
    expect(await fs.readFile(path.join(ACTIVE, 'a.txt'), 'utf8')).toBe('new');
  });

  it('keeps a new file and increments unchanged', async () => {
    await writeFiles(ACTIVE, [{ path: 'new.txt', content: 'brand new' }]);
    const manifest = makeManifest([{ path: 'a.txt', content: 'old' }]);

    const result = await dedup(ACTIVE, PREVIOUS, manifest, ['new.txt']);

    expect(result).toMatchObject({ hardlinked: 0, copied: 0, unchanged: 1 });
  });

  it('copies when fs.link throws EPERM', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'hello' }]);
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'hello' }]);
    const manifest = makeManifest([{ path: 'a.txt', content: 'hello' }]);

    const linkSpy = vi
      .spyOn(fs, 'link')
      .mockRejectedValueOnce(Object.assign(new Error('not permitted'), { code: 'EPERM' }));

    const result = await dedup(ACTIVE, PREVIOUS, manifest, ['a.txt']);

    expect(result).toMatchObject({ hardlinked: 0, copied: 1, unchanged: 0 });
    expect(await fs.readFile(path.join(ACTIVE, 'a.txt'), 'utf8')).toBe('hello');

    linkSpy.mockRestore();
  });

  it('hardlinks via content addressing when only the path differs', async () => {
    await writeFiles(PREVIOUS, [{ path: 'one.txt', content: 'same content' }]);
    await writeFiles(ACTIVE, [{ path: 'two.txt', content: 'same content' }]);
    const manifest = makeManifest([{ path: 'one.txt', content: 'same content' }]);

    const result = await dedup(ACTIVE, PREVIOUS, manifest, ['two.txt']);

    expect(result).toMatchObject({ hardlinked: 1, copied: 0, unchanged: 0 });
    expect(await fs.readFile(path.join(ACTIVE, 'two.txt'), 'utf8')).toBe('same content');
  });

  it('walks the active directory when no file list is provided', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'hello' }]);
    await writeFiles(ACTIVE, [
      { path: 'a.txt', content: 'hello' },
      { path: 'nested/b.txt', content: 'other' },
    ]);
    const manifest = makeManifest([{ path: 'a.txt', content: 'hello' }]);

    const result = await dedup(ACTIVE, PREVIOUS, manifest);

    expect(result).toMatchObject({ hardlinked: 1, copied: 0, unchanged: 1 });
    expect([...result.hashes.keys()].sort()).toEqual(['a.txt', 'nested/b.txt']);
  });

  it('does nothing without a previous snapshot', async () => {
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'hello' }]);

    const result = await dedup(ACTIVE, null, null, ['a.txt']);

    expect(result).toMatchObject({ hardlinked: 0, copied: 0, unchanged: 1 });
  });

  it('skips a match whose source file is missing', async () => {
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'hello' }]);
    const manifest = makeManifest([{ path: 'a.txt', content: 'hello' }]);

    const result = await dedup(ACTIVE, PREVIOUS, manifest, ['a.txt']);

    expect(result).toMatchObject({ hardlinked: 0, copied: 0, unchanged: 1 });
  });
});

describe('getDeduplicationMode', () => {
  it('reports the dominant mode', () => {
    expect(getDeduplicationMode({ hardlinked: 3, copied: 0 })).toBe('hardlink');
    expect(getDeduplicationMode({ hardlinked: 0, copied: 1 })).toBe('copy');
    expect(getDeduplicationMode({ hardlinked: 2, copied: 1 })).toBe('copy');
    expect(getDeduplicationMode({ hardlinked: 0, copied: 0 })).toBe('none');
  });
});
