import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return { default: memfs.fs.promises, ...memfs.fs.promises };
});

import fs from 'fs/promises';
import path from 'path';
import { vol } from 'memfs';
import {
  createVerifyLease,
  leasedSnapshots,
  listSnapshots,
  pruneSnapshots,
  SNAPSHOT_DIR_PATTERN,
  VERIFY_LEASE_PREFIX,
} from '../src/retention';

const ROOT = '/backups';

/** A deterministic, valid `YYYYMMDDTHHMMSS` snapshot name for `index`. */
function snapshotName(index: number): string {
  return `20260101T0000${String(index).padStart(2, '0')}`;
}

async function createSnapshots(names: readonly string[]): Promise<void> {
  for (const name of names) {
    await fs.mkdir(path.join(ROOT, name), { recursive: true });
    await fs.writeFile(path.join(ROOT, name, 'note.md'), `content of ${name}`);
  }
}

beforeEach(async () => {
  vol.reset();
  await fs.mkdir(ROOT, { recursive: true });
});

describe('SNAPSHOT_DIR_PATTERN', () => {
  it('accepts the expected names and rejects others', () => {
    expect(SNAPSHOT_DIR_PATTERN.test('20260101T000000')).toBe(true);
    expect(SNAPSHOT_DIR_PATTERN.test('20260101T000000-2')).toBe(true);
    expect(SNAPSHOT_DIR_PATTERN.test('notes')).toBe(false);
    expect(SNAPSHOT_DIR_PATTERN.test('2026-01-01T00-00-00')).toBe(false);
  });
});

describe('listSnapshots', () => {
  it('returns matching directories sorted oldest-first', async () => {
    await createSnapshots([snapshotName(2), snapshotName(0), snapshotName(1)]);
    await fs.mkdir(path.join(ROOT, 'not-a-snapshot'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'stray-file.txt'), 'x');

    await expect(listSnapshots(ROOT)).resolves.toEqual([
      snapshotName(0),
      snapshotName(1),
      snapshotName(2),
    ]);
  });

  it('returns an empty list when the root is missing', async () => {
    await expect(listSnapshots('/does/not/exist')).resolves.toEqual([]);
  });
});

describe('pruneSnapshots', () => {
  it('deletes the oldest snapshots down to the retention limit', async () => {
    const names = Array.from({ length: 10 }, (_, index) => snapshotName(index));
    await createSnapshots(names);

    const removed = await pruneSnapshots(ROOT, 5);

    expect(removed).toEqual(names.slice(0, 5));
    await expect(listSnapshots(ROOT)).resolves.toEqual(names.slice(5));
  });

  it('deletes nothing when there are fewer snapshots than the limit', async () => {
    const names = [snapshotName(0), snapshotName(1), snapshotName(2)];
    await createSnapshots(names);

    await expect(pruneSnapshots(ROOT, 5)).resolves.toEqual([]);
    await expect(listSnapshots(ROOT)).resolves.toEqual(names);
  });

  it('keeps the default number of snapshots for a non-numeric retention', async () => {
    const names = Array.from({ length: 7 }, (_, index) => snapshotName(index));
    await createSnapshots(names);

    await expect(pruneSnapshots(ROOT, Number.NaN)).resolves.toEqual(names.slice(0, 2));
  });

  it('clamps a retention of 0 to 1', async () => {
    const names = [snapshotName(0), snapshotName(1), snapshotName(2)];
    await createSnapshots(names);

    const removed = await pruneSnapshots(ROOT, 0);

    expect(removed).toEqual(names.slice(0, 2));
    await expect(listSnapshots(ROOT)).resolves.toEqual([names[2]]);
  });

  it('never deletes keepSnapshot, even when it sorts oldest (clock went backwards)', async () => {
    const existing = [snapshotName(5), snapshotName(6), snapshotName(7)];
    const created = snapshotName(1);
    await createSnapshots([...existing, created]);

    const removed = await pruneSnapshots(ROOT, 3, created);

    expect(removed).toEqual([snapshotName(5)]);
    await expect(listSnapshots(ROOT)).resolves.toEqual([created, snapshotName(6), snapshotName(7)]);
  });

  it('keeps only keepSnapshot at a retention of 1', async () => {
    const created = snapshotName(0);
    await createSnapshots([created, snapshotName(8), snapshotName(9)]);

    await pruneSnapshots(ROOT, 1, created);

    await expect(listSnapshots(ROOT)).resolves.toEqual([created]);
  });

  it('skips a snapshot that cannot be removed (EBUSY) and keeps going', async () => {
    const names = Array.from({ length: 3 }, (_, index) => snapshotName(index));
    await createSnapshots(names);

    const rmSpy = vi
      .spyOn(fs, 'rm')
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));

    await expect(pruneSnapshots(ROOT, 1)).resolves.toEqual(names.slice(0, 2));

    // The busy snapshot survives; the other outdated snapshot is removed.
    await expect(listSnapshots(ROOT)).resolves.toEqual([names[0], names[2]]);

    rmSpy.mockRestore();
  });
});

describe('verify leases', () => {
  /** Back-date a file's mtime by `ageMs`. */
  async function age(filePath: string, ageMs: number): Promise<void> {
    const then = new Date(Date.now() - ageMs);
    await fs.utimes(filePath, then, then);
  }

  it('keeps a leased snapshot past the retention limit, and prunes the others', async () => {
    const names = [snapshotName(0), snapshotName(1), snapshotName(2), snapshotName(3)];
    await createSnapshots(names);
    await createVerifyLease(ROOT, names[0]);

    const removed = await pruneSnapshots(ROOT, 2, names[3]);

    expect(removed).toEqual([names[1]]);
    await expect(listSnapshots(ROOT)).resolves.toEqual([names[0], names[2], names[3]]);
  });

  it('does not delete a newer snapshot in place of a leased one', async () => {
    const names = [snapshotName(0), snapshotName(1)];
    await createSnapshots(names);
    await createVerifyLease(ROOT, names[0]);

    await expect(pruneSnapshots(ROOT, 1, names[1])).resolves.toEqual([]);
    await expect(listSnapshots(ROOT)).resolves.toEqual(names);
  });

  it('ignores and removes a stale lease', async () => {
    const names = [snapshotName(0), snapshotName(1)];
    await createSnapshots(names);
    const lease = await createVerifyLease(ROOT, names[0]);
    await age(lease, 60_000);

    await expect(pruneSnapshots(ROOT, 1, names[1], 30_000)).resolves.toEqual([names[0]]);
    await expect(fs.stat(lease)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gives each lease a unique name, and lists only valid snapshot names', async () => {
    const a = await createVerifyLease(ROOT, snapshotName(0));
    const b = await createVerifyLease(ROOT, snapshotName(0));
    await fs.writeFile(path.join(ROOT, `${VERIFY_LEASE_PREFIX}not-a-snapshot.x`), '');

    expect(a).not.toBe(b);
    expect(path.basename(a).startsWith(`${VERIFY_LEASE_PREFIX}${snapshotName(0)}.`)).toBe(true);
    await expect(leasedSnapshots(ROOT)).resolves.toEqual(new Set([snapshotName(0)]));
  });

  it('treats a missing backup root as having no leases', async () => {
    await expect(leasedSnapshots('/nowhere')).resolves.toEqual(new Set());
  });
});
