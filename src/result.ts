import { setLastBackupResult, setLastBackupResultJson } from './settings';
import type { BackupChanges } from './backup';

/**
 * How many paths of each change list, and how many warnings, the persisted
 * record keeps. "Show last backup result" shows no more than this, and a first
 * backup of a large vault would otherwise store every path in the vault in
 * Joplin's settings database.
 */
export const RECORDED_LIST_LIMIT = 20;

/** `BackupChanges` as persisted: exact counts, and the first paths of each list. */
export interface RecordedChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  unchanged: number;
}

interface RecordTimes {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/** The run record stored in the `lastBackupResultJson` setting. */
export type BackupRecord =
  | (RecordTimes & { status: 'failed'; error: string })
  | (RecordTimes & {
      status: 'skipped' | 'success';
      snapshotName?: string;
      fileCount?: number;
      changes: RecordedChanges;
      /** The first warnings; `warningCount` is the total. */
      warnings: string[];
      warningCount: number;
      message: string;
    });

export function recordChanges(changes: BackupChanges): RecordedChanges {
  return {
    added: changes.added.slice(0, RECORDED_LIST_LIMIT),
    modified: changes.modified.slice(0, RECORDED_LIST_LIMIT),
    deleted: changes.deleted.slice(0, RECORDED_LIST_LIMIT),
    addedCount: changes.added.length,
    modifiedCount: changes.modified.length,
    deletedCount: changes.deleted.length,
    unchanged: changes.unchanged,
  };
}

/** The `warnings` and `warningCount` fields of a record. */
export function recordWarnings(warnings: readonly string[]): {
  warnings: string[];
  warningCount: number;
} {
  return { warnings: warnings.slice(0, RECORDED_LIST_LIMIT), warningCount: warnings.length };
}

/** Store a run's one-line summary and its record for "Show last backup result". */
export async function persistResult(summary: string, record: BackupRecord): Promise<void> {
  await setLastBackupResult(summary);
  await setLastBackupResultJson(JSON.stringify(record));
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** One list of the dialog: the recorded paths, and how many were left out. */
function formatList(title: string, items: string[], total: number): string {
  if (total === 0) return '';
  const shown = items.slice(0, RECORDED_LIST_LIMIT);
  const more = total - shown.length;
  return `\n${title}:\n${shown.join('\n')}` + (more > 0 ? `\n… and ${more} more` : '');
}

/**
 * The text of the "Show last backup result" dialog: `summary` (the
 * `lastBackupResult` setting) plus details from the stored record.
 *
 * Records written before counts were stored hold the full lists and no
 * counts; the list lengths stand in for them.
 */
export function formatLastBackupResult(summary: string, json: string): string {
  let message = summary || 'No backup run has been recorded yet.';
  if (!json) return message;

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null) return message;
    parsed = value as Record<string, unknown>;
  } catch {
    return message;
  }

  if (typeof parsed.changes === 'object' && parsed.changes !== null) {
    const changes = parsed.changes as Record<string, unknown>;
    const added = stringList(changes.added);
    const modified = stringList(changes.modified);
    const deleted = stringList(changes.deleted);
    const addedCount = count(changes.addedCount, added.length);
    const modifiedCount = count(changes.modifiedCount, modified.length);
    const deletedCount = count(changes.deletedCount, deleted.length);
    message +=
      `\n\nChanges: +${addedCount} ~${modifiedCount} -${deletedCount} ` +
      `(${count(changes.unchanged, 0)} unchanged)`;
    message += formatList('Added', added, addedCount);
    message += formatList('Modified', modified, modifiedCount);
    message += formatList('Deleted', deleted, deletedCount);
  }

  if (typeof parsed.durationMs === 'number') {
    message += `\n\nDuration: ${(parsed.durationMs / 1000).toFixed(1)}s`;
  }

  const warnings = stringList(parsed.warnings);
  const warningCount = count(parsed.warningCount, warnings.length);
  if (warningCount > 0) {
    const more = warningCount - warnings.length;
    message += `\n\nWarnings:\n${warnings.join('\n')}` + (more > 0 ? `\n… and ${more} more` : '');
  }

  return message;
}
