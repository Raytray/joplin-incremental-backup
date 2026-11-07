import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return { default: memfs.fs.promises, ...memfs.fs.promises };
});

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { vol } from 'memfs';
import {
  buildContentIndex,
  dedup,
  getDeduplicationMode,
  replaceWithLink,
  stageFromLocal,
} from '../src/dedup';
import type { FileEntry, Manifest } from '../src/manifest';
import { logger } from '../src/logger';

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

afterEach(() => {
  vi.restoreAllMocks();
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

  it('copies when fs.link always throws EPERM', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'hello' }]);
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'hello' }]);
    const manifest = makeManifest([{ path: 'a.txt', content: 'hello' }]);

    vi.spyOn(fs, 'link').mockRejectedValue(
      Object.assign(new Error('not permitted'), { code: 'EPERM' }),
    );

    const result = await dedup(ACTIVE, PREVIOUS, manifest, ['a.txt']);

    expect(result).toMatchObject({ hardlinked: 0, copied: 1, unchanged: 0 });
    expect(await fs.readFile(path.join(ACTIVE, 'a.txt'), 'utf8')).toBe('hello');
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

describe('replaceWithLink', () => {
  it('swaps the destination without ever unlinking it first', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'shared' }]);
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'shared' }]);

    const mode = await replaceWithLink(path.join(PREVIOUS, 'a.txt'), path.join(ACTIVE, 'a.txt'));

    expect(mode).toBe('hardlink');
    expect(await fs.readFile(path.join(ACTIVE, 'a.txt'), 'utf8')).toBe('shared');
    // The staging file must not survive the swap.
    expect(
      await fs
        .stat(path.join(ACTIVE, 'a.txt.dedup_tmp'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it('leaves the destination intact when staging fails', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'shared' }]);
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'original' }]);

    const linkSpy = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('boom'), { code: 'EIO' }));

    await expect(
      replaceWithLink(path.join(PREVIOUS, 'a.txt'), path.join(ACTIVE, 'a.txt')),
    ).rejects.toMatchObject({ code: 'EIO' });

    expect(linkSpy).toHaveBeenCalled();

    // The exported file is still there, byte for byte.
    expect(await fs.readFile(path.join(ACTIVE, 'a.txt'), 'utf8')).toBe('original');
    expect(
      await fs
        .stat(path.join(ACTIVE, 'a.txt.dedup_tmp'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it('keeps the exported file untouched when the filesystem refuses to hardlink', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'shared' }]);
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'shared' }]);
    const before = await fs.stat(path.join(ACTIVE, 'a.txt'));

    const linkSpy = vi
      .spyOn(fs, 'link')
      .mockRejectedValueOnce(Object.assign(new Error('not permitted'), { code: 'EPERM' }));
    const copySpy = vi.spyOn(fs, 'copyFile');
    const renameSpy = vi.spyOn(fs, 'rename');

    const mode = await replaceWithLink(path.join(PREVIOUS, 'a.txt'), path.join(ACTIVE, 'a.txt'));

    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(copySpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    expect(mode).toBe('copy');
    const after = await fs.stat(path.join(ACTIVE, 'a.txt'));
    expect(after.ino).toBe(before.ino);
    expect(await fs.readFile(path.join(ACTIVE, 'a.txt'), 'utf8')).toBe('shared');
    expect(
      await fs
        .stat(path.join(ACTIVE, 'a.txt.dedup_tmp'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it('rethrows a link error that is not about filesystem support', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'shared' }]);
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'original' }]);

    vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('exists'), { code: 'EEXIST' }),
    );

    await expect(
      replaceWithLink(path.join(PREVIOUS, 'a.txt'), path.join(ACTIVE, 'a.txt')),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(path.join(ACTIVE, 'a.txt'), 'utf8')).toBe('original');
  });
});

describe('dedup — failure handling', () => {
  it('keeps the exported copy and reports a failure when the swap cannot happen', async () => {
    await writeFiles(PREVIOUS, [{ path: 'a.txt', content: 'hello' }]);
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'hello' }]);
    const manifest = makeManifest([{ path: 'a.txt', content: 'hello' }]);

    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('boom'), { code: 'EIO' }));

    const result = await dedup(ACTIVE, PREVIOUS, manifest, ['a.txt']);

    expect(result).toMatchObject({ hardlinked: 0, copied: 0, unchanged: 0, failed: 1 });
    // The content is still correct, so the manifest hash stays valid.
    expect(await fs.readFile(path.join(ACTIVE, 'a.txt'), 'utf8')).toBe('hello');
    expect(result.hashes.get('a.txt')).toBe(sha256('hello'));
  });

  it('uses the injected hasher', async () => {
    await writeFiles(ACTIVE, [{ path: 'a.txt', content: 'hello' }]);
    const computeHash = vi.fn(async () => 'injected-hash');

    const result = await dedup(ACTIVE, null, null, ['a.txt'], { computeHash });

    expect(computeHash).toHaveBeenCalledTimes(1);
    expect(result.hashes.get('a.txt')).toBe('injected-hash');
  });

  it('keeps case-only-different paths on distinct hash keys', async () => {
    await writeFiles(ACTIVE, [
      { path: 'Note.md', content: 'upper' },
      { path: 'note.md', content: 'lower' },
    ]);

    const result = await dedup(ACTIVE, null, null, ['Note.md', 'note.md']);

    expect(result.hashes.get('Note.md')).toBe(sha256('upper'));
    expect(result.hashes.get('note.md')).toBe(sha256('lower'));
  });
});

describe('dedup — no hardlink support', () => {
  const files = [
    { path: 'a.txt', content: 'one' },
    { path: 'b.txt', content: 'two' },
    { path: 'resources/c', content: 'three' },
  ];

  it('tries to link once per run and rewrites nothing', async () => {
    await writeFiles(PREVIOUS, files);
    await writeFiles(ACTIVE, files);
    const manifest = makeManifest(files);

    const linkSpy = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    const copySpy = vi.spyOn(fs, 'copyFile');

    const result = await dedup(
      ACTIVE,
      PREVIOUS,
      manifest,
      files.map((f) => f.path),
    );

    // One probe on the first match plus one confirming link, not one per file.
    expect(linkSpy).toHaveBeenCalledTimes(2);
    expect(copySpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ hardlinked: 0, copied: 3, unchanged: 0, failed: 0 });
    expect(getDeduplicationMode(result)).toBe('copy');
    for (const file of files) {
      expect(await fs.readFile(path.join(ACTIVE, file.path), 'utf8')).toBe(file.content);
    }
  });

  it('keeps linking after a per-file failure on the first attempt', async () => {
    await writeFiles(PREVIOUS, files);
    await writeFiles(ACTIVE, files);
    const manifest = makeManifest(files);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('too many links'), { code: 'EMLINK' }),
    );

    const result = await dedup(
      ACTIVE,
      PREVIOUS,
      manifest,
      files.map((f) => f.path),
    );

    expect(result).toMatchObject({ hardlinked: 2, copied: 0, failed: 1 });
  });

  it('keeps linking when only the first matched file is refused with EPERM', async () => {
    await writeFiles(PREVIOUS, files);
    await writeFiles(ACTIVE, files);
    const manifest = makeManifest(files);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    // protected_hardlinks: this one file cannot be linked, but our own files can.
    vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('not permitted'), { code: 'EPERM' }),
    );

    const result = await dedup(
      ACTIVE,
      PREVIOUS,
      manifest,
      files.map((f) => f.path),
    );

    expect(result).toMatchObject({ hardlinked: 2, copied: 0, failed: 1 });
    expect(getDeduplicationMode(result)).toBe('hardlink');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The confirmation probe leaves nothing behind.
    expect((await fs.readdir(ACTIVE)).filter((name) => name.includes('probe'))).toEqual([]);
  });

  it('counts a later EPERM as a failure once links are known to work', async () => {
    await writeFiles(PREVIOUS, files);
    await writeFiles(ACTIVE, files);
    const manifest = makeManifest(files);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const realLink = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (String(source).endsWith('b.txt')) {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      }
      return realLink(source, target);
    });

    const result = await dedup(
      ACTIVE,
      PREVIOUS,
      manifest,
      files.map((f) => f.path),
    );

    expect(result).toMatchObject({ hardlinked: 2, copied: 0, failed: 1 });
  });

  it('treats a missing source as unchanged on a filesystem without links', async () => {
    const present = files.slice(0, 2);
    await writeFiles(PREVIOUS, present);
    await writeFiles(ACTIVE, files);
    const manifest = makeManifest(files);

    vi.spyOn(fs, 'link').mockRejectedValue(
      Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
    );

    // Hash the file with the missing source last, so the probe has already
    // settled "unsupported" by the time it is matched.
    const computeHash = async (filePath: string) => {
      const content = await fs.readFile(filePath);
      if (filePath.endsWith('c')) await new Promise((resolve) => setTimeout(resolve, 20));
      return createHash('sha256').update(content).digest('hex');
    };

    const result = await dedup(
      ACTIVE,
      PREVIOUS,
      manifest,
      files.map((f) => f.path),
      { computeHash },
    );

    expect(result).toMatchObject({ hardlinked: 0, copied: 2, unchanged: 1, failed: 0 });
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

describe('stageFromLocal', () => {
  const LOCAL = '/local/staging';
  const TARGET = '/snapshots/_joplin_active_run';

  beforeEach(async () => {
    await fs.mkdir(LOCAL, { recursive: true });
  });

  it('hardlinks unchanged files and copies only new or changed ones', async () => {
    const previous = [
      { path: 'same.md', content: 'same' },
      { path: 'changed.md', content: 'old' },
    ];
    await writeFiles(PREVIOUS, previous);
    await writeFiles(LOCAL, [
      { path: 'same.md', content: 'same' },
      { path: 'changed.md', content: 'new' },
      { path: 'resources/r1', content: 'attachment' },
    ]);
    const copySpy = vi.spyOn(fs, 'copyFile');

    const result = await stageFromLocal(LOCAL, TARGET, PREVIOUS, makeManifest(previous), [
      'same.md',
      'changed.md',
      'resources/r1',
    ]);

    expect(result).toMatchObject({ hardlinked: 1, copied: 0, unchanged: 2, failed: 0 });
    expect(result.hashes.get('changed.md')).toBe(sha256('new'));
    const [linked, original] = await Promise.all([
      fs.stat(path.join(TARGET, 'same.md')),
      fs.stat(path.join(PREVIOUS, 'same.md')),
    ]);
    expect(linked.ino).toBe(original.ino);
    expect(copySpy.mock.calls.map(([source]) => String(source)).sort()).toEqual([
      path.join(LOCAL, 'changed.md'),
      path.join(LOCAL, 'resources/r1'),
    ]);
    expect(await fs.readFile(path.join(TARGET, 'changed.md'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(TARGET, 'resources/r1'), 'utf8')).toBe('attachment');
  });

  it('keeps empty directories of the export, such as resources/', async () => {
    await writeFiles(LOCAL, [{ path: 'a.md', content: 'a' }]);
    await fs.mkdir(path.join(LOCAL, 'resources'));
    await fs.mkdir(path.join(LOCAL, 'nested/empty'), { recursive: true });

    await stageFromLocal(LOCAL, TARGET, null, null, ['a.md']);

    expect((await fs.readdir(TARGET)).sort()).toEqual(['a.md', 'nested', 'resources']);
    expect(await fs.readdir(path.join(TARGET, 'resources'))).toEqual([]);
    expect(await fs.readdir(path.join(TARGET, 'nested'))).toEqual(['empty']);
  });

  it('copies everything when there is no previous snapshot', async () => {
    await writeFiles(LOCAL, [{ path: 'a.md', content: 'a' }]);

    const result = await stageFromLocal(LOCAL, TARGET, null, null, ['a.md']);

    expect(result).toMatchObject({ hardlinked: 0, copied: 0, unchanged: 1 });
    expect(await fs.readFile(path.join(TARGET, 'a.md'), 'utf8')).toBe('a');
  });

  it('copies matched files when the target cannot hardlink, probing only once', async () => {
    const files = [
      { path: 'a.md', content: 'a' },
      { path: 'b.md', content: 'b' },
      { path: 'c.md', content: 'c' },
    ];
    await writeFiles(PREVIOUS, files);
    await writeFiles(LOCAL, files);
    const linkSpy = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }));

    const result = await stageFromLocal(
      LOCAL,
      TARGET,
      PREVIOUS,
      makeManifest(files),
      files.map((f) => f.path),
    );

    expect(result).toMatchObject({ hardlinked: 0, copied: 3, unchanged: 0, failed: 0 });
    // One link attempt plus canHardlink's probe; the other files wait for the verdict.
    expect(linkSpy).toHaveBeenCalledTimes(2);
    for (const file of files) {
      expect(await fs.readFile(path.join(TARGET, file.path), 'utf8')).toBe(file.content);
    }
  });

  it('copies a file whose link fails on a filesystem that supports links, and counts it', async () => {
    const files = [{ path: 'a.md', content: 'a' }];
    await writeFiles(PREVIOUS, files);
    await writeFiles(LOCAL, files);
    vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('protected'), { code: 'EPERM' }),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await stageFromLocal(LOCAL, TARGET, PREVIOUS, makeManifest(files), ['a.md']);

    expect(result).toMatchObject({ hardlinked: 0, copied: 0, failed: 1 });
    expect(await fs.readFile(path.join(TARGET, 'a.md'), 'utf8')).toBe('a');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a.md'), expect.any(Error));
  });

  it('copies a matched file whose previous copy has gone missing', async () => {
    const files = [{ path: 'a.md', content: 'a' }];
    await writeFiles(LOCAL, files);

    const result = await stageFromLocal(LOCAL, TARGET, PREVIOUS, makeManifest(files), ['a.md']);

    expect(result).toMatchObject({ hardlinked: 0, unchanged: 1 });
    expect(await fs.readFile(path.join(TARGET, 'a.md'), 'utf8')).toBe('a');
  });
});
