# Review Feedback — Performance & Reliability Improvements

**Scope:** `joplin-incremental-backup` plugin (`src/`, 1 654 lines TS)
**Status:** reviewed, not yet implemented
**Target scale:** medium vault — 10–20 k notes, 5–20 GB, often on an external USB drive
**Constraint:** must keep using Joplin's native Raw export (`exportFolders`) so every snapshot stays
importable via `File > Import > RAW` without this plugin

---

## 1. Review decisions

| #   | Question                                                           | Decision                                                                                              |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1   | When may a backup fire at Joplin startup?                          | **Only when the last successful backup is at least 2× the interval old.** See §4.1 for the full rule. |
| 2   | May the completeness check keep scanning note/folder/resource ids? | **Yes — keep the scan.** The cost is < 1 % of a real backup.                                          |
| 3   | May the pagination request `limit: 1000` instead of 100?           | **Yes.** The server clamps to its own maximum; requesting more is harmless either way.                |

Also confirmed in scope: all reliability fixes (R1–R8) and the safe performance wins (P2–P5).
Explicitly **out of scope**: the opt-in "skip re-hashing unchanged files" fast path (P1b) — it has a
theoretical silent-rollback risk and is not wanted.

---

## 2. Measurements

All numbers from this machine (Node 26.7, 16 cores, NVMe), median of 7 runs.

### 2.1 Hashing

| Workload                 | Implementation                              | Time       | Throughput    |
| ------------------------ | ------------------------------------------- | ---------- | ------------- |
| 5 000 notes (548 B each) | current: 64 KB chunk, per-file buffer alloc | 664 ms     | —             |
| 5 000 notes              | `readFile` + one-shot `crypto.hash`         | 773 ms     | —             |
| 5 000 notes              | pooled/reused 64 KB buffer                  | 630 ms     | —             |
| 5 000 notes              | `fstat` + size-adaptive chunk               | 773 ms     | —             |
| 8 × 64 MB attachments    | current: 64 KB chunk                        | 481 ms     | 987 MB/s      |
| 8 × 64 MB attachments    | 256 KB chunk                                | 416 ms     | 1232 MB/s     |
| 8 × 64 MB attachments    | **1 MB chunk**                              | **302 ms** | **1636 MB/s** |
| 8 × 64 MB attachments    | 4 MB chunk                                  | 296 ms     | 1730 MB/s     |

**Conclusion:** the only real win is _size-aware chunking_ for large files (**1.6×**). The current
implementation is already at parity for many small files — the cost there is dominated by
open/read/close syscalls, not by hashing. 1 MB is the sweet spot; 4 MB adds nothing.

### 2.2 Other hot paths

| Path                        | Current                          | Improved                                            |
| --------------------------- | -------------------------------- | --------------------------------------------------- |
| Directory walk, 5 000 files | 32 ms (serial `readdir`)         | 19 ms (parallel)                                    |
| `stat` on 5 000 files       | 216 ms (unbounded `Promise.all`) | 216 ms (baseline for the fast path)                 |
| Manifest JSON, 20 k files   | 3.32 MB (pretty)                 | 2.67 MB (compact) — **not worth it**, parse is 5 ms |

### 2.3 Rejected hypotheses

Recorded so they are not re-tried:

- ❌ `readFile` + one-shot `crypto.hash` for small files — the extra `stat` costs more than it saves.
- ❌ Pooled / reused hash buffer — consistently slower.
- ❌ Compact manifest JSON — 20 % disk saved, negligible CPU, irrelevant against a 5–20 GB vault.
- ❌ `fstat`-then-choose-chunk for every file — slower for small files, so the size hint must come
  from data we already have (the walk / the manifest), not from a new syscall.

---

## 3. Findings

### Reliability

**R1 — Scheduled backups can silently never run.** `Scheduler.start()` uses
`setInterval(intervalMs)` (`src/scheduler.ts:67`), so the first tick is `interval` hours _after Joplin
launches_. `settings.lastBackup` is written but never read for scheduling. A desktop user who opens
Joplin for less than 24 h and closes it resets the timer on every launch → **no automatic backup ever
happens**. This is the single biggest real-world defect.

**R2 — Data-loss window in dedup.** `src/dedup.ts:101-102` does `fs.rm(activePath)` _then_
`hardlinkOrCopy(...)`. If the link or copy fails (ENOSPC, EIO, source vanished) the file is already
gone: the backup completes "successfully" with a file missing and no manifest entry for it.

**R3 — Stale-lock steal race, and long backups look stale.** The lock's mtime is set at creation and
never refreshed, so any backup running longer than `DEFAULT_STALE_LOCK_MS` (30 min — plausible on a
large vault over USB) has its lock judged stale. A second process deletes it (`src/platform.ts:87`) and
starts a concurrent run. Both then use the _same_ fixed staging dir `_joplin_active_`, so each one's
`safeRmDir(activeDir)` destroys the other's in-flight export. The `rm` + `tryCreate` steal is also
TOCTOU — the loser's `rm` can delete the winner's fresh lock.

**R4 — Export retries reuse a dirty staging dir.** `retryTransient` re-runs `exportFolders` into the
same `activeDir`; a failed attempt's partial files survive into the next attempt.

**R5 — No fsync.** `atomicWriteFile` renames without fsyncing the file or the parent directory → a
power cut can leave `manifest.json` / `latest.txt` empty or missing.

**R6 — Silent fallback to copy mode.** On FAT/exFAT/network shares every file is copied (full vault
per snapshot) with no explicit warning — the user believes they have dedup.

**R7 — Incomplete exports aren't detected.** Export warnings are surfaced, but the plugin never
cross-checks the export against the database, even though it already fetches every note id and throws
it away.

**R8 — Hash-map key bug.** `dedup` keys `hashes` by the lowercased path while `buildManifest` stores
by the exact path → two files differing only in case record each other's hash (false "corruption" on
verify), and 8 workers race on the same key (last-write-wins).

### Performance

**P1 — The whole vault is re-hashed every run.** `dedup()` hashes every exported file: O(total vault
bytes) per backup even when one note changed. → **Partially addressed** by §2.1 (size-aware chunking).
The remaining O(vault) behaviour is inherent to content-addressed dedup and is _not_ being changed
(P1b is out of scope).

**P2 — The change fingerprint scans every note and every resource on every run**, at
`PAGE_LIMIT = 100` → `ceil(notes/100) + ceil(resources/100)` bridge round-trips _before_ the export
starts (200 calls for 20 k notes). It also fetches the `id` field and never uses it.

**P3 — Files are walked twice and re-`stat`ed** (`collectActiveFiles` → `dedup` → `buildManifest`).

**P4 — `verifyBackup` hashes files whose size already differs** — a size mismatch is conclusive.

**P5 — Manifest is pretty-printed** — measured, **not worth changing** (§2.2).

### Not changing

The full-vault write cost of `exportFolders` is inherent to Joplin's native exporter. Exporting only
changed folders is unsafe: a deleted note is invisible to a "changed since" query, so it would linger
in every snapshot forever. Keeping the native exporter is the right trade-off for restorability.

---

## 4. Work plan

### 4.1 Workstream A — Locking & staging (R3)

#### `src/platform.ts`

- **`acquireLock(lockPath, staleLimitMs)`** — replace the `rm` + `tryCreate` steal with an **atomic
  rename-steal**:

  ```ts
  const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
  try {
    await fs.rename(lockPath, stalePath); // atomic: only one contender can win
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      // someone else already stole/released it
      if (await tryCreate()) return;
      throw createLockError(lockPath);
    }
    throw error;
  }
  await fs.rm(stalePath, { force: true });
  if (await tryCreate()) return;
  throw createLockError(lockPath);
  ```

  Only the process whose rename succeeds proceeds; the loser never deletes the winner's fresh lock.

- **`touchLock(lockPath)`** (new) — refresh the lock's mtime and content so a live backup is never
  judged stale.

#### `src/backup.ts`

- **Heartbeat** — a `setInterval` calling `touchLock` every `staleLockMs / 3` (floor 60 s) while a
  backup runs; cleared in the `finally` block. A 40-minute backup no longer looks abandoned.
- **Per-run staging dir** — `_joplin_active_` becomes a _prefix_:
  `_joplin_active_<utc-ts>_<pid>_<rand>`. Two concurrent runs can then never wipe each other's export,
  even if a lock is wrongly stolen.
  - `ACTIVE_DIR_NAME` → `ACTIVE_DIR_PREFIX` (+ `ACTIVE_DIR_PATTERN` for cleanup).
  - `recoverBackupDirs()` removes **all** stale staging dirs, and **skips recovery entirely when a
    fresh lock exists** — so a second Joplin instance pointed at the same backup root cannot destroy a
    live run.
  - Staging dirs never match `SNAPSHOT_DIR_PATTERN`, so retention never touches them.

#### Scheduler interaction (R1) — see §4.4

### 4.2 Workstream B — Dedup safety (R2, R8)

#### `src/dedup.ts`

- **Atomic replace** — link/copy to a temp name, then `rename` over the target:

  ```ts
  const tempPath = `${activePath}.dedup_tmp`;
  await fs.rm(tempPath, { force: true });
  const mode = await hardlinkOrCopy(sourcePath, tempPath);
  try {
    await fs.rename(tempPath, activePath); // atomic replace (POSIX + Windows)
  } catch (error) {
    await fs.rm(activePath, { force: true }); // Windows fallback
    await fs.rename(tempPath, activePath);
  }
  ```

  The original file is only unlinked once the replacement is safely in place. On failure the temp
  file is removed and the active file is left byte-identical.

  _Temp-file safety:_ the temp file is created after `activeFiles` is collected and the manifest is
  built from that same list, so it is never included in the manifest. It is renamed away on success
  and removed on failure; a crash leaves the whole staging dir, which is wiped on the next run.

- **Exact-path hash keys** — `hashes` is keyed by the exact relative path (forward slashes, **no**
  lowercasing). New helper `toManifestKey()` in `src/platform.ts`; `toDedupeKey()` (lowercased)
  remains in use for the _dedup index_ only, where case-insensitive matching is desirable.
  - `src/manifest.ts` — `buildManifest()` looks up `precomputedHashes` by the exact path.
- **Injected hasher** — `dedup()` accepts a `computeHash` function, matching
  `BackupOptions.computeHash` in `verifyBackup`.

_No change needed to the match logic:_ `findMatch()` already requires the SHA-256 to match before
hardlinking, so a same-path / same-size / different-content file is never linked to stale content.

### 4.3 Workstream C — Export hygiene (R4, R7)

#### `src/backup.ts`

- **Clean staging between retries** — the wipe moves _inside_ the retried function so each attempt
  starts from an empty directory:

  ```ts
  const exportResult = await retryTransient(async () => {
    await safeRmDir(activeDir);
    await fs.mkdir(activeDir, { recursive: true });
    return joplin.commands.execute('exportFolders', folderIds, EXPORT_FORMAT, activeDir);
  }, context.exportRetries);
  ```

- **Completeness check** — reuse the ids the notes query already fetches:
  - every note id from the DB must have a `<id>.md` in the export root;
  - every folder id must have a `<id>.md` in the export root;
  - the number of files under `resources/` must be ≥ the DB resource count.
  - Mismatches are appended to `BackupResult.warnings` (logged + shown in the dialog), **not** raised
    as errors — encrypted/trashed items can legitimately produce false positives, and a hard failure
    would block backups entirely.
  - Tags / note-tags are not checked (they would need extra scans); documented as a known gap.

### 4.4 Workstream D — Scheduler catch-up (R1)

#### `src/scheduler.ts`

Replace `setInterval` with a **self-rearming `setTimeout`** driven by a due time.

```ts
const CATCH_UP_OVERDUE_FACTOR = 2; // startup catch-up only at >= 2x the interval
const CATCH_UP_GRACE_MS = 5_000; // let Joplin finish starting before exporting
const RETRY_DELAY_MS = 5 * 60_000; // after a failed run, retry sooner than a full interval
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // Node's setTimeout overflows above this and fires immediately
```

**Startup rule** (decision #1), evaluated in `init()` from `settings.lastBackup`:

```
age = now - lastBackupMs

lastBackup unknown            → run at startup (first-ever backup)
age >= 2 * intervalMs         → run at startup (badly overdue: at least 2x the interval)
age >= intervalMs             → do NOT run at startup; schedule at the next interval boundary
                                 lastBackup + ceil(age / intervalMs) * intervalMs
age <  intervalMs             → schedule at lastBackup + intervalMs - age
```

_Consequence, stated explicitly:_ when Joplin is closed for most of the day, the effective cadence
degrades from 24 h to 48 h instead of never running at all (today's behaviour). If strict 24 h
spacing matters more than not exporting at launch, replace the "next interval boundary" branch with
`now + intervalMs` — a one-line change.

**Other scheduler rules**

- The armed delay is capped at `MAX_TIMEOUT_MS` and re-armed, because Node's `setTimeout` fires
  _immediately_ above 2³¹−1 ms. The current `setInterval` has the same overflow for intervals above
  24.8 days, and the setting allows up to 8 760 h (365 days).
- After a successful or skipped run → re-arm at `now + intervalMs`.
- After a failed run (`executeScheduledBackup()` returns `null`) → re-arm after `RETRY_DELAY_MS`
  rather than waiting a full interval.
- `start(intervalHours, lastBackupIso?)`; `init()` feeds `settings.lastBackup` in.
- `handleSettingsChange` re-arms with the new interval and the current `lastBackup`.
- Dependency injection changes `setIntervalFn` / `clearIntervalFn` → `setTimeoutFn` /
  `clearTimeoutFn` (`tests/scheduler.test.ts` updated accordingly).
- `settings.lastBackup` is an ISO string → parsed with `Date.parse`; unparseable values are treated
  as "never backed up".

### 4.5 Workstream E — Walk, sizes, hashing (P3, P1a)

#### `src/platform.ts`

- **`collectEntries(dir, baseDir)`** (new) — parallel directory walk returning
  `Array<{ path: string; size: number }>`. One `stat` per file — the same count the current code
  performs in `buildManifest`, just done once, in parallel, and reused.
  `collectFilesRecursive()` is kept as a thin wrapper for compatibility.
- **`computeFileSha256(filePath, sizeHint?)`** — chunk size is 64 KB for files ≤ 64 KB and 1 MB
  above that. With a `sizeHint` there is **no extra `stat`**; without one it stats the file first.

#### `src/backup.ts` / `src/manifest.ts`

- `runBackup()` uses `collectEntries()` and passes the entries to both `dedup()` (as hash hints) and
  `buildManifest()` (as sizes).
- `buildManifest()` accepts `Array<string | { path, size }>` and skips the per-file `stat` when a size
  is supplied → removes ~200 ms per 20 k files per backup.
- `dedup()` passes the size hint into the hasher → large attachments hash **1.6× faster**.
- `verifyBackup()` compares the **size first** (a size mismatch is conclusive) and only hashes when
  the size matches; the manifest's size is passed as the hash hint.

#### `src/backup.ts` — fingerprint (P2)

- `PAGE_LIMIT` 100 → **1000**. The Clipper route clamps to its own maximum; requesting more is
  harmless and turns 200 round-trips into 20 when the server allows it. A `logger.debug` line records
  the observed page size so the effective limit can be confirmed on a real Joplin 3.7 install.
- The notes query keeps `id` + `updated_time` (the ids are needed for the completeness check, §4.3).
- The resources query keeps `updated_time` only (the count is enough for the resource check).
- The scan is **not** skipped when `onlyOnChange` is off (decision #2) — it is the completeness
  check's data source and measures < 1 % of a real backup.

### 4.6 Workstream F — Copy-mode warning (R6)

#### `src/backup.ts` / `src/index.ts`

- When a previous snapshot existed and `copied > 0 && hardlinked === 0`, append a warning:
  _"hardlinks are not supported on this filesystem — every file was copied, so each snapshot consumes
  the full vault size."_
- The warning flows through the existing `BackupResult.warnings` channel, so it is logged and shown in
  the backup dialog with no UI changes.

### 4.7 Workstream G — fsync (R5)

#### `src/platform.ts`

`atomicWriteFile()`:

1. open `<target>.tmp`, write the content, `handle.sync()`, close;
2. `fs.rename(tmp, target)` (existing EEXIST/EPERM fallback retained);
3. best-effort `fsync` of the parent directory — open the dir, `handle.sync()`, close; ignore
   failures (Windows cannot fsync a directory this way, and some filesystems reject it).

This makes `manifest.json` and `latest.txt` survive a power cut. The exported files themselves are
left to the OS writeback — fsyncing 20 k files is not worth it. This trade-off is documented in the
README.

---

## 5. Test plan

Existing suites stay memfs-based; coverage thresholds unchanged (85 / 85 / 85 / 75).

| Workstream | New tests                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A          | Two contenders race for a stale lock → exactly one wins, the loser gets `EEXIST`; `touchLock` refreshes the mtime; two runs get distinct staging dirs; `recoverBackupDirs` removes stale staging dirs but spares a fresh one and skips entirely when a fresh lock exists                                                                                                                                          |
| B          | A failed link leaves the original file byte-identical; the copy fallback still works; a failed `rename` cleans up the temp file; case-only-different paths get distinct hashes; the injected hasher is used                                                                                                                                                                                                       |
| C          | A failed attempt's files do not leak into the retry; a missing note / folder / resource surfaces a warning; a clean export produces no warnings; warnings survive into `BackupResult.warnings`                                                                                                                                                                                                                    |
| D          | Never backed up → runs at startup; `age ≥ 2 × interval` → runs at startup; `interval ≤ age < 2 × interval` → does **not** run at startup, schedules at the next boundary; `age < interval` → schedules at the remaining time; re-arm after a success; 5-minute re-arm after a failure; the `setTimeout` delay is capped at 2³¹−1 and re-armed; interval 0 still disables the scheduler; a settings change re-arms |
| E          | `collectEntries` returns paths + sizes; `buildManifest` reuses the supplied sizes (no second `stat`); `verifyBackup` short-circuits on a size mismatch; a file > 64 KB uses the 1 MB chunk; the pagination honours a 1 000-item request and still works when the server clamps to 100                                                                                                                             |
| F          | The copy-mode warning appears when hardlinks are unavailable and is absent when they work                                                                                                                                                                                                                                                                                                                         |
| G          | `atomicWriteFile` produces the correct content with `sync` called; a directory fsync failure is ignored                                                                                                                                                                                                                                                                                                           |

**Mock change required:** `src/__mocks__/joplin.ts` currently ignores `query.limit` and always uses
`mockState.dataPageLimit` (100). It must honour the requested limit (capped by a simulated server
maximum) so pagination can be tested at both the requested and the clamped page size.

---

## 6. Order of work

1. **B** — dedup safety (self-contained, highest value per line changed)
2. **A** — lock heartbeat, atomic steal, per-run staging dirs
3. **D** — scheduler catch-up (heaviest test churn)
4. **C** — export hygiene and completeness check
5. **E** — walk, sizes, size-aware hashing, pagination
6. **F**, **G** — copy-mode warning, fsync
7. **README** — staging layout, catch-up behaviour, new warnings, fsync trade-off

Roughly **700–900 lines** changed across `src/` and `tests/`.

---

## 7. Risks & known gaps

- **Catch-up cadence** — decision #1 means the effective interval can stretch to 2× when Joplin is
  closed most of the day (documented in §4.4, one-line switch to change).
- **Completeness check false positives** — encrypted or trashed items that the exporter skips can
  look like missing notes. Mitigated by making it a warning, and by the exporter's own warnings
  already being surfaced.
- **Tags / note-tags are not completeness-checked** — would need additional scans.
- **`limit: 1000`** — effective limit must be confirmed on a real Joplin 3.7 install; the debug log
  of the observed page size is the mechanism.
- **fsync scope** — only the manifest and `latest.txt` are fsynced; exported file contents rely on
  OS writeback.
- **Per-run staging dirs** — a crash leaves one behind; `recoverBackupDirs()` removes them on the
  next start, and they never match the retention pattern.
