# Joplin Incremental Backup Plugin — Full Recreation Plan

**Stack:** TypeScript · Webpack · Vitest · Node.js `fs/promises` · Joplin Plugin API (desktop)  
**Approach:** Deduplicated full snapshots via Joplin's native Raw export (rsnapshot-style hardlinks + copy fallback)  
**Restore:** Each snapshot is independently importable via `File > Import > RAW - Joplin Export Directory`  
**Target:** Joplin 3.7+ (`app_min_version` and versions align with `src/manifest.json` and `package.json`)

This plan builds the plugin on top of the existing Joplin generator scaffold already in the repository (webpack build → `.jpl` archive, `api/` type stubs, `src/manifest.json`). It covers hashing, verification, deduplication, reliability, scheduling, and test coverage. Steps marked ★ may run in parallel once their dependencies are satisfied.

---

## Dependency Graph

```
[Step 0: Scaffold]
       │
       ├──────────────────────────────────────────────┐
       │                                              │
[Step 1A: Settings]                 [Step 1B: Cross-Platform Utils]
[Step 1C: Manifest]                 [Step 1D: Dedup Engine]
[Step 1E: Retention]
       │                                              │
       └──────────────┬───────────────────────────────┘
                      │
              [Step 2: Backup Engine]
                      │
              [Step 3: Scheduler & Commands]
                      │
              [Step 4: Integration Tests & Validation]
```

Steps `1A`–`1E` may run in parallel after Step 0, with one caveat: `1C`, `1D`, and `1E` import primitives from `1B`, so treat `1B`'s function signatures as frozen contracts (or run `1B` first).

---

## Step 0 — Scaffold (blocking, run first)

Initialize the plugin project. All subsequent steps depend on this.

- Confirm `src/manifest.json` (the generator reads it from `src/`, **not** the repo root) carries the correct id and versions:
  ```json
  {
    "manifest_version": 1,
    "id": "io.github.raytray.joplin-incremental-backup",
    "app_min_version": "3.7",
    "name": "Incremental Backup",
    "description": "Deduplicated incremental snapshots of your Joplin data using the native Raw export format.",
    "author": "raytray",
    "homepage_url": "",
    "version": "1.0.0",
    "platforms": ["desktop"]
  }
  ```
- **Keep the existing generator build pipeline** (`webpack.config.js` + `plugin.config.json`). It compiles `src/index.ts` → `dist/index.js` and then packs `dist/` into the installable `.jpl` archive in `publish/`. Only confirm/extend the `api` → `api/` resolve alias. **Do not** replace it with a config that writes `publish/index.js` directly — that yields no `.jpl`, so the plugin cannot be installed.
- Add scripts to the existing `package.json` (retain the generator's `dist`, `prepare`, `updateVersion`, `update`): `test`, `test:coverage`, `lint`, `format`, `format:check`.
- Add dev dependencies: `@types/node`, `vitest`, `@vitest/coverage-v8`, `memfs`, `oxlint`, `prettier` (`typescript`, `webpack`, `webpack-cli`, `ts-loader` are already present).
- Update `tsconfig.json` (target ES2018, module commonjs, strict, types `vitest/globals` + `node`). **Vitest only — no Jest.**
- Create `tsconfig.build.json` excluding tests (`tests/**`, `**/*.test.ts`).
- Create `vitest.config.ts` with `resolve.alias` mapping `api` → `src/__mocks__/joplin.ts` for runtime (TypeScript still resolves `api` to `api/index.ts` for types), and `api/types` → `api/types.ts` so enum values are real at runtime.
- Entry point `src/index.ts` with `joplin.plugins.register({ onStart })` shell (already scaffolded by the generator).
- Create `src/__mocks__/joplin.ts` stub for all `joplin.*` API calls (`plugins`, `settings`, `commands`, `views`, `data`, `versionInfo`). There is **no** `appVersion` method in the plugin API — do not stub or call it.
- Create `src/logger.ts` lightweight prefixed logger.

**Tests:** `npm test` passes with empty suite; `npm run dist` produces an installable `.jpl` in `publish/`.

---

## Step 1A — Settings (`src/settings.ts`) ★ parallel

Register all user-facing and hidden settings with the Joplin settings API.

**Settings to register:**

| Key               | Type     | Default | Public | Notes                                         |
| ----------------- | -------- | ------- | ------ | --------------------------------------------- |
| `backupPath`      | `String` | `""`    | yes    | Absolute path to backup root                  |
| `backupRetention` | `Int`    | `5`     | yes    | Snapshots to keep; clamp to minimum `1`       |
| `backupInterval`  | `Int`    | `24`    | yes    | Auto-backup interval in hours; `0` = disabled |
| `onlyOnChange`    | `Bool`   | `true`  | yes    | Skip snapshot if nothing changed              |
| `lastBackup`      | `String` | `""`    | no     | Hidden — ISO timestamp of last run            |
| `lastSnapshot`    | `String` | `""`    | no     | Hidden — directory name of last snapshot      |

`SettingItem.public` is a **required** field — user-facing settings must set `public: true`, and `lastBackup`/`lastSnapshot` must set `public: false` so they never render in the config screen.

**Implementation:**

- `registerSettings()` — call `joplin.settings.registerSection` + `joplin.settings.registerSettings`.
- `getSettings()` — return validated config object; throw descriptive error if `backupPath` is empty.
- `validateBackupPath(backupPath, platform)` — throw if empty; warn on Windows if length > 180.
- `isSchedulerEnabled(settingsOrInterval)` — `interval > 0`.
- `setLastBackup(timestamp)`, `setLastSnapshot(snapshotDirName)`.

**Tests (`tests/settings.test.ts`):**

- Mocked `joplin.settings.value` returns correct typed values.
- `getSettings()` throws when `backupPath` is empty.
- `backupInterval = 0` signals disabled scheduler.
- Path length warning fires on Windows.

---

## Step 1B — Cross-Platform Utilities (`src/platform.ts`) ★ parallel

Implement all OS-sensitive primitives so every other module stays platform-agnostic.

**Functions:**

```typescript
atomicWriteFile(targetPath: string, content: string): Promise<void>
acquireLock(lockPath: string, staleLimitMs: number): Promise<void>
releaseLock(lockPath: string): Promise<void>
hardlinkOrCopy(src: string, dest: string): Promise<'hardlink' | 'copy'>
toDedupeKey(relativePath: string): string
safeRmDir(dirPath: string): Promise<void>
ensureBackupRoot(backupRoot: string): Promise<void>
checkDiskSpace(backupRoot: string, minFreeBytes?: number): Promise<number>
mapWithConcurrency<T, R>(items, concurrency, mapper): Promise<R[]>
computeFileSha256(filePath: string): Promise<string>
```

**Rules:**

- `atomicWriteFile`: write to `<target>.tmp`, then `fs.rename`; if rename throws `EEXIST`, unlink dest first, then rename.
- `acquireLock`: use `O_EXCL` `'wx'` flag; if lock older than `staleLimitMs`, delete and retry once; if still blocked, throw with code `'EEXIST'`. Store creation time (ISO) in lock file.
- `hardlinkOrCopy`: attempt `fs.link`; on `EPERM`/`ENOTSUP`/`EXDEV`/`ENOSYS`, fall back to `fs.copyFile`; return mode.
- `toDedupeKey`: `relativePath.toLowerCase().replace(/\\/g, '/')`. Note: lowercasing collapses case-only differences, which on case-sensitive filesystems (Linux) can merge two distinct paths into one key. This is content-safe (hardlinking still requires a matching SHA-256), but it can reduce dedup accuracy — keep the hash-match requirement as the source of truth.
- `safeRmDir`: catch `EBUSY` on Windows, warn instead of throwing.
- `computeFileSha256`: stream file in 64KB chunks (not whole-file read).
- `checkDiskSpace`: default `minFreeBytes` to 1 GiB when omitted; **warn only** (do not throw) if free space is below the threshold, so a low-disk condition never blocks a backup. Return the free bytes observed.
- `mapWithConcurrency`: bounded worker pool, results in original order.

**Tests (`tests/platform.test.ts`) using `memfs`:**

- `atomicWriteFile` overwrites existing file without error.
- `acquireLock` throws `EEXIST` when held; succeeds after stale timeout.
- `hardlinkOrCopy` returns `'copy'` when `fs.link` throws `EPERM`.
- `toDedupeKey` normalizes backslashes and uppercased paths.
- `computeFileSha256` matches known digest.

---

## Step 1C — Manifest (`src/manifest.ts`) ★ parallel

Track snapshot state and per-file integrity data (SHA-256, sizes).

**Interfaces:**

```typescript
interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}
type DeduplicationMode = 'hardlink' | 'copy' | 'none';
interface Manifest {
  snapshotId: string;
  createdAt: number;
  joplinVersion: string;
  lastChangeTime: number;
  changeFingerprint: {
    maxNoteUpdatedTime: number;
    noteCount: number;
    maxResourceUpdatedTime: number;
  };
  fileCount: number;
  files: FileEntry[];
  deduplication: DeduplicationMode;
}
```

`changeFingerprint` is what `onlyOnChange` compares against to decide whether anything actually changed (see Step 2). A max-note-`updated_time`-only check is insufficient: deleting a note does not raise any surviving note's `updated_time`, and editing an attachment does not touch note `updated_time` — both would otherwise be silently skipped.

**Functions:**

- `isValidManifest(obj)` — type guard.
- `readManifest(snapshotDir)` — parse `manifest.json`; return `null` if absent/malformed.
- `writeManifest(snapshotDir, manifest)` — use `atomicWriteFile`.
- `buildManifest(snapshotDir, meta, filePaths?, precomputedHashes?)` — walk directory (or use provided paths), compute SHA-256 per file via streaming, return complete `Manifest`. Sort files by path. When `precomputedHashes` (the map returned by `dedup()`) is supplied, reuse those hashes instead of re-reading every file — this avoids reading the whole export twice per backup. `meta` includes `snapshotId`, `joplinVersion`, and `changeFingerprint`.
- `collectFiles(dir, baseDir)` / `collectFilesFromPaths(filePaths, baseDir)`.

**Tests (`tests/manifest.test.ts`) using `memfs`:**

- Returns `null` for missing or malformed `manifest.json`.
- Round-trips correctly (write → read → equals).
- `buildManifest` produces correct `fileCount` and SHA-256 hashes.

---

## Step 1D — Deduplication Engine (`src/dedup.ts`) ★ parallel

Replace files in the active export with hardlinks to the previous snapshot where content is identical.

**Algorithm:**

1. Walk all files in `activeDir` recursively (or reuse pre-collected list).
2. Compute SHA-256 for each file (streaming, bounded concurrency).
3. Normalize relative path via `toDedupeKey`.
4. Build a content index from the previous manifest: `pathIndex` (normalized path → entry) and `hashIndex` (sha256 → entry).
5. For each active file:
   - Same path + same hash → hardlink to previous snapshot's file.
   - Different path but same hash → hardlink to matching file (content-addressed fallback).
   - No match → keep as-is (new or changed file).
6. Use `hardlinkOrCopy` (unlink active file first, then link/copy); record mode.
7. Skip if prev/active paths resolve to the same file; skip if source missing.

**Returns:** `{ hardlinked: number, copied: number, unchanged: number, hashes: Map<string, string> }` — `hashes` maps each active file's relative path (via `toDedupeKey`) to its computed SHA-256. Pass this into `buildManifest` so the export is not read and hashed a second time.

**Exports:** `buildContentIndex(manifest)`, `collectFiles(dir)`, `getDeduplicationMode(result)`.

**Tests (`tests/dedup.test.ts`) using `memfs`:**

- Identical file gets hardlinked; `hardlinked` increments.
- Changed file kept; `unchanged` increments.
- New file (no prior match) kept; `unchanged` increments.
- When `fs.link` throws `EPERM`, file copied; `copied` increments.
- Hash collision across different paths correctly hardlinks.

---

## Step 1E — Retention & Pruning (`src/retention.ts`) ★ parallel

Enforce the snapshot retention limit after each successful backup.

**Functions:**

- `listSnapshots(backupRoot)` — return snapshot dir names matching `^\d{8}T\d{6}(-\d+)?$` (the optional `-N` suffix disambiguates same-second runs), sorted oldest-first (lexicographic order is chronological for these names). Ignore non-matching. Return `[]` if root missing.
- `pruneSnapshots(backupRoot, retentionCount)` — clamp `retentionCount` to a minimum of `1` (a user-entered `0` must never delete the just-created snapshot); delete oldest until count ≤ retentionCount; use `safeRmDir`. Catch EBUSY, skip that snapshot.

**Hardlink pruning note:** deleting an old snapshot dir only removes that dir's entries; files still hardlinked by newer snapshots remain intact — no special handling needed.

**Tests (`tests/retention.test.ts`) using `memfs`:**

- 10 snapshots + retention 5 → 5 oldest deleted, 5 newest remain.
- retention 5 with only 3 snapshots → zero deletions.
- Non-matching directories ignored.
- `safeRmDir` EBUSY caught; remaining snapshots unaffected.

---

## Step 2 — Backup Engine (`src/backup.ts`) (depends on 1A–1E)

Orchestrate one full backup run.

**Constants:** `LOCK_FILENAME = '.backup.lock'`, `ACTIVE_DIR_NAME = '_joplin_active_'`, `LATEST_FILENAME = 'latest.txt'`, `DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000`.

**`generateSnapshotName(date)`** → `YYYYMMDDTHHMMSS` (UTC). Because this is second-resolution, two runs in the same second collide, and the workflow does `safeRmDir(snapshotDir)` before rename — which would delete an existing snapshot of the same name. Add a uniqueness guard: if the name already exists in `backupRoot`, append a counter suffix (`-2`, `-3`, …). The `listSnapshots` regex (Step 1E) accepts this suffix.

**`resolveLastSnapshot(backupRoot, preferredSnapshotName?)`** → check settings.lastSnapshot, then `latest.txt`, then newest in backupRoot.

**`getChangeFingerprint()`** → build a cheap fingerprint of current data so `onlyOnChange` detects _any_ change, not just edits. Paginate `joplin.data.get(['notes'], { fields: ['id', 'updated_time'] })` to collect the max note `updated_time` **and the note count**, and paginate `joplin.data.get(['resources'], { fields: ['updated_time'] })` for the max resource `updated_time`. Return `{ maxNoteUpdatedTime, noteCount, maxResourceUpdatedTime }`. This is required: deleting a note does not raise any surviving note's `updated_time`, and editing an attachment does not touch note `updated_time` — a max-note-`updated_time`-only check would silently skip both.

**`getAllFolderIds()`** → paginate `joplin.data.get(['folders'], { fields: ['id'] })`.

**`fingerprintsEqual(a, b)`** → true only if `maxNoteUpdatedTime`, `noteCount`, and `maxResourceUpdatedTime` all match. If a stored manifest predates this field (missing/undefined `changeFingerprint`), return `false` so the first run after upgrade always snapshots rather than silently skipping.

**`runBackup(options)` workflow:**

```
getSettings
resolveBackupRoot (optional profileName subfolder)
ensureBackupRoot
checkDiskSpace
generateSnapshotName (unique; see collision guard above)
acquireLock(lockPath, staleLimitMs)
  resolveLastSnapshot + readManifest
  currentFingerprint = getChangeFingerprint()
  if onlyOnChange && lastManifest && fingerprintsEqual(currentFingerprint, lastManifest.changeFingerprint) → setLastBackup(now); return { status: 'skipped' }
  mkdir backupRoot
  safeRmDir(activeDir); mkdir(activeDir)
  getAllFolderIds
  retryTransient(() => joplin.commands.execute('exportFolders', notebookIds, 'raw', activeDir), retries)
  collectActiveFiles(activeDir); throw if empty
  dedupResult = dedup(activeDir, lastSnapshotDir, lastManifest, activeFileList)
  buildManifest(activeDir, meta(with currentFingerprint), activeFileList, dedupResult.hashes)
  writeManifest(activeDir, manifest)
  safeRmDir(snapshotDir); fs.rename(activeDir, snapshotDir)
  atomicWriteFile(backupRoot/latest.txt, snapshotName)
  pruneSnapshots(backupRoot, max(1, retentionCount))
  setLastBackup(nowIso); setLastSnapshot(snapshotName)
  return { status: 'success', ... }
finally:
  releaseLock (catch+warn)
  safeRmDir(activeDir) (catch+warn)
```

**`verifyBackup(options)` workflow:**

- Resolve snapshot (requested or last).
- Read manifest; throw if missing.
- For each manifest file: read file, compute SHA-256 (streaming), compare to recorded; collect mismatches. Also treat missing files as mismatches.
- Return `{ ok, snapshotName, snapshotDir, total, matched, mismatches, message }`. `ok` iff no mismatches, matched === total, total > 0.
- Use `joplin.versionInfo().version` for `joplinVersion`. There is **no** `joplin.appVersion()` in the plugin API — do not call it (it throws `TypeError`).

**Reliability features:**

- Exclusive lock with stale recovery (`DEFAULT_STALE_LOCK_MS`).
- Staging dir `_joplin_active_` cleaned on failure.
- Atomic writes for manifest and `latest.txt`.
- Retry transient export errors (`isTransientExportError`, `retryTransient`).
- Disk space pre-flight (`checkDiskSpace`).
- Crash recovery in `onStart`: `ensureBackupRoot`, `safeRmDir(activeDir)`.

**Tests (`tests/backup.test.ts`):**

- Happy path: snapshot dir created, `latest.txt` written, manifest correct count.
- `onlyOnChange`: fingerprint unchanged (same note count, max note + resource `updated_time`) → skipped, no new snapshot.
- `onlyOnChange` detects a **deleted** note (note count changes even though max `updated_time` is unchanged) → new snapshot taken.
- `onlyOnChange` detects a changed **resource/attachment** (max resource `updated_time` changes) → new snapshot taken.
- Export produces zero files → error, active dir cleaned, lock released.
- Lock already held → error immediately.
- `verifyBackup` on valid snapshot → ✅; on corrupted → ❌ with mismatches.
- `joplin.versionInfo` failure → `joplinVersion` empty (no `appVersion` fallback exists).
- Snapshot name collision (two runs same second) → second run gets a `-N` suffix, does not clobber the first.

---

## Step 3 — Scheduler & Commands (`src/scheduler.ts`, `src/index.ts`) (depends on Step 2)

Wire backup execution into Joplin's UI and background timer.

**Commands:**

- Register `CreateIncrementalBackup` → calls `runBackup()`, shows dialog.
- Register `VerifyIncrementalBackup` → calls `verifyBackup()`, shows dialog.

**Menu items:** both under `Tools`.

**Scheduler (`src/scheduler.ts`):**

- `initScheduler()` — read settings; if `backupInterval > 0`, `setInterval` (hours → ms). Register `joplin.settings.onChange` (event carries `keys: string[]`) to reset the timer when `backupInterval` changes. `backupInterval = 0` is the disable mechanism — there is **no** separate `enableAutoBackup` setting, so do not listen for one.
- `executeScheduledBackup()` — call `runBackup()`, catch errors, log (ignore `EEXIST`).
- `stopScheduler()`, `startScheduler(intervalHours)`, `resetScheduler(intervalHours)` + aliases.
- `Scheduler` class + `createScheduler()`.

**Crash recovery in `onStart`:**

- `registerSettings()`.
- `ensureBackupRoot` + `safeRmDir(activeDir)` (ignore errors).
- Register commands + menu items.
- `initScheduler()`.

**Tests (`tests/scheduler.test.ts`):**

- Fake timers: advance by interval → `runBackup` called once.
- Setting change resets timer.
- Overlapping runs self-serialize via lock.

---

## Step 4 — Integration Tests & Validation (depends on Step 3)

End-to-end tests using fully mocked Joplin API + `memfs`.

**Scenarios:**

| Scenario                                       | Assert                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| First run (no previous snapshot)               | Snapshot dir created, `latest.txt` written, manifest file count correct                                             |
| Second run, no changes (`onlyOnChange = true`) | No new snapshot dir; `lastBackup` updated                                                                           |
| Third run with one changed note                | New snapshot; changed file new; unchanged files hardlinked                                                          |
| Deleted note                                   | New snapshot lacks deleted note's file (fingerprint detects count change even when max `updated_time` is unchanged) |
| Changed attachment/resource                    | New snapshot includes changed resource file (fingerprint detects resource `updated_time` change)                    |
| Retention overflow (6 snapshots, limit 5)      | Oldest snapshot dir removed                                                                                         |
| Verify on valid snapshot                       | ✅ all files match                                                                                                  |
| Verify on corrupted snapshot                   | ❌ specific file hash mismatch                                                                                      |
| Lock held during second run                    | Second run errors immediately, no partial snapshot                                                                  |

**Validation checklist:**

- [ ] `npm test` passes with ≥ 85% coverage on `backup.ts`, `manifest.ts`, `dedup.ts`, `retention.ts`, `platform.ts`.
- [ ] First run produces full snapshot and `latest.txt`.
- [ ] Second run with no changes skips snapshot creation.
- [ ] Third run with changes: only changed files are non-hardlinked.
- [ ] Retention pruning removes correct oldest snapshots.
- [ ] Snapshot directory importable via `File > Import > RAW` in Joplin.
- [ ] Plugin loads on Joplin 3.7.x; `versionInfo()` used for `joplinVersion` (no `appVersion` call).

---

## Open Items (resolve before coding)

1. ~~Plugin ID and publisher name for `manifest.json`~~ — resolved: `io.github.raytray.joplin-incremental-backup` (matches `src/manifest.json`).
2. Backup root creation — plugin creates it if absent.
3. Multi-profile support — optional subfolder under `backupPath`.
4. ~~Verify `exportFolders` 'raw' output layout on target Joplin version~~ — resolved: signature is `execute('exportFolders', folderIds, format, targetPath)`, and `'raw'` is a valid `ExportModuleOutputFormat`. Confirm the directory exists before calling (it must, per the workflow).

---

## Notes for parallel execution

- Steps `1A`–`1E` may be assigned to separate agents, but they are **not** fully independent: `1C` (manifest), `1D` (dedup), and `1E` (retention) import primitives from `1B` (platform) — `atomicWriteFile`, `computeFileSha256`, `hardlinkOrCopy`, `toDedupeKey`, `safeRmDir`. Either run `1B` first, or treat the function signatures listed in `1B` as frozen contracts and build the consumers against them.
- Step 2 requires all of `1A`–`1E` complete (it imports them).
- Step 3 requires Step 2.
- Step 4 requires Step 3.
- Within Step 2, `verifyBackup` can be implemented in parallel with `runBackup` once `readManifest`/`buildManifest` exist.
- Streaming hashes are already specified in `computeFileSha256` and double-hash elimination is designed into `runBackup` (dedup returns its hash map for reuse). Parallelizing `verifyBackup` hashing is optional polish after Step 4.
