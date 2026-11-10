import { beforeEach, describe, expect, it, vi } from 'vitest';
import joplin from '../src/__mocks__/joplin';
import { logger } from '../src/logger';
import {
  computeChanges,
  formatLastBackupResult,
  persistResult,
  RECORDED_LIST_LIMIT,
  recordChanges,
  recordWarnings,
} from '../src/result';
import { mockState, resetMockJoplin } from '../src/__mocks__/joplin';
import { SETTING_KEYS } from '../src/settings';

const paths = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.md`);

beforeEach(() => {
  resetMockJoplin();
});

describe('recordChanges', () => {
  it('keeps exact counts and only the first paths of each list', () => {
    const recorded = recordChanges({
      added: paths('a', 25_000),
      modified: paths('m', 3),
      deleted: [],
      unchanged: 7,
    });

    expect(recorded).toEqual({
      added: paths('a', RECORDED_LIST_LIMIT),
      modified: paths('m', 3),
      deleted: [],
      addedCount: 25_000,
      modifiedCount: 3,
      deletedCount: 0,
      unchanged: 7,
    });
  });
});

describe('recordWarnings', () => {
  it('keeps the first warnings and the total', () => {
    const warnings = paths('w', 30);
    expect(recordWarnings(warnings)).toEqual({
      warnings: warnings.slice(0, RECORDED_LIST_LIMIT),
      warningCount: 30,
    });
  });
});

describe('persistResult', () => {
  it('stores the summary and the record', async () => {
    await persistResult('2026-01-01 — failed — 1.0s — boom', {
      status: 'failed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      error: 'boom',
    });

    expect(mockState.values[SETTING_KEYS.lastBackupResult]).toBe(
      '2026-01-01 — failed — 1.0s — boom',
    );
    expect(JSON.parse(String(mockState.values[SETTING_KEYS.lastBackupResultJson]))).toMatchObject({
      status: 'failed',
      error: 'boom',
    });
  });
});

describe('persistResult when a settings write fails', () => {
  const failed = {
    status: 'failed' as const,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    error: 'boom',
  };

  it('does not throw, and leaves no previous details next to the new summary', async () => {
    mockState.values[SETTING_KEYS.lastBackupResult] = 'old summary';
    mockState.values[SETTING_KEYS.lastBackupResultJson] = '{"status":"success","changes":{}}';
    const realSetValue = joplin.settings.setValue.bind(joplin.settings);
    let jsonWrites = 0;
    const setValue = vi
      .spyOn(joplin.settings, 'setValue')
      .mockImplementation(async (key: string, value: unknown) => {
        // The clear goes through; writing the new record fails.
        if (key === SETTING_KEYS.lastBackupResultJson && ++jsonWrites === 2) {
          throw new Error('settings DB error');
        }
        return realSetValue(key, value);
      });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      await expect(persistResult('new summary', failed)).resolves.toBeUndefined();
    } finally {
      setValue.mockRestore();
    }

    expect(mockState.values[SETTING_KEYS.lastBackupResult]).toBe('new summary');
    expect(mockState.values[SETTING_KEYS.lastBackupResultJson]).toBe('');
    expect(warn).toHaveBeenCalledWith('Could not record the backup result.', expect.any(Error));
    warn.mockRestore();
  });

  it('keeps the previous summary and record together when the first write fails', async () => {
    mockState.values[SETTING_KEYS.lastBackupResult] = 'old summary';
    mockState.values[SETTING_KEYS.lastBackupResultJson] = '{"old":true}';
    const setValue = vi
      .spyOn(joplin.settings, 'setValue')
      .mockRejectedValue(new Error('settings DB error'));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      await persistResult('new summary', failed);
    } finally {
      setValue.mockRestore();
    }

    expect(mockState.values[SETTING_KEYS.lastBackupResult]).toBe('old summary');
    expect(mockState.values[SETTING_KEYS.lastBackupResultJson]).toBe('{"old":true}');
  });
});

describe('formatLastBackupResult', () => {
  it('says so when nothing was recorded', () => {
    expect(formatLastBackupResult('', '')).toBe('No backup run has been recorded yet.');
  });

  it('falls back to the summary for an unreadable record', () => {
    expect(formatLastBackupResult('summary', '{not json')).toBe('summary');
    expect(formatLastBackupResult('summary', 'null')).toBe('summary');
  });

  it('shows counts, the recorded paths and how many were left out', () => {
    const json = JSON.stringify({
      status: 'success',
      durationMs: 1234,
      changes: recordChanges({
        added: paths('a', 22),
        modified: ['m.md'],
        deleted: [],
        unchanged: 5,
      }),
      ...recordWarnings(paths('w', 21)),
    });

    const message = formatLastBackupResult('summary', json);

    expect(message).toContain('Changes: +22 ~1 -0 (5 unchanged)');
    expect(message).toContain(`Added:\n${paths('a', 20).join('\n')}\n… and 2 more`);
    expect(message).toContain('Modified:\nm.md');
    expect(message).not.toContain('Deleted:');
    expect(message).toContain('Duration: 1.2s');
    expect(message).toContain(`Warnings:\n${paths('w', 20).join('\n')}\n… and 1 more`);
  });

  it('reads a record written before counts were stored', () => {
    const json = JSON.stringify({
      status: 'success',
      changes: { added: paths('a', 25), modified: [], deleted: ['d.md'], unchanged: 0 },
      warnings: ['one warning'],
    });

    const message = formatLastBackupResult('summary', json);

    expect(message).toContain('Changes: +25 ~0 -1 (0 unchanged)');
    expect(message).toContain(`Added:\n${paths('a', 20).join('\n')}\n… and 5 more`);
    expect(message).toContain('Deleted:\nd.md');
    expect(message).toContain('Warnings:\none warning');
    expect(message).not.toContain('more\n\nWarnings');
  });

  it('caps the warnings of a record written before counts were stored', () => {
    const json = JSON.stringify({ status: 'success', warnings: paths('w', 3000) });
    expect(formatLastBackupResult('summary', json)).toBe(
      `summary\n\nWarnings:\n${paths('w', 20).join('\n')}\n… and 2980 more`,
    );
  });

  it('adds nothing for a failed run beyond its duration', () => {
    const json = JSON.stringify({ status: 'failed', durationMs: 500, error: 'boom' });
    expect(formatLastBackupResult('summary', json)).toBe('summary\n\nDuration: 0.5s');
  });
});

describe('computeChanges', () => {
  const manifest = (files: Array<[string, string]>) =>
    ({ files: files.map(([p, sha256]) => ({ path: p, size: 1, sha256 })) }) as Parameters<
      typeof computeChanges
    >[0];

  it('classifies paths as added, modified, deleted or unchanged, sorted', () => {
    const changes = computeChanges(
      manifest([
        ['b.md', 'h1'],
        ['same.md', 'h2'],
        ['gone.md', 'h3'],
      ]),
      ['z-new.md', 'b.md', 'same.md', 'a-new.md'],
      new Map([
        ['b.md', 'changed'],
        ['same.md', 'h2'],
        ['z-new.md', 'x'],
        ['a-new.md', 'y'],
      ]),
    );

    expect(changes).toEqual({
      added: ['a-new.md', 'z-new.md'],
      modified: ['b.md'],
      deleted: ['gone.md'],
      unchanged: 1,
    });
  });

  it('treats everything as added without a previous manifest', () => {
    expect(computeChanges(null, ['a.md'], new Map())).toEqual({
      added: ['a.md'],
      modified: [],
      deleted: [],
      unchanged: 0,
    });
  });

  it('counts a path with an unknown hash as unchanged', () => {
    const changes = computeChanges(manifest([['a.md', 'h']]), ['a.md'], new Map());
    expect(changes).toMatchObject({ modified: [], unchanged: 1 });
  });
});
