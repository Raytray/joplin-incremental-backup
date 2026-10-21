/**
 * Step 1C tests — Manifest (src/manifest.ts)
 *
 * Uses memfs to simulate snapshot filesystems in-memory.
 */

import * as crypto from 'crypto';
import { Volume, createFsFromVolume } from 'memfs';

// Replace real fs/promises with memfs before loading the module under test
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

import {
  Manifest,
  buildManifest,
  isValidManifest,
  readManifest,
  writeManifest,
} from '../src/manifest';

function sha256Hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function resetVolume(initialFiles: Record<string, string> = {}): void {
  vol.reset();
  vol.mkdirSync('/snapshots', { recursive: true });

  for (const [filePath, content] of Object.entries(initialFiles)) {
    const lastSlash = filePath.lastIndexOf('/');
    const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : '/';
    vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(filePath, content, { encoding: 'utf8' });
  }
}

describe('isValidManifest', () => {
  const sampleValidManifest: Manifest = {
    snapshotId: '2026-10-20T12:00:00.000Z',
    createdAt: 1792497600000,
    joplinVersion: '2.14.0',
    lastChangeTime: 1792497500000,
    fileCount: 1,
    files: [
      {
        path: 'note.md',
        size: 12,
        sha256: sha256Hex('test content'),
      },
    ],
    deduplication: 'hardlink',
  };

  it('validates a complete, correct manifest', () => {
    expect(isValidManifest(sampleValidManifest)).toBe(true);
  });

  it('rejects null, non-objects, and arrays', () => {
    expect(isValidManifest(null)).toBe(false);
    expect(isValidManifest(undefined)).toBe(false);
    expect(isValidManifest('string')).toBe(false);
    expect(isValidManifest(12345)).toBe(false);
    expect(isValidManifest([])).toBe(false);
  });

  it('rejects missing or wrong-typed required fields', () => {
    expect(isValidManifest({ ...sampleValidManifest, snapshotId: 123 })).toBe(false);
    expect(isValidManifest({ ...sampleValidManifest, createdAt: 'not a number' })).toBe(false);
    expect(isValidManifest({ ...sampleValidManifest, createdAt: NaN })).toBe(false);
    expect(isValidManifest({ ...sampleValidManifest, joplinVersion: 456 })).toBe(false);
    expect(isValidManifest({ ...sampleValidManifest, lastChangeTime: undefined })).toBe(false);
    expect(isValidManifest({ ...sampleValidManifest, fileCount: '1' })).toBe(false);
    expect(isValidManifest({ ...sampleValidManifest, deduplication: 'unknown_mode' })).toBe(false);
  });

  it('rejects malformed file entries', () => {
    expect(isValidManifest({ ...sampleValidManifest, files: 'not-an-array' })).toBe(false);
    expect(
      isValidManifest({
        ...sampleValidManifest,
        files: [{ path: 123, size: 10, sha256: 'abc' }],
      }),
    ).toBe(false);
    expect(
      isValidManifest({
        ...sampleValidManifest,
        files: [{ path: 'note.md', size: '10', sha256: 'abc' }],
      }),
    ).toBe(false);
    expect(
      isValidManifest({
        ...sampleValidManifest,
        files: [{ path: 'note.md', size: 10, sha256: 123 }],
      }),
    ).toBe(false);
    expect(
      isValidManifest({
        ...sampleValidManifest,
        files: [null],
      }),
    ).toBe(false);
  });
});

describe('readManifest', () => {
  beforeEach(() => resetVolume());

  it('returns null if manifest.json does not exist', async () => {
    const result = await readManifest('/snapshots/nonexistent');
    expect(result).toBeNull();
  });

  it('returns null if manifest.json contains invalid JSON syntax', async () => {
    resetVolume({
      '/snapshots/snap1/manifest.json': '{ invalid json: broken',
    });
    const result = await readManifest('/snapshots/snap1');
    expect(result).toBeNull();
  });

  it('returns null if manifest.json is valid JSON but fails schema validation', async () => {
    resetVolume({
      '/snapshots/snap1/manifest.json': JSON.stringify({
        snapshotId: 'test',
        // missing createdAt, files, etc.
      }),
    });
    const result = await readManifest('/snapshots/snap1');
    expect(result).toBeNull();
  });

  it('successfully reads and returns a valid manifest', async () => {
    const valid: Manifest = {
      snapshotId: '2026-10-20T12:00:00.000Z',
      createdAt: 1792497600000,
      joplinVersion: '2.14.0',
      lastChangeTime: 1792497500000,
      fileCount: 0,
      files: [],
      deduplication: 'none',
    };
    resetVolume({
      '/snapshots/snap1/manifest.json': JSON.stringify(valid),
    });

    const result = await readManifest('/snapshots/snap1');
    expect(result).toEqual(valid);
  });
});

describe('writeManifest and round-trip', () => {
  beforeEach(() => resetVolume());

  it('writes manifest.json atomically and round-trips correctly', async () => {
    const manifest: Manifest = {
      snapshotId: '2026-10-20T14:00:00.000Z',
      createdAt: 1792504800000,
      joplinVersion: '2.14.1',
      lastChangeTime: 1792504700000,
      fileCount: 2,
      files: [
        {
          path: 'folder/subnote.md',
          size: 15,
          sha256: sha256Hex('subnote content'),
        },
        {
          path: 'rootnote.md',
          size: 11,
          sha256: sha256Hex('root content'),
        },
      ],
      deduplication: 'hardlink',
    };

    await writeManifest('/snapshots/snap1', manifest);

    // Verify it was written to disk in formatted JSON
    const written = vol.readFileSync('/snapshots/snap1/manifest.json', 'utf8');
    expect(JSON.parse(written as string)).toEqual(manifest);

    // Verify readManifest round-trips to the same object
    const roundTripped = await readManifest('/snapshots/snap1');
    expect(roundTripped).toEqual(manifest);
  });

  it('overwrites an existing manifest atomically without error', async () => {
    const initialManifest: Manifest = {
      snapshotId: 'initial',
      createdAt: 1,
      joplinVersion: '1.0',
      lastChangeTime: 0,
      fileCount: 0,
      files: [],
      deduplication: 'none',
    };
    const updatedManifest: Manifest = {
      snapshotId: 'updated',
      createdAt: 2,
      joplinVersion: '2.0',
      lastChangeTime: 1,
      fileCount: 0,
      files: [],
      deduplication: 'copy',
    };

    await writeManifest('/snapshots/snap1', initialManifest);
    await writeManifest('/snapshots/snap1', updatedManifest);

    const result = await readManifest('/snapshots/snap1');
    expect(result).toEqual(updatedManifest);
  });
});

describe('buildManifest', () => {
  beforeEach(() => resetVolume());

  it('builds an empty manifest for an empty directory', async () => {
    vol.mkdirSync('/snapshots/empty', { recursive: true });

    const manifest = await buildManifest('/snapshots/empty');

    expect(manifest.fileCount).toBe(0);
    expect(manifest.files).toEqual([]);
    expect(manifest.deduplication).toBe('none');
    expect(typeof manifest.snapshotId).toBe('string');
    expect(typeof manifest.createdAt).toBe('number');
  });

  it('computes correct fileCount, sizes, and SHA-256 hashes for seeded files', async () => {
    const file1Content = '# Note 1\nHello World';
    const file2Content = 'Resource binary simulation data';
    const file3Content = '# Sub Note in Folder';

    resetVolume({
      '/snapshots/snap1/note1.md': file1Content,
      '/snapshots/snap1/resources/attachment.dat': file2Content,
      '/snapshots/snap1/nested/dir/note3.md': file3Content,
    });

    const manifest = await buildManifest('/snapshots/snap1', {
      snapshotId: '20261020T120000',
      createdAt: 1792497600000,
      joplinVersion: '3.0.0',
      lastChangeTime: 1792497500000,
      deduplication: 'hardlink',
    });

    expect(manifest.snapshotId).toBe('20261020T120000');
    expect(manifest.createdAt).toBe(1792497600000);
    expect(manifest.joplinVersion).toBe('3.0.0');
    expect(manifest.lastChangeTime).toBe(1792497500000);
    expect(manifest.deduplication).toBe('hardlink');
    expect(manifest.fileCount).toBe(3);

    // Files should be sorted alphabetically by path with forward slashes
    expect(manifest.files).toEqual([
      {
        path: 'nested/dir/note3.md',
        size: Buffer.byteLength(file3Content),
        sha256: sha256Hex(file3Content),
      },
      {
        path: 'note1.md',
        size: Buffer.byteLength(file1Content),
        sha256: sha256Hex(file1Content),
      },
      {
        path: 'resources/attachment.dat',
        size: Buffer.byteLength(file2Content),
        sha256: sha256Hex(file2Content),
      },
    ]);
  });

  it('ignores manifest.json and temporary .tmp files', async () => {
    resetVolume({
      '/snapshots/snap1/note.md': 'valid note',
      '/snapshots/snap1/manifest.json': '{"old": "manifest"}',
      '/snapshots/snap1/temp_file.tmp': 'temporary data',
      '/snapshots/snap1/nested/another.tmp': 'nested temp',
    });

    const manifest = await buildManifest('/snapshots/snap1');

    expect(manifest.fileCount).toBe(1);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].path).toBe('note.md');
  });

  it('uses default values when meta is omitted or partially provided', async () => {
    resetVolume({
      '/snapshots/snap1/note.md': 'content',
    });

    const before = Date.now();
    const manifest = await buildManifest('/snapshots/snap1');
    const after = Date.now();

    expect(manifest.deduplication).toBe('none');
    expect(manifest.joplinVersion).toBe('');
    expect(manifest.lastChangeTime).toBe(0);
    expect(manifest.createdAt).toBeGreaterThanOrEqual(before);
    expect(manifest.createdAt).toBeLessThanOrEqual(after);
    expect(new Date(manifest.snapshotId).getTime()).not.toBeNaN();
  });
});
