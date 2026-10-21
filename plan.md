# Joplin Incremental Backup Plugin — Full Recreation Plan

**Stack:** TypeScript · Webpack · Vitest · Node.js `fs/promises` · Joplin Plugin API (desktop)  
**Approach:** Deduplicated full snapshots via Joplin's native Raw export (rsnapshot-style hardlinks + copy fallback)  
**Restore:** Each snapshot is independently importable via `File > Import > RAW - Joplin Export Directory`  
**Target:** Joplin 2.14+ (developed/tested against 3.7.x)

This plan recreates the plugin from an empty repository, including hashing, verification,
deduplication, reliability, scheduling, and test coverage. Steps marked ★ are independent
and may run in parallel once their dependencies are satisfied.

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

Steps `1A`–`1E` are fully independent after Step 0.

---

## Step 0 — Scaffold (blocking, run first)

Initialize the plugin project. All subsequent steps depend on this.

- Create `manifest.json`:
  ```json
  {
    "manifest_version": 1,
    "id": "io.github.raytray.joplin-incremental-backup",
    "app_min_version": "2.14",
    "name": "Incremental Backup",
    "description": "Deduplicated incremental snapshots of your Joplin data using the native Raw export format.",
    "author": "raytray",
    "homepage_url": "",
    "version": "0.1.0",
    "platforms": ["desktop"]
  }
  ```
- Create `package.json` with scripts: `build`, `dev`, `test`, `test:coverage`, `lint`, `format`, `format:check`.
- Dependencies (dev): `typescript`, `webpack`, `webpack-cli`, `ts-loader`, `jest`, `ts-jest`, `@types/jest`, `@types/node`, `vitest`, `@vitest/coverage-v8`, `memfs`, `oxlint`, `prettier`.
- Create `tsconfig.json` (target ES2018, module commonjs, strict, types jest+node).
- Create `tsconfig.build.json` excluding tests.
- Create `webpack.config.js` (entry `src/index.ts`, output `publish/index.js`, ts-loader).
- Create `jest.config.js` with `moduleNameMapper` mapping `api` and `api/types` to `src/__mocks__/joplin.ts`.
- Create `vitest.config.ts`.
- Entry point `src/index.ts` with `joplin.plugins.register({ onStart })` shell.
- Create `src/__mocks__/joplin.ts` stub for all `joplin.*` API calls (`plugins`, `settings`, `commands`, `views`, `data`, `appVersion`, `versionInfo`).
- Create `src/api.d.ts` ambient declarations for `api` and `api/types` (include `versionInfo()` plus optional `appVersion()`).
- Create `src/logger.ts` lightweight prefixed logger.

**Tests:** `npm test` passes with empty suite; `npm run build` produces a loadable bundle.

---

## Step 1A — Settings (`src/settings.ts`) ★ parallel

Register all user-facing and hidden settings with the Joplin settings API.

**Settings to register:**

| Key               | Type     | Default | Notes                                         |
| ----------------- | -------- | ------- | --------------------------------------------- |
| `backupPath`      | `String` | `""`    | Absolute path to backup root                  |
| `backupRetention` | `Int`    | `5`     | Number of snapshots to keep                   |
| `backupInterval`  | `Int`    | `24`    | Auto-backup interval in hours; `0` = disabled |
| `onlyOnChange`    | `Bool`   | `true`  | Skip snapshot if nothing changed              |
| `lastBackup`      | `String` | `""`    | Hidden — ISO timestamp of last run            |
| `lastSnapshot`    | `String` | `""`    | Hidden — directory name of last snapshot      |

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
- `toDedupeKey`: `relativePath.toLowerCase().replace(/\\/g, '/')`.
- `safeRmDir`: catch `EBUSY` on Windows, warn instead of throwing.
- `computeFileSha256`: stream file in 64KB chunks (not whole-file read).
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
  fileCount: number;
  files: FileEntry[];
  deduplication: DeduplicationMode;
}
```

**Functions:**

- `isValidManifest(obj)` — type guard.
- `readManifest(snapshotDir)` — parse `manifest.json`; return `null` if absent/malformed.
- `writeManifest(snapshotDir, manifest)` — use `atomicWriteFile`.
- `buildManifest(snapshotDir, meta, filePaths?)` — walk directory (or use provided paths), compute SHA-256 per file via streaming, return complete `Manifest`. Sort files by path.
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

**Returns:** `{ hardlinked: number, copied: number, unchanged: number }`.

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

- `listSnapshots(backupRoot)` — return snapshot dir names matching `^\d{8}T\d{6}$`, sorted oldest-first. Ignore non-matching. Return `[]` if root missing.
- `pruneSnapshots(backupRoot, retentionCount)` — delete oldest until count ≤ retentionCount; use `safeRmDir`. Catch EBUSY, skip that snapshot.

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

**`generateSnapshotName(date)`** → `YYYYMMDDTHHMMSS` (UTC).

**`resolveLastSnapshot(backupRoot, preferredSnapshotName?)`** → check settings.lastSnapshot, then `latest.txt`, then newest in backupRoot.

**`getMaxNotesUpdatedTime()`** → paginate `joplin.data.get(['notes'], { fields: ['updated_time'] })`, return max.

**`getAllFolderIds()`** → paginate `joplin.data.get(['folders'], { fields: ['id'] })`.

**`runBackup(options)` workflow:**

```
getSettings
resolveBackupRoot (optional profileName subfolder)
ensureBackupRoot
checkDiskSpace
acquireLock(lockPath, staleLimitMs)
  resolveLastSnapshot + readManifest
  getMaxNotesUpdatedTime
  if onlyOnChange && lastSnapshot && lastManifest && unchanged → setLastBackup(now); return { status: 'skipped' }
  mkdir backupRoot
  safeRmDir(activeDir); mkdir(activeDir)
  getAllFolderIds
  retryTransient(() => joplin.commands.execute('exportFolders', notebookIds, 'raw', activeDir), retries)
  collectActiveFiles(activeDir); throw if empty
  dedup(activeDir, lastSnapshotDir, lastManifest, activeFileList)
  buildManifest(activeDir, meta, activeFileList)
  writeManifest(activeDir, manifest)
  safeRmDir(snapshotDir); fs.rename(activeDir, snapshotDir)
  atomicWriteFile(backupRoot/latest.txt, snapshotName)
  pruneSnapshots(backupRoot, retentionCount)
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
- Prefer `joplin.versionInfo()` for `joplinVersion`, fall back to `joplin.appVersion()`.

**Reliability features:**

- Exclusive lock with stale recovery (`DEFAULT_STALE_LOCK_MS`).
- Staging dir `_joplin_active_` cleaned on failure.
- Atomic writes for manifest and `latest.txt`.
- Retry transient export errors (`isTransientExportError`, `retryTransient`).
- Disk space pre-flight (`checkDiskSpace`).
- Crash recovery in `onStart`: `ensureBackupRoot`, `safeRmDir(activeDir)`.

**Tests (`tests/backup.test.ts`):**

- Happy path: snapshot dir created, `latest.txt` written, manifest correct count.
- `onlyOnChange`: no new updated_time → skipped, no new snapshot.
- Export produces zero files → error, active dir cleaned, lock released.
- Lock already held → error immediately.
- `verifyBackup` on valid snapshot → ✅; on corrupted → ❌ with mismatches.
- `joplin.versionInfo`/`appVersion` failure → `joplinVersion` empty.

---

## Step 3 — Scheduler & Commands (`src/scheduler.ts`, `src/index.ts`) (depends on Step 2)

Wire backup execution into Joplin's UI and background timer.

**Commands:**

- Register `CreateIncrementalBackup` → calls `runBackup()`, shows dialog.
- Register `VerifyIncrementalBackup` → calls `verifyBackup()`, shows dialog.

**Menu items:** both under `Tools`.

**Scheduler (`src/scheduler.ts`):**

- `initScheduler()` — read settings; if interval > 0, `setInterval` (hours → ms). Register `joplin.settings.onChange` to reset timer on `backupInterval`/`enableAutoBackup` change.
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

| Scenario                                       | Assert                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| First run (no previous snapshot)               | Snapshot dir created, `latest.txt` written, manifest file count correct |
| Second run, no changes (`onlyOnChange = true`) | No new snapshot dir; `lastBackup` updated                               |
| Third run with one changed note                | New snapshot; changed file new; unchanged files hardlinked              |
| Deleted note                                   | New snapshot lacks deleted note's file                                  |
| Retention overflow (6 snapshots, limit 5)      | Oldest snapshot dir removed                                             |
| Verify on valid snapshot                       | ✅ all files match                                                      |
| Verify on corrupted snapshot                   | ❌ specific file hash mismatch                                          |
| Lock held during second run                    | Second run errors immediately, no partial snapshot                      |

**Validation checklist:**

- [ ] `npm test` passes with ≥ 85% coverage on `backup.ts`, `manifest.ts`, `dedup.ts`, `retention.ts`, `platform.ts`.
- [ ] First run produces full snapshot and `latest.txt`.
- [ ] Second run with no changes skips snapshot creation.
- [ ] Third run with changes: only changed files are non-hardlinked.
- [ ] Retention pruning removes correct oldest snapshots.
- [ ] Snapshot directory importable via `File > Import > RAW` in Joplin.
- [ ] Plugin loads on Joplin 3.7.x; `versionInfo()` used with `appVersion()` fallback.

---

## Open Items (resolve before coding)

1. Plugin ID and publisher name for `manifest.json`.
2. Backup root creation — plugin creates it if absent.
3. Multi-profile support — optional subfolder under `backupPath`.
4. Verify `exportFolders` 'raw' output layout on target Joplin version.

---

## Notes for parallel execution

- Steps `1A`–`1E` have no cross-dependencies; assign to separate agents.
- Step 2 requires all of `1A`–`1E` complete (it imports them).
- Step 3 requires Step 2.
- Step 4 requires Step 3.
- Within Step 2, `verifyBackup` can be implemented in parallel with `runBackup` once `readManifest`/`buildManifest` exist.
- Performance work (streaming hashes, parallel verification, double-hash elimination) is optional polish after Step 4; see `performance.md`.
