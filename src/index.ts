import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import type { MenuItem } from 'api/types';
import { logger } from './logger';
import { runBackup, recoverBackupDirs } from './backup';
import { verifyBackup } from './verify';
import { registerSettings, getSettings } from './settings';
import { initScheduler } from './scheduler';
import { formatLastBackupResult } from './result';

export const CREATE_COMMAND = 'CreateIncrementalBackup';
export const VERIFY_COMMAND = 'VerifyIncrementalBackup';
export const SHOW_LAST_BACKUP_RESULT_COMMAND = 'ShowLastBackupResult';
export const MENU_ID = 'incrementalBackup.toolsMenu';

export async function handleCreateBackup(): Promise<void> {
  try {
    const result = await runBackup();
    if (result.status === 'skipped') {
      await joplin.views.dialogs.showMessageBox(result.message);
      return;
    }
    await joplin.views.dialogs.showMessageBox(
      `${result.message}\n\nDeduplication: ${result.deduplication} ` +
        `(hardlinked ${result.hardlinked}, copied ${result.copied}, unchanged ${result.unchanged}).` +
        (result.warnings && result.warnings.length > 0
          ? `\n\nWarnings (${result.warnings.length}):\n${result.warnings.join('\n')}`
          : ''),
    );
  } catch (error) {
    logger.error('Backup failed.', error);
    await joplin.views.dialogs.showMessageBox(
      `Backup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleVerifyBackup(): Promise<void> {
  try {
    const result = await verifyBackup();
    await joplin.views.dialogs.showMessageBox(result.message);
  } catch (error) {
    logger.error('Verification failed.', error);
    await joplin.views.dialogs.showMessageBox(
      `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleShowLastBackupResult(): Promise<void> {
  try {
    const settings = await getSettings();
    const message = formatLastBackupResult(
      settings.lastBackupResult ?? '',
      settings.lastBackupResultJson ?? '',
    );
    await joplin.views.dialogs.showMessageBox(message);
  } catch (error) {
    logger.error('Could not show last backup result.', error);
    await joplin.views.dialogs.showMessageBox(
      `Could not show last backup result: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function registerCommands(): Promise<void> {
  await joplin.commands.register({
    name: CREATE_COMMAND,
    label: 'Create incremental backup',
    iconName: 'fas fa-archive',
    execute: handleCreateBackup,
  });
  await joplin.commands.register({
    name: VERIFY_COMMAND,
    label: 'Verify last incremental backup',
    iconName: 'fas fa-check-circle',
    execute: handleVerifyBackup,
  });
  await joplin.commands.register({
    name: SHOW_LAST_BACKUP_RESULT_COMMAND,
    label: 'Show last backup result',
    iconName: 'fas fa-info-circle',
    execute: handleShowLastBackupResult,
  });
}

async function registerMenus(): Promise<void> {
  const menuItems: MenuItem[] = [
    { commandName: CREATE_COMMAND },
    { commandName: VERIFY_COMMAND },
    { commandName: SHOW_LAST_BACKUP_RESULT_COMMAND },
  ];
  await joplin.views.menus.create(MENU_ID, 'Incremental Backup', menuItems, MenuItemLocation.Tools);
}

joplin.plugins.register({
  onStart: async function () {
    logger.info('Incremental Backup plugin started.');

    await registerSettings();
    await recoverBackupDirs();
    await registerCommands();
    await registerMenus();
    await initScheduler();
  },
});
