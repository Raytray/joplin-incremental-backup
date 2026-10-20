# Joplin Incremental Backup Plugin — Parallel Agent Plan

**Stack:** TypeScript · Webpack · Jest · Node.js `fs/promises` · Joplin Plugin API  
**Approach:** Deduplicated full snapshots via Joplin's native Raw export (rsnapshot-style hardlinks + copy fallback)  
**Restore:** Each snapshot is independently importable via `File > Import > RAW - Joplin Export Directory`

---

## Dependency Graph

```
[Step 0: Scaffold]
       │
       ├──────────────────────────────────────────┐
       │                                          │
[Step 1A: Settings]               [Step 1B: Cross-Platform Utils]
[Step 1C: Manifest]               [Step 1D: Dedup Engine]
[Step 1E: Retention]
       │                                          │
       └──────────────┬───────────────────────────┘
                      │
              [Step 2: Backup Engine]
                      │
              [Step 3: Scheduler & Commands]
                      │
              [Step 4: Integration Tests & Validation]
```

> Steps `1A`, `1B`, `1C`, `1D`, `1E` are fully independent and can run in parallel after Step 0 completes.

---

## Step 0 — Scaffold (blocking, run first)

Initialize the plugin project. All subsequent steps depend on this.

- Generate plugin boilerplate: `manifest.json`, `package.json`, `tsconfig.json`, `webpack.config.js`, `jest.config.js`
- Entry point: `src/index.ts` with `joplin.plugins.register({ onStart })` shell
- Install dependencies: `jest`, `ts-jest`, `@types/jest`, `memfs`
- Create `src/__mocks__/joplin.ts` — stub for all `joplin.*` API calls used in tests
- **Test:** `npm test` passes with empty suite; `npm run build` produces a loadable plugin bundle

---

## Step 1A — Settings (`src/settings.ts`) ★ parallel

Register all user-facing and hidden settings with the Joplin settings API.

**Settings to register:**

| Key | Type | Default | Notes |
|---|---|---|---|
| `backupPath` | `String` | `""` | Absolute path to backup root |
| `backupRetention` | `Int` | `5` | Number of snapshots to keep |
| `backupInterval` | `Int` | `24` | Auto-backup interval in hours; `0` = disabled |
| `onlyOnChange` | `Bool` | `true` | Skip snapshot if nothing changed |
| `lastBackup` | `String` | `""` | Hidden — ISO timestamp of last run |
| `lastSnapshot` | `String` | `""` | Hidden — directory name of last snapshot |

**Implementation:**
- `registerSettings()` — call `joplin.settings.registerSection` + `joplin.settings.registerSettings`
- `getSettings()` — return validated config object; throw descriptive error if `backupPath` is empty
- Validate `backupPath` length ≤ 180 characters on Windows to avoid MAX_PATH issues (detect via `process.platform === 'win32'`)

**Tests (`tests/settings.test.ts`):**
- Mocked `joplin.settings.value` returns correct typed values
- `getSettings()` throws when `backupPath` is empty
- `backupInterval = 0` correctly signals disabled scheduler
- Path length warning fires when path exceeds threshold on Windows

---

## Step 1B — Cross-Platform Utilities (`src/platform.ts`) ★ parallel

Implement all OS-sensitive primitives so every other module stays platform-agnostic.

**Functions to implement:**

```typescript
// Atomic file write — safe on Windows (unlink-before-rename fallback)
atomicWriteFile(targetPath: string, content: string): Promise<void>

// Exclusive lock — cross-platform using O_EXCL 'wx' flag
acquireLock(lockPath: string, staleLimitMs: number): Promise<void>
releaseLock(lockPath: string): Promise<void>

// Hardlink with copy fallback — catches EPERM, ENOTSUP, EXDEV, ENOSYS
hardlinkOrCopy(src: string, dest: string): Promise<'hardlink' | 'copy'>

// Case-insensitive path key for dedup map — lowercased, forward-slash normalized
toDedupeKey(relativePath: string): string

// Cleanup directory — catches EBUSY on Windows, warns instead of throwing
safeRmDir(dirPath: string): Promise<void>
```

**Rules:**
- `atomicWriteFile`: write to `<target>.tmp`, then `fs.rename`; if rename throws `EEXIST`, unlink dest first, then rename
- `acquireLock`: if lock file is older than `staleLimitMs`, delete it and retry once; if still blocked, throw
- `toDedupeKey`: `relativePath.toLowerCase().replace(/\\/g, '/')`

**Tests (`tests/platform.test.ts`) using `memfs`:**
- `atomicWriteFile` overwrites existing file without error on all simulated platforms
- `acquireLock` throws `EEXIST` when lock already held; succeeds after stale timeout
- `hardlinkOrCopy` returns `'copy'` when `fs.link` throws `EPERM`
- `toDedupeKey` normalizes Windows backslashes and uppercased paths

---

## Step 1C — Manifest (`src/manifest.ts`) ★ parallel

Track snapshot state and per-file integrity data.

**`Manifest` interface:**

```typescript
interface FileEntry {
  path: string;      // relative path within snapshot
  size: number;
  sha256: string;
}

interface Manifest {
  snapshotId: string;        // ISO timestamp string
  createdAt: number;         // Unix ms
  joplinVersion: string;
  lastChangeTime: number;    // last detected data change (Unix ms)
  fileCount: number;
  files: FileEntry[];
  deduplication: 'hardlink' | 'copy' | 'none';
}
```

**Functions:**
- `readManifest(snapshotDir)` — parse `manifest.json`; return `null` if absent or malformed
- `writeManifest(snapshotDir, manifest)` — use `atomicWriteFile` from `platform.ts`
- `buildManifest(snapshotDir, meta)` — walk directory, compute SHA-256 per file, return complete `Manifest`

**Tests (`tests/manifest.test.ts`) using `memfs`:**
- Returns `null` for missing or malformed `manifest.json`
- Round-trips correctly (write → read → equals original)
- `buildManifest` produces correct `fileCount` and SHA-256 hashes for seeded virtual files

---

## Step 1D — Deduplication Engine (`src/dedup.ts`) ★ parallel

Replace files in the active export with hardlinks to the previous snapshot where content is identical.

**Algorithm:**
1. Walk all files in `activeDir` recursively
2. Compute SHA-256 for each file
3. Normalize relative path via `toDedupeKey` (from `platform.ts`)
4. Look up path in previous snapshot manifest:
   - Same path + same hash → hardlink to previous snapshot's file
   - Different path but same hash → hardlink to that file (content-addressed fallback)
   - No match → keep as-is (new or changed file)
5. Use `hardlinkOrCopy` — record mode returned (`'hardlink'` vs `'copy'`) for manifest

**Returns:** `{ hardlinked: number, copied: number, unchanged: number }`

**Tests (`tests/dedup.test.ts`) using `memfs`:**
- Identical file gets hardlinked; `hardlinked` count increments
- Changed file is kept; `unchanged` count increments
- New file (no prior match) is kept; `unchanged` count increments
- When `fs.link` throws `EPERM`, file is copied and `copied` count increments
- Hash collision across different paths correctly hardlinks

---

## Step 1E — Retention & Pruning (`src/retention.ts`) ★ parallel

Enforce the snapshot retention limit after each successful backup.

**Functions:**
- `listSnapshots(backupRoot)` — return snapshot directory names sorted oldest-first (match pattern `^\d{8}T\d{6}$`)
- `pruneSnapshots(backupRoot, retentionCount)` — delete oldest snapshots until count ≤ `retentionCount`; use `safeRmDir` from `platform.ts`

**Hardlink pruning note:** deleting an old snapshot directory only removes that directory's entries. Files still hardlinked by newer snapshots remain intact — this is the correct behavior and requires no special handling.

**Tests (`tests/retention.test.ts`) using `memfs`:**
- 10 snapshots + `retentionCount = 5` → 5 oldest deleted, 5 newest remain
- `retentionCount = 5` with only 3 snapshots → zero deletions
- Snapshot directories not matching the timestamp pattern are ignored
- `safeRmDir` failure (simulated EBUSY) is caught; remaining snapshots unaffected

---

## Step 2 — Backup Engine (`src/backup.ts`) (depends on 1A, 1B, 1C, 1D)

Orchestrate one full backup run.

**Workflow (in order):**

```
acquireLock
  → getSettings (validate backupPath)
  → check onlyOnChange: read lastSnapshot manifest, compare joplin.data.get(['notes'], {fields:['updated_time']}) max time vs lastBackup; skip if equal
  → mkdir backupRoot if absent
  → mkdir _joplin_active_ (clean up any leftover first via safeRmDir)
  → joplin.data.get(['folders']) → collect all notebook IDs
  → joplin.commands.execute('exportFolders', notebookIds, 'raw', activeDir)
  → verify export: count files in activeDir; throw if zero
  → dedup(activeDir, lastSnapshotDir)
  → buildManifest(activeDir)
  → writeManifest(activeDir, manifest)
  → fs.rename(activeDir, snapshotDir)   [new name = ISO timestamp e.g. 20261019T140000]
  → atomicWriteFile(backupRoot/latest.txt, snapshotDirName)
  → pruneSnapshots(backupRoot, retentionCount)
  → joplin.settings.setValue('lastBackup', now ISO)
  → joplin.settings.setValue('lastSnapshot', snapshotDirName)
releaseLock (finally block — always runs)
safeRmDir(_joplin_active_) (finally block — clean up on failure)
```

**Tests (`tests/backup.test.ts`):**
- Happy path: mock export produces files → snapshot directory created, `latest.txt` written, manifest present
- `onlyOnChange`: no new `updated_time` → function returns early, no new snapshot directory
- Export produces zero files → error thrown, active dir cleaned up, lock released
- Lock already held → error thrown immediately

---

## Step 3 — Scheduler & Commands (`src/index.ts`, `src/scheduler.ts`) (depends on Step 2)

Wire backup execution into Joplin's UI and background timer.

**Commands to register:**
- `joplin.commands.register('CreateIncrementalBackup')` — calls `runBackup()`, shows completion/error dialog
- `joplin.commands.register('VerifyIncrementalBackup')` — reads `latest.txt`, parses manifest, checks each file's SHA-256 matches recorded hash, reports results

**Menu items:**
- Add both commands under `Tools` menu via `joplin.views.menuItems.create`

**Scheduler (`src/scheduler.ts`):**
- On `onStart`: if `backupInterval > 0`, set interval timer (`backupInterval` hours)
- `joplin.settings.onChange` listener: clear and reset timer whenever `backupInterval` or `enableAutoBackup` changes
- Guard against overlapping runs via the lock (backup naturally self-serializes)

**Notifications:**
- On success: `joplin.views.dialogs` toast or `console.info` log with snapshot path and stats
- On failure: dialog with error message and path to clean up if needed

**Tests (`tests/scheduler.test.ts`):**
- `jest.useFakeTimers()`: advance clock by `backupInterval` hours → `runBackup` called once
- Setting change resets timer: old interval cancelled, new interval registered
- Overlapping manual + scheduled run: second call exits immediately (lock held)

---

## Step 4 — Integration Tests & Validation (depends on Step 3)

End-to-end tests using fully mocked Joplin API + `memfs`.

**Test scenarios:**

| Scenario | Assert |
|---|---|
| First run (no previous snapshot) | Snapshot dir created, `latest.txt` written, manifest has correct file count |
| Second run, no changes (`onlyOnChange = true`) | No new snapshot dir; `lastBackup` updated |
| Third run with one changed note | New snapshot; changed file is new; unchanged files are hardlinked |
| Deleted note | New snapshot does not contain deleted note's file |
| Retention overflow (6 snapshots, limit 5) | Oldest snapshot dir removed |
| Verify command on valid snapshot | Reports ✅ all files match |
| Verify command on corrupted snapshot | Reports ❌ specific file hash mismatch |
| Lock held during second run | Second run returns error immediately without creating partial snapshot |

**Validation checklist:**
- [ ] `npm test` passes with ≥ 85% coverage on `backup.ts`, `manifest.ts`, `dedup.ts`, `retention.ts`, `platform.ts`
- [ ] First run produces full snapshot and `latest.txt`
- [ ] Second run with no changes skips snapshot creation
- [ ] Third run with changes produces snapshot where only changed files are non-hardlinked
- [ ] Retention pruning removes correct oldest snapshots
- [ ] Snapshot directory is importable via `File > Import > RAW` in Joplin

---

## Open Items (resolve before coding)

1. **Plugin ID and publisher name** for `manifest.json`
2. **Backup root creation** — should the plugin create it, or require it to pre-exist?
3. **Multi-profile support** — add a profile-name subfolder under `backupPath`?
4. **`joplin.appVersion()`** — confirm API to retrieve Joplin version for manifest
