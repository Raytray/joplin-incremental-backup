# Incremental Backup for Joplin

A Joplin desktop plugin that creates **deduplicated incremental snapshots** of your notebooks using Joplin's native **Raw export format** — the same format produced by `File > Export > RAW - Joplin Export Directory`.

Each snapshot is a complete, self-contained copy of your data. Consecutive snapshots share unchanged files via hardlinks (rsnapshot-style), so storing dozens of snapshots costs only a fraction of the space of full copies. If hardlinks aren't supported on your backup drive (e.g. some network shares or FAT/exFAT drives), the plugin transparently falls back to plain copies.

> **Status:** in development. The plugin requires Joplin 3.2+ and desktop only — Joplin's mobile apps do not support plugins.

## What it does

- **Automatic snapshots** — backs up all notebooks on a configurable interval (default: every 24 hours), or on demand from the Tools menu.
- **Deduplication** — files that are byte-identical to the previous snapshot are stored as hardlinks instead of copies. Changed and new files are stored normally, so every snapshot remains complete on its own.
- **Content-addressed matching** — files are matched by SHA-256 hash, so even renamed or moved notes don't consume extra space.
- **Retention pruning** — keeps a configurable number of snapshots (default: 5) and automatically deletes the oldest ones. Deleting an old snapshot never damages newer ones, because hardlinked files are only removed when no snapshot references them.
- **Skip unchanged backups** — if nothing has changed since the last snapshot (notes, attachments, notebooks, tags, or which notes carry which tags), the backup is skipped entirely (can be disabled).
- **Integrity verification** — every snapshot includes a `manifest.json` with the size and SHA-256 hash of every file. A verify command re-checks the whole snapshot and reports any missing or corrupted files.
- **Crash-safe** — each backup run stages its files in a unique temporary directory (e.g. `_joplin_active_20261021T090000_12345_abcdef`) that is atomically renamed into place when complete. An exclusive lock prevents overlapping runs; the lock's mtime is refreshed periodically so a long export is never mistaken for an abandoned one. Stale locks are recovered atomically (rename-steal), and leftover staging data is cleaned up on startup unless another backup holds a fresh lock.
- **Optional local staging** — with **Stage the export on this computer** on (under Advanced), the export goes to a temporary folder in the Joplin profile instead of the backup drive. Unchanged files are then hardlinked from the previous snapshot and only new or changed files are copied to the drive, so a daily backup of a large vault writes only what changed. See [Local staging](#local-staging).
- **Disk-space pre-flight** — checks available space before starting a backup and aborts the run if the backup drive is below the minimum free-space threshold, so a full disk can't produce a truncated snapshot. (If free space can't be measured on a platform, the backup proceeds with a warning.)
- **Export warnings surfaced** — if Joplin's exporter skips any item (e.g. still-encrypted notes), the warnings are logged and shown in the backup dialog so an incomplete snapshot isn't mistaken for a complete one.
- **Export completeness check** — after each export, the plugin compares the note/folder/resource counts from Joplin's database against the exported files. Missing items (often due to still-encrypted content) are reported as warnings.
- **Copy-mode warning** — if a previous snapshot exists but the filesystem doesn't support hardlinks (so every file had to be copied), a warning is shown so you know each snapshot consumes the full vault size.
- **Durable metadata** — `manifest.json` and `latest.txt` are fsynced before and after the atomic rename, and a best-effort directory fsync is attempted so a power cut can't corrupt the snapshot index. Exported files themselves are left to OS writeback; fsyncing 20 k files per backup would be prohibitive.

## How to use

1. Install the plugin and open **Tools > Options > Incremental Backup**.
2. Set **Backup location** to an absolute path on a local drive (a dedicated external drive or a second partition is ideal — hardlinks don't work across filesystems or on most network shares).
3. Optionally adjust:
   - **Backup interval (hours)** — `0` disables automatic backups.
   - **Snapshots to keep** — oldest snapshots beyond this count are pruned.
   - **Skip if nothing changed** — on by default.
   - **Stage the export on this computer** (Advanced) — off by default. See [Local staging](#local-staging).
4. Backups now run automatically on the interval. You can also trigger one any time via **Tools > Create incremental backup**, and check snapshot health via **Tools > Verify incremental backup**.

### Backup layout

```
<backup path>/
├── 20261020T143022/              ← snapshot (UTC timestamp)
│   ├── manifest.json             ← file list with SHA-256 hashes
│   ├── <note-id>.md              ← one file per note (Raw export format)
│   ├── resources/
│   │   └── <resource-id>         ← one file per attached resource
│   └── ...                       ← plus folders/tags/note-tags as <id>.md
├── 20261021T090000/              ← next snapshot (unchanged files hardlinked)
├── _joplin_active_20261021T090000_12345_abcdef/  ← staging dir (only while running)
├── latest.txt                    ← name of the newest snapshot
├── .joplin-incremental-backup    ← marker: this is a backup directory
└── .backup.lock                  ← present only while a backup is running
```

Notes, notebooks, tags and note-tags are each written as a single `<id>.md` file directly in the snapshot root (this mirrors Joplin's Raw export exactly); only attachments live under `resources/`.

The staging directory is unique per run (embedding the start time, process id, and a random suffix) so two concurrent runs can never write into the same directory. On startup, any leftover staging directories older than the stale-lock threshold are cleaned up — unless another Joplin instance holds a fresh lock, in which case they are left untouched.

### Disconnected backup drives

The first backup to a directory creates it and writes a marker file, `.joplin-incremental-backup`. After that, the plugin refuses to back up to that directory if the marker is missing, instead of recreating the directory. This protects against an unmounted drive: without the check, a path like `/mnt/backup/joplin` would be recreated on the internal disk, the snapshots would go there, and they would be hidden under the mount point once the drive came back.

If you moved or deleted the backups on purpose, create an empty `.joplin-incremental-backup` file in the directory, or choose a different directory.

When upgrading from a version without the marker, the first backup adopts your existing backup directory. If that directory does not exist at that point but backups have been made before, the plugin assumes the drive is not mounted and refuses rather than creating it. If it really is a new location, create the directory yourself and the next backup will use it.

### Local staging

By default each run exports the whole vault into the staging directory **on the backup drive**, hashes it there, and then replaces unchanged files with hardlinks. That saves space but not writes: a 5 GB vault backed up daily writes about 5 GB to the drive every day, even if one note changed. On a USB stick or a slow drive that also makes every run slow.

With **Stage the export on this computer** on, a run instead:

1. Exports into `plugin-data/<plugin id>/staging/_joplin_active_…` in the Joplin profile, and hashes the files there.
2. Builds the staging directory on the backup drive by hardlinking files that are identical to the previous snapshot and copying only new or changed files.
3. Renames the staging directory into place and deletes the local export, as before.

The trade-off is temporary local disk space about the size of the vault. Before exporting, the plugin checks that the local disk has room for the previous snapshot plus the usual minimum free space. If it doesn't, the folder can't be created, or the local export fails (for example because the disk fills up on a first backup), the run stages on the backup drive as before and reports a warning. If the backup directory is on the same disk as the Joplin profile, staging locally would only add writes, so the run stages on the backup drive without a warning. Local staging left behind by a crash is removed the next time Joplin starts.

### Scheduler catch-up behaviour

When Joplin starts, the plugin checks when the last successful backup finished:

- **Never backed up** → runs a backup shortly after startup.
- **Last backup ≥ 2× the interval ago** (e.g. 48 h for a 24 h interval) → runs a catch-up backup shortly after startup.
- **Last backup between 1× and 2× the interval ago** → does **not** run at startup; schedules the next run at the next interval boundary (so cadence stays anchored to the last backup). This means if Joplin is closed for most of the day, the effective cadence may stretch from 24 h to 48 h instead of never running at all.
- **Last backup < 1× the interval ago** → schedules the next run when the interval elapses.

If strict 24 h spacing matters more than avoiding an export at launch, this is a one-line change in `src/scheduler.ts` (replace the "next interval boundary" branch with `now + intervalMs`).

After a successful backup, the next one is scheduled exactly one interval later. After a failed backup, the next attempt is scheduled after 5 minutes rather than waiting a full interval.

### Encrypted items

The Raw exporter **skips items that are still encrypted** and reports them as warnings rather than failing. If your profile is encrypted, unlock it (and let all items finish downloading/decrypting) before running a backup, otherwise the snapshot will be missing those items. When this happens the plugin logs the warnings and shows them in the backup dialog, so an incomplete snapshot is never silently reported as a full success.

### Durability trade-off

`manifest.json` and `latest.txt` are fsynced so they survive a power cut. The exported note and resource files themselves are **not** fsynced individually — fsyncing 10–20 k files per backup would add significant latency and I/O, especially on USB drives. This means a power loss during a backup could leave some exported files partially written, but:

- The lock prevents another run from starting until the previous one finishes or is recovered.
- On the next run, the staging directory is cleaned up and the export is retried from scratch.
- `verifyBackup` will detect any corrupted files in existing snapshots.

If you need full file-level durability, use a filesystem with journaling (ext4, NTFS, APFS) on a UPS-backed drive.

### Restoring a backup

Snapshots are plain Joplin Raw exports, so restoring doesn't require this plugin:

1. Open Joplin on the machine you want to restore to.
2. Choose **File > Import > RAW - Joplin Export Directory**.
3. Select any snapshot folder (e.g. `20261020T143022/`) — its contents are imported as notebooks, notes, tags, and resources.

This makes the backups a safe, vendor-independent archive: even without the plugin (or without Joplin itself), your data is readable.

## Building from source

```bash
npm install
npm run dist     # builds the plugin into publish/
```

Other scripts:

```bash
npm run format        # format the codebase with Prettier
npm run format:check  # check formatting (CI)
npm run updateVersion # sync version from package.json into the manifest
```

### End-to-end tests

`e2e/` runs the built plugin inside a real Joplin desktop app with a throwaway profile. The tests add notes through Joplin's Data API, let the scheduler take the backups, and check the snapshots on disk (Raw layout, manifest hashes, hardlinks between snapshots, change summary, skipped runs). The scenario runs twice: once staging on the backup drive, and once with **Stage the export on this computer** on. For the second run the backups go on another filesystem (`/dev/shm` by default, override with `JOPLIN_E2E_OTHER_DEVICE`), since local staging is skipped when both are on the same disk.

```bash
npm run fetch-joplin          # download + verify + extract Joplin (default 3.7.22) into .cache/joplin/
npm run test:e2e              # builds the plugin, then runs e2e/ in a visible Joplin window
npm run test:e2e:headless     # same, on a virtual display (as in CI); needs xvfb
```

For headless runs, install Xvfb first (`sudo apt-get install xvfb`). The harness unsets `WAYLAND_DISPLAY` for Joplin, so on WSLg or a Wayland desktop no window appears.

CI runs the suite on the oldest supported Joplin (3.2.11) and on 3.7.22. To test another version locally, run `npm run fetch-joplin -- 3.2.11`; it becomes the default for `npm run test:e2e`. Set `JOPLIN_BIN` to use a different Joplin executable, `JOPLIN_E2E_WORKDIR` to choose where the profile, logs and backups go, and `JOPLIN_E2E_KEEP=1` to keep them after a passing run. They are always kept when a test fails. The tests never touch your own Joplin profile, and they run alongside a Joplin you already have open.

For information on publishing the plugin, see [GENERATOR_DOC.md](./GENERATOR_DOC.md).

## License

MIT
