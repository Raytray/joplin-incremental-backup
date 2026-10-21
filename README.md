# Incremental Backup (Joplin Plugin)

A **desktop-only Joplin plugin** that creates **deduplicated incremental snapshots** of your Joplin data using Joplin's native **Raw export** format.

Each backup is a complete, importable Raw export directory, but unchanged files are hardlinked (or copied as a fallback) to the previous snapshot. Repeated backups therefore take far less space than a full copy each time, while every snapshot remains independently restorable.

## Features

- **Complete snapshots** — every run produces a full Raw Joplin export directory, not a patch.
- **Deduplication** — identical files are hardlinked to the previous snapshot; falls back to copying on filesystems that don't support hardlinks (cross-device, FAT32, network shares, permission-restricted Windows paths).
- **No-change runs are skipped** — when "Only backup on changes" is enabled, a run is skipped if no notes changed since the last snapshot (the last-backup timestamp is still updated).
- **Retention pruning** — keeps only the most recent N snapshots (default 5); oldest are deleted automatically.
- **Optional auto-backup scheduler** — interval timer (in hours) that runs backups automatically; reacts to settings changes.
- **Verification** — compares every file in a snapshot against its manifest's SHA-256 hashes.
- **Crash safety** — uses an exclusive lock file, a staging directory (`_joplin_active_`), and atomic file writes; stale locks are recovered automatically.
- **Content-addressed dedup index** — matches by both relative path and SHA-256, so moved/renamed identical content is still deduplicated.
- **Profiles** — optional per-profile backup roots (`resolveBackupRoot`).

## Compatibility

- Joplin **2.14 or newer** (desktop). The plugin is developed and tested against **Joplin 3.7.x**.
- The plugin keeps a low `app_min_version` (`2.14`) in `manifest.json` so it remains installable on older Joplin releases, but only 2.14+ is supported.
- Desktop only (`platforms: ["desktop"]`); mobile is not supported.
- Joplin 3.x ships with an updated plugin version check (regex-based rather than semver). The `2.14` floor parses correctly under both schemes.

## Requirements

- Joplin **2.14 or newer** (desktop). Developed and tested against Joplin **3.7.x**.
- Node.js / npm for building from source.

## Installation (from source)

```bash
git clone <this-repo>
cd joplin-incremental-backup
npm install
npm run build
```

The build outputs `publish/manifest.json` and `publish/index.js`. Load the plugin into Joplin via **Tools → Options → Plugins → "Install from file"** (or copy the `publish` directory into Joplin's plugins folder), then restart Joplin.

Development mode (watch):

```bash
npm run dev
```

## Configuration

Open **Tools → Options → Incremental Backup** (plugin settings section) and set:

| Setting | Default | Description |
| --- | --- | --- |
| **Backup path** | _(empty)_ | Absolute path to the backup root directory. **Required** — backups will not run until set. |
| **Backup retention count** | `5` | Number of snapshots to keep before pruning oldest. |
| **Backup interval (hours)** | `24` | Auto-backup interval in hours. Set to `0` to disable automatic backups. |
| **Only backup on changes** | `true` | Skip snapshot creation if no notes changed since the last backup. |

Two hidden settings are maintained automatically: `Last backup timestamp` and `Last snapshot directory`.

> On Windows, backup paths longer than 180 characters log a warning, since long paths can cause issues during file operations.

## Usage

### Manual backup

Use **Tools → Create Incremental Backup**, or run the command `CreateIncrementalBackup`. A dialog reports success, skip, or failure.

### Verify a backup

Use **Tools → Verify Incremental Backup**, or run `VerifyIncrementalBackup`. This checks the latest (or a specified) snapshot: every recorded file must exist and its SHA-256 must match the manifest.

### Automatic backups

Set **Backup interval (hours)** to a non-zero value. The scheduler runs a backup every that many hours and re-reads settings when they change. Set to `0` to disable.

### Restoring

Snapshots are standard Joplin **Raw export directories**. Restore via **File → Import → RAW - Joplin Export Directory**, selecting the snapshot directory (e.g. `20261020T120000`). Older snapshots preserve history even after notes are deleted in later ones.

## Verifying on a new Joplin version

After installing on a new Joplin release (e.g. 3.7.x), confirm the plugin still works end-to-end:

1. Set a valid **Backup path** in settings.
2. Run **Tools → Create Incremental Backup** and confirm a dialog reports success.
3. Confirm a snapshot directory named `YYYYMMDDTHHMMSS` was created under the backup root, containing `manifest.json` and the exported files, and that `latest.txt` points at it.
4. Run **Tools → Verify Incremental Backup** and confirm the message contains `✅ All N files match`.
5. (Optional) Set a short **Backup interval**, wait for (or trigger) an automatic run, and confirm a second snapshot is created with unchanged files hardlinked.

If step 3 fails or the snapshot layout differs from older Joplin versions, the `exportFolders` 'raw' output may have changed and `collectFiles`/`buildManifest` in `src/` may need adjustment.

## Backup layout

```
<backupPath>/
├── latest.txt              # name of the most recent snapshot
├── .backup.lock            # exclusive lock (transient)
├── _joplin_active_/        # staging dir during a run (cleaned up after)
└── 20261020T120000/       # snapshot (YYYYMMDDTHHMMSS, UTC)
    ├── manifest.json
    └── ... (Raw export files)
```

Snapshot directory names match `^\d{8}T\d{6}$` (e.g. `20261020T120000`).

## Manifest

Each snapshot contains a `manifest.json` with:

- `snapshotId`, `createdAt` (ms), `joplinVersion`
- `lastChangeTime` — max `updated_time` across notes at backup time (drives skip-on-no-change)
- `fileCount`, `files` — array of `{ path, size, sha256 }`
- `deduplication` — `hardlink`, `copy`, or `none`

## How deduplication works

1. Joplin exports all notebooks to the staging directory.
2. Each file's SHA-256 is computed.
3. For each file, the previous snapshot's manifest is consulted:
   - Same relative path **and** same hash → hardlink to that file.
   - Different path but same hash → hardlink to the matching file (content-addressed).
   - Otherwise the file is kept as-is (new/changed).
4. Hardlinks fall back to copies when the OS/filesystem rejects linking (`EPERM`, `ENOTSUP`, `EXDEV`, `ENOSYS`).
5. The manifest is written and the staging directory is atomically renamed to the timestamped snapshot.

## Development

```bash
npm test              # run tests (vitest)
npm run test:coverage # with coverage
npm run lint          # oxlint
npm run format        # prettier
npm run format:check
```

Tests use a mocked Joplin API and `memfs` for an in-memory filesystem.

## License

See repository for license details.
