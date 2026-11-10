import { createHash } from 'crypto';
import joplin from 'api';
import { logger } from './logger';
import { mapWithConcurrency } from './platform';
import { FINGERPRINT_DIGEST_KEYS } from './manifest';
import type { ChangeFingerprint } from './manifest';
import type { BackupWarning } from './result';

const PAGE_LIMIT = 100;
/** Parallel `tags/:id/notes` queries while reading note↔tag links. */
const TAG_QUERY_CONCURRENCY = 8;

/** Directory the RAW exporter writes attachments into. */
export const RESOURCES_DIR_NAME = 'resources';

/**
 * What the database says the vault contains. Read in a single pass so the
 * completeness check costs no extra queries.
 */
export interface VaultInventory {
  /** Fingerprint used to detect "nothing changed since the last snapshot". */
  fingerprint: ChangeFingerprint;
  /** Ids of every note in the database. */
  noteIds: string[];
  /** Number of resources in the database. */
  resourceCount: number;
}

export interface VaultInventoryOptions {
  /**
   * Read note↔tag links (one query per tag) into `noteTagDigest`. Only the
   * skip-on-unchanged check needs them, so callers that will export anyway
   * can leave them out.
   */
  includeNoteTags?: boolean;
}

export interface CompletenessCheckInput {
  /** Relative paths of every file the export produced. */
  exportedFiles: readonly string[];
  /** Inventory read from the database. */
  inventory: VaultInventory;
  /** Folder ids that were handed to the exporter. */
  folderIds: readonly string[];
}

const FINGERPRINT_KEYS: ReadonlyArray<keyof ChangeFingerprint> = [
  'maxNoteUpdatedTime',
  'noteCount',
  'maxResourceUpdatedTime',
  ...FINGERPRINT_DIGEST_KEYS,
];

/**
 * True only when every fingerprint field matches. A field missing on one side
 * (a manifest written by an older version) counts as a difference.
 */
export function fingerprintsEqual(
  a: ChangeFingerprint | null | undefined,
  b: ChangeFingerprint | null | undefined,
): boolean {
  if (!a || !b) return false;
  return FINGERPRINT_KEYS.every((key) => a[key] !== undefined && a[key] === b[key]);
}

async function paginate(
  resource: string | string[],
  fields: string[],
  onItem: (item: Record<string, unknown>) => void,
): Promise<void> {
  const dataPath = Array.isArray(resource) ? resource : [resource];
  let page = 1;
  for (;;) {
    const response = await joplin.data.get(dataPath, { fields, page, limit: PAGE_LIMIT });
    const items: Array<Record<string, unknown>> = Array.isArray(response?.items)
      ? response.items
      : [];

    if (page === 1) {
      logger.debug(
        `joplin.data.get("${dataPath.join('/')}") returned page size ${items.length} (requested ${PAGE_LIMIT})`,
      );
    }

    for (const item of items) onItem(item);

    if (!response?.has_more || items.length === 0) break;
    page += 1;
  }
}

export async function getChangeFingerprint(
  options?: VaultInventoryOptions,
): Promise<ChangeFingerprint> {
  return (await collectVaultInventory(options)).fingerprint;
}

/**
 * SHA-256 over `key:value` pairs in sorted order, so the digest does not depend
 * on the order the API returned them in. Pairs are fed to the hash one at a
 * time rather than joined into a single string first.
 */
export function digestPairs(pairs: Array<readonly [string, string]>): string {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  pairs.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
  const hash = createHash('sha256');
  for (const [key, value] of pairs) hash.update(`${key}:${value}\n`);
  return hash.digest('hex');
}

/**
 * Read every `id:updated_time` pair of one item type, tracking the newest
 * `updated_time` along the way.
 */
async function readItemTimes(
  resource: string,
  onId?: (id: string) => void,
): Promise<{ pairs: Array<[string, string]>; maxUpdatedTime: number }> {
  const pairs: Array<[string, string]> = [];
  let maxUpdatedTime = 0;
  await paginate(resource, ['id', 'updated_time'], (item) => {
    const updated = Number(item.updated_time) || 0;
    if (updated > maxUpdatedTime) maxUpdatedTime = updated;
    if (typeof item.id !== 'string') return;
    pairs.push([item.id, String(updated)]);
    onId?.(item.id);
  });
  return { pairs, maxUpdatedTime };
}

/** Like `Promise.all`, but waits for every promise to settle before rejecting. */
async function allOrFirstError<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }],
): Promise<T> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/**
 * Read the vault inventory: notes, resources, notebooks and tags, plus (when
 * requested) the note↔tag links.
 *
 * Each item type is reduced to a digest of its sorted `id:updated_time`
 * pairs, so any added, removed or changed item alters the fingerprint, even
 * one that arrives through sync with an older timestamp than the newest
 * local edit.
 *
 * Note↔tag links have no endpoint of their own, so they are read per tag
 * (`tags/:id/notes`), with bounded concurrency.
 */
export async function collectVaultInventory(
  options: VaultInventoryOptions = {},
): Promise<VaultInventory> {
  const { includeNoteTags = true } = options;
  const noteIds: string[] = [];

  // Independent Data API reads: fetch them together. allSettled, so a failed
  // read does not leave the others paging while `retryTransient` starts over.
  const [notes, resources, folders, tags] = await allOrFirstError([
    readItemTimes('notes', (id) => noteIds.push(id)),
    readItemTimes('resources'),
    readItemTimes('folders'),
    readItemTimes('tags'),
  ]);

  let noteTagDigest: string | undefined;
  if (includeNoteTags) {
    const tagIds = tags.pairs.map(([id]) => id);
    const perTag = await mapWithConcurrency(tagIds, TAG_QUERY_CONCURRENCY, async (tagId) => {
      const links: Array<[string, string]> = [];
      await paginate(['tags', tagId, 'notes'], ['id'], (note) => {
        if (typeof note.id === 'string') links.push([tagId, note.id]);
      });
      return links;
    });
    noteTagDigest = digestPairs(perTag.flat());
  }

  return {
    fingerprint: {
      maxNoteUpdatedTime: notes.maxUpdatedTime,
      noteCount: notes.pairs.length,
      maxResourceUpdatedTime: resources.maxUpdatedTime,
      noteDigest: digestPairs(notes.pairs),
      resourceDigest: digestPairs(resources.pairs),
      folderDigest: digestPairs(folders.pairs),
      tagDigest: digestPairs(tags.pairs),
      noteTagDigest,
    },
    noteIds,
    resourceCount: resources.pairs.length,
  };
}

export async function getAllFolderIds(): Promise<string[]> {
  const ids: string[] = [];
  await paginate('folders', ['id'], (folder) => {
    if (typeof folder.id === 'string') ids.push(folder.id);
  });
  return ids;
}

/**
 * Compare the exported tree with the database inventory.
 *
 * Joplin's RAW exporter silently skips items it cannot handle — still-encrypted
 * notes, resources of trashed notes — and still reports success, so the only
 * way to notice a partial export is to compare what is on disk with what the
 * database says exists.
 *
 * The result is a list of warnings, never an error: encrypted or trashed items
 * legitimately produce false positives, and refusing to back up at all would be
 * worse than an incomplete snapshot.
 *
 * Tags and note-tags are not checked — verifying them needs extra scans that
 * cost more than they are worth.
 */
export function checkExportCompleteness(input: CompletenessCheckInput): BackupWarning[] {
  const { exportedFiles, inventory, folderIds } = input;
  const exported = new Set(exportedFiles);
  const warnings: BackupWarning[] = [];

  const missingNotes = inventory.noteIds.filter((id) => !exported.has(`${id}.md`));
  if (missingNotes.length > 0) {
    warnings.push({
      kind: 'completeness',
      message:
        `${missingNotes.length} note(s) are missing from the export ` +
        `(e.g. ${missingNotes.slice(0, 3).join(', ')}); they may still be encrypted.`,
      summary: `${missingNotes.length} note(s)`,
    });
  }

  const missingFolders = folderIds.filter((id) => !exported.has(`${id}.md`));
  if (missingFolders.length > 0) {
    warnings.push({
      kind: 'completeness',
      message:
        `${missingFolders.length} notebook(s) are missing from the export ` +
        `(e.g. ${missingFolders.slice(0, 3).join(', ')}).`,
      summary: `${missingFolders.length} notebook(s)`,
    });
  }

  const resourcePrefix = `${RESOURCES_DIR_NAME}/`;
  const exportedResources = exportedFiles.filter((file) => file.startsWith(resourcePrefix)).length;
  if (exportedResources < inventory.resourceCount) {
    warnings.push({
      kind: 'completeness',
      message:
        `Only ${exportedResources} of ${inventory.resourceCount} resource(s) are in the export; ` +
        'some attachments may be missing.',
      summary: `${inventory.resourceCount - exportedResources} of ${inventory.resourceCount} resource(s)`,
    });
  }

  return warnings;
}
