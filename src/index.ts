import joplin from 'api';
import { registerSettings } from './settings';
import { initScheduler } from './scheduler';
import { runBackup, verifyBackup } from './backup';

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
    console.info('[IncrementalBackup] Backup completed', result.snapshotDir, result.dedupStats);
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
    console.info('[IncrementalBackup] Plugin started.');

    await registerSettings();

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