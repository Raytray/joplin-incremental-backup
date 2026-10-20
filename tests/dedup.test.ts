/**
 * Step 1D tests — Deduplication Engine (src/dedup.ts)
 *
 * Uses memfs to simulate the filesystem so tests are fast, hermetic, and run on any OS.
 */

import { Volume, createFsFromVolume } from 'memfs';
import * as crypto from 'crypto';

const vol = new Volume();
const memFs = createFsFromVolume(vol);
const memFsPromises = memFs.promises;

jest.mock('fs/promises', () => {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === '__esModule') return true;
        return (memFsPromises as unknown as Record<string | symbol, unknown>)[prop];
      },
    },
  );
});

// Import module under test AFTER fs/promises mock is registered
import { dedup, computeSha256, getDeduplicationMode } from '../src/dedup';
import { Manifest } from '../src/manifest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function resetVolume(initialFiles: Record<string, string> = {}): void {
  vol.reset();
  vol.mkdirSync('/data', { recursive: true });

  for (const [filePath, content] of Object.entries(initialFiles)) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir) vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(filePath, content, { encoding: 'utf8' });
  }
}

function createManifest(files: Array<{ path: string; content: string }>): Manifest {
  return {
    snapshotId: '20261020T120000',
    createdAt: Date.now(),
    joplinVersion: '2.14.0',
    lastChangeTime: Date.now(),
    fileCount: files.length,
    files: files.map((f) => ({
      path: f.path,
      size: Buffer.byteLength(f.content, 'utf8'),
      sha256: hash(f.content),
    })),
    deduplication: 'none',
  };
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('Deduplication Engine (dedup)', () => {
  const PREV_DIR = '/data/snapshots/20261020T120000';
  const ACTIVE_DIR = '/data/_joplin_active_';

  beforeEach(() => {
    resetVolume();
  });

  describe('Core Dedup Scenarios', () => {
    it('identical file gets hardlinked; hardlinked count increments', async () => {
      const content = '# Note 1\nHello world';
      const prevManifest = createManifest([{ path: 'note1.md', content }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/note1.md`]: content,
        [`${ACTIVE_DIR}/note1.md`]: content,
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);

      expect(res).toEqual({
        hardlinked: 1,
        copied: 0,
        unchanged: 0,
      });

      // Verify content is preserved
      expect(vol.readFileSync(`${ACTIVE_DIR}/note1.md`, 'utf8')).toBe(content);

      // Verify that active file and previous file share the same inode (hardlink)
      const prevStat = memFs.statSync(`${PREV_DIR}/note1.md`);
      const activeStat = memFs.statSync(`${ACTIVE_DIR}/note1.md`);
      expect(activeStat.ino).toBe(prevStat.ino);
    });

    it('changed file is kept; unchanged count increments', async () => {
      const oldContent = '# Note 1\nOld content';
      const newContent = '# Note 1\nNew content edited';
      const prevManifest = createManifest([{ path: 'note1.md', content: oldContent }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/note1.md`]: oldContent,
        [`${ACTIVE_DIR}/note1.md`]: newContent,
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);

      expect(res).toEqual({
        hardlinked: 0,
        copied: 0,
        unchanged: 1,
      });

      // Verify changed content is retained and inode is distinct
      expect(vol.readFileSync(`${ACTIVE_DIR}/note1.md`, 'utf8')).toBe(newContent);
      const prevStat = memFs.statSync(`${PREV_DIR}/note1.md`);
      const activeStat = memFs.statSync(`${ACTIVE_DIR}/note1.md`);
      expect(activeStat.ino).not.toBe(prevStat.ino);
    });

    it('new file (no prior match) is kept; unchanged count increments', async () => {
      const existingContent = '# Note 1\nExisting note';
      const newFileContent = '# Note 2\nBrand new note';
      const prevManifest = createManifest([{ path: 'note1.md', content: existingContent }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/note1.md`]: existingContent,
        [`${ACTIVE_DIR}/note2.md`]: newFileContent,
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);

      expect(res).toEqual({
        hardlinked: 0,
        copied: 0,
        unchanged: 1,
      });

      expect(vol.readFileSync(`${ACTIVE_DIR}/note2.md`, 'utf8')).toBe(newFileContent);
    });

    it('when fs.link throws EPERM, file is copied and copied count increments', async () => {
      const content = '# Note 1\nIdentical note content';
      const prevManifest = createManifest([{ path: 'note1.md', content }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/note1.md`]: content,
        [`${ACTIVE_DIR}/note1.md`]: content,
      });

      // Mock fs.promises.link to throw EPERM simulating unsupported hardlinks
      const origLink = memFsPromises.link;
      memFsPromises.link = jest.fn().mockRejectedValue(
        Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }),
      ) as typeof memFsPromises.link;

      try {
        const res = await dedup(ACTIVE_DIR, PREV_DIR);

        expect(res).toEqual({
          hardlinked: 0,
          copied: 1,
          unchanged: 0,
        });

        // Content must still be intact
        expect(vol.readFileSync(`${ACTIVE_DIR}/note1.md`, 'utf8')).toBe(content);
      } finally {
        memFsPromises.link = origLink;
      }
    });

    it('hash collision across different paths correctly hardlinks (content-addressed fallback)', async () => {
      const content = '# Shared content\nIdentical across different filenames';
      // In previous snapshot it was named 'original.md'
      const prevManifest = createManifest([{ path: 'sub/original.md', content }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/sub/original.md`]: content,
        // In active export it was renamed to 'renamed.md' in a different directory
        [`${ACTIVE_DIR}/another_dir/renamed.md`]: content,
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);

      expect(res).toEqual({
        hardlinked: 1,
        copied: 0,
        unchanged: 0,
      });

      expect(vol.readFileSync(`${ACTIVE_DIR}/another_dir/renamed.md`, 'utf8')).toBe(content);
      const prevStat = memFs.statSync(`${PREV_DIR}/sub/original.md`);
      const activeStat = memFs.statSync(`${ACTIVE_DIR}/another_dir/renamed.md`);
      expect(activeStat.ino).toBe(prevStat.ino);
    });
  });

  describe('Edge Cases and Fallbacks', () => {
    it('returns all unchanged if lastSnapshotDir is not provided or empty', async () => {
      resetVolume({
        [`${ACTIVE_DIR}/note1.md`]: 'content 1',
        [`${ACTIVE_DIR}/note2.md`]: 'content 2',
      });

      const res = await dedup(ACTIVE_DIR);
      expect(res).toEqual({
        hardlinked: 0,
        copied: 0,
        unchanged: 2,
      });
    });

    it('returns all unchanged if previous snapshot manifest is missing', async () => {
      resetVolume({
        [`${PREV_DIR}/note1.md`]: 'content 1',
        [`${ACTIVE_DIR}/note1.md`]: 'content 1',
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);
      expect(res).toEqual({
        hardlinked: 0,
        copied: 0,
        unchanged: 1,
      });
    });

    it('returns all unchanged if previous snapshot manifest is malformed JSON', async () => {
      resetVolume({
        [`${PREV_DIR}/manifest.json`]: '{ malformed json... }',
        [`${PREV_DIR}/note1.md`]: 'content 1',
        [`${ACTIVE_DIR}/note1.md`]: 'content 1',
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);
      expect(res).toEqual({
        hardlinked: 0,
        copied: 0,
        unchanged: 1,
      });
    });

    it('returns all zero if active directory is empty or does not exist', async () => {
      // Non-existent directory
      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(createManifest([])),
      });

      const resMissing = await dedup(ACTIVE_DIR, PREV_DIR);
      expect(resMissing).toEqual({
        hardlinked: 0,
        copied: 0,
        unchanged: 0,
      });

      // Existing empty directory
      vol.mkdirSync(ACTIVE_DIR, { recursive: true });
      const resEmpty = await dedup(ACTIVE_DIR, PREV_DIR);
      expect(resEmpty).toEqual({
        hardlinked: 0,
        copied: 0,
        unchanged: 0,
      });
    });

    it('handles mixed scenario: hardlinked, unchanged (changed and new files)', async () => {
      const identical = 'Identical content';
      const changedOld = 'Old content';
      const changedNew = 'New modified content';
      const brandNew = 'Brand new file';

      const prevManifest = createManifest([
        { path: 'notes/identical.md', content: identical },
        { path: 'notes/changed.md', content: changedOld },
      ]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/notes/identical.md`]: identical,
        [`${PREV_DIR}/notes/changed.md`]: changedOld,

        [`${ACTIVE_DIR}/notes/identical.md`]: identical,
        [`${ACTIVE_DIR}/notes/changed.md`]: changedNew,
        [`${ACTIVE_DIR}/notes/brand_new.md`]: brandNew,
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);

      expect(res).toEqual({
        hardlinked: 1,
        copied: 0,
        unchanged: 2,
      });
    });

    it('normalizes paths case-insensitively using toDedupeKey', async () => {
      const content = 'Case insensitive test';
      const prevManifest = createManifest([{ path: 'Notes/MyNote.MD', content }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/Notes/MyNote.MD`]: content,
        [`${ACTIVE_DIR}/notes/mynote.md`]: content,
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);

      expect(res).toEqual({
        hardlinked: 1,
        copied: 0,
        unchanged: 0,
      });
    });

    it('retains active file as-is if matched file in previous snapshot is missing from disk', async () => {
      const content = 'File present in manifest but missing on disk';
      const prevManifest = createManifest([{ path: 'ghost.md', content }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        // Notice ghost.md is NOT in PREV_DIR on disk!
        [`${ACTIVE_DIR}/ghost.md`]: content,
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);

      expect(res).toEqual({
        hardlinked: 0,
        copied: 0,
        unchanged: 1,
      });
      expect(vol.readFileSync(`${ACTIVE_DIR}/ghost.md`, 'utf8')).toBe(content);
    });

    it('accepts an explicit pre-parsed previousManifest argument', async () => {
      const content = 'Direct manifest test';
      const prevManifest = createManifest([{ path: 'direct.md', content }]);

      resetVolume({
        [`${PREV_DIR}/direct.md`]: content,
        [`${ACTIVE_DIR}/direct.md`]: content,
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR, prevManifest);

      expect(res).toEqual({
        hardlinked: 1,
        copied: 0,
        unchanged: 0,
      });
    });

    it('ignores manifest.json and .tmp files in activeDir during dedup traversal', async () => {
      const content = 'Normal note';
      const prevManifest = createManifest([{ path: 'note.md', content }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/note.md`]: content,
        [`${ACTIVE_DIR}/manifest.json`]: '{}',
        [`${ACTIVE_DIR}/in_progress.tmp`]: 'temporary content',
        [`${ACTIVE_DIR}/note.md`]: content,
      });

      const res = await dedup(ACTIVE_DIR, PREV_DIR);

      expect(res).toEqual({
        hardlinked: 1,
        copied: 0,
        unchanged: 0,
      });
    });

    it('skips dedup and marks unchanged if active file and prev file resolve to identical path', async () => {
      const content = 'Same file test';
      const prevManifest = createManifest([{ path: 'same.md', content }]);

      resetVolume({
        [`${ACTIVE_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${ACTIVE_DIR}/same.md`]: content,
      });

      // Calling dedup with activeDir as lastSnapshotDir
      const res = await dedup(ACTIVE_DIR, ACTIVE_DIR);

      expect(res).toEqual({
        hardlinked: 0,
        copied: 0,
        unchanged: 1,
      });
      expect(vol.readFileSync(`${ACTIVE_DIR}/same.md`, 'utf8')).toBe(content);
    });

    it('handles unlink failure on active file gracefully', async () => {
      const content = 'Unlink fail test';
      const prevManifest = createManifest([{ path: 'locked.md', content }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/locked.md`]: content,
        [`${ACTIVE_DIR}/locked.md`]: content,
      });

      const origUnlink = memFsPromises.unlink;
      memFsPromises.unlink = jest.fn().mockRejectedValue(
        Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }),
      ) as typeof memFsPromises.unlink;

      try {
        const res = await dedup(ACTIVE_DIR, PREV_DIR);
        expect(res).toEqual({
          hardlinked: 0,
          copied: 0,
          unchanged: 1,
        });
      } finally {
        memFsPromises.unlink = origUnlink;
      }
    });

    it('recovers by copy when hardlinkOrCopy throws unexpected error', async () => {
      const content = 'Recovery test';
      const prevManifest = createManifest([{ path: 'recover.md', content }]);

      resetVolume({
        [`${PREV_DIR}/manifest.json`]: JSON.stringify(prevManifest),
        [`${PREV_DIR}/recover.md`]: content,
        [`${ACTIVE_DIR}/recover.md`]: content,
      });

      // Mock link to throw an unexpected error not in HARDLINK_UNSUPPORTED_CODES, e.g. EIO
      const origLink = memFsPromises.link;
      memFsPromises.link = jest.fn().mockRejectedValue(
        Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }),
      ) as typeof memFsPromises.link;

      try {
        const res = await dedup(ACTIVE_DIR, PREV_DIR);
        expect(res).toEqual({
          hardlinked: 0,
          copied: 1,
          unchanged: 0,
        });
        expect(vol.readFileSync(`${ACTIVE_DIR}/recover.md`, 'utf8')).toBe(content);
      } finally {
        memFsPromises.link = origLink;
      }
    });
  });

  describe('computeSha256 and getDeduplicationMode', () => {
    it('computeSha256 computes expected hash of file content', async () => {
      resetVolume({
        '/data/sample.txt': 'hello world',
      });

      const computed = await computeSha256('/data/sample.txt');
      expect(computed).toBe(hash('hello world'));
    });

    it('getDeduplicationMode returns correct mode', () => {
      expect(getDeduplicationMode({ hardlinked: 5, copied: 0, unchanged: 2 })).toBe('hardlink');
      expect(getDeduplicationMode({ hardlinked: 0, copied: 3, unchanged: 2 })).toBe('copy');
      expect(getDeduplicationMode({ hardlinked: 0, copied: 0, unchanged: 5 })).toBe('none');
    });
  });
});
