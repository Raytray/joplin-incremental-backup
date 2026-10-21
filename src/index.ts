import joplin from 'api';
import { registerSettings, getSettings } from './settings';
import { initScheduler } from './scheduler';
import { runBackup, verifyBackup } from './backup';
import { ensureBackupRoot, safeRmDir } from './platform';
import * as nodePath from 'path';
import { ACTIVE_DIR_NAME } from './backup';
import { logger } from './logger';

async function handleCreateIncrementalBackup(): Promise<void> {
  try {
    const result = await runBackup();
    if (result.status === 'skipped') {
      await joplin.views.dialogs.showMessageBox(
        `Backup skipped: ${result.skippedReason ?? 'No changes detected'}`
      );
      return;
    }
    const message = `Backup completed: ${result.snapshotDir ?? result.snapshotName}`;
    logger.info('Backup completed', result.snapshotDir, result.dedupStats);
    await joplin.views.dialogs.showMessageBox(message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await joplin.views.dialogs.showMessageBox(`Backup failed: ${message}`);
  }
}

async function handleVerifyIncrementalBackup(): Promise<void> {
  try {
    const result = await verifyBackup();
    await joplin.views.dialogs.showMessageBox(result.message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await joplin.views.dialogs.showMessageBox(`Verification failed: ${message}`);
  }
}

joplin.plugins.register({
  onStart: async function () {
    logger.info('Plugin started.');

    await registerSettings();

    // Crash recovery: clean up any leftover staging directory from a previous
    // interrupted run, and ensure the backup root is usable.
    try {
      const settings = await getSettings();
      await ensureBackupRoot(settings.backupPath);
      await safeRmDir(nodePath.join(settings.backupPath, ACTIVE_DIR_NAME));
    } catch {
      // Settings may be unconfigured or inaccessible; ignore.
    }

    await joplin.commands.register({
      name: 'CreateIncrementalBackup',
      label: 'Create Incremental Backup',
      execute: handleCreateIncrementalBackup,
    });

    await joplin.commands.register({
      name: 'VerifyIncrementalBackup',
      label: 'Verify Incremental Backup',
      execute: handleVerifyIncrementalBackup,
    });

    await joplin.views.menuItems.create(
      'createIncrementalBackupMenuItem',
      'CreateIncrementalBackup',
      'tools'
    );

    await joplin.views.menuItems.create(
      'verifyIncrementalBackupMenuItem',
      'VerifyIncrementalBackup',
      'tools'
    );

    await initScheduler();
  },
});