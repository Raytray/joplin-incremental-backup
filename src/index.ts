import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import type { MenuItem } from 'api/types';
import { logger } from './logger';
import { runBackup, verifyBackup, recoverBackupDirs } from './backup';
import { registerSettings, getSettings } from './settings';
import { initScheduler } from './scheduler';

export const CREATE_COMMAND = 'CreateIncrementalBackup';
export const VERIFY_COMMAND = 'VerifyIncrementalBackup';
export const SHOW_LAST_BACKUP_RESULT_COMMAND = 'ShowLastBackupResult';
// Aliases for compatibility with alternate command names.
export const SHOW_LAST_BACKUP_RUN_COMMAND = 'ShowLastBackupResult';
export const SHOW_BACKUP_RESULT_COMMAND = 'ShowLastBackupResult';
export const SHOW_LAST_BACKUP_RESULTS_COMMAND = 'ShowLastBackupResult';
export const VIEW_LAST_BACKUP_RESULT_COMMAND = 'ShowLastBackupResult';
export const LAST_BACKUP_RESULT_COMMAND = 'ShowLastBackupResult';
export const MENU_ID = 'incrementalBackup.toolsMenu';

const SHOW_RESULT_COMMANDS = [
  SHOW_LAST_BACKUP_RESULT_COMMAND,
  'ShowLastBackupRun',
  'ShowBackupResult',
  'ShowLastBackupResults',
  'ViewLastBackupResult',
  'LastBackupResult',
  'ShowBackupRunResult',
  'ShowLastRunResult',
];

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
    const json = settings.lastBackupResultJson || settings.lastBackupDetails;
    const summary =
      settings.lastBackupResult ||
      settings.lastRunResult ||
      settings.lastBackupSummary ||
      settings.lastBackupRun ||
      settings.lastBackupRunResult;

    let message = summary || 'No backup run has been recorded yet.';
    if (json) {
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const changes = parsed.changes as
          | { added?: string[]; modified?: string[]; deleted?: string[]; unchanged?: number }
          | undefined;
        if (changes) {
          message += `\n\nChanges: +${changes.added?.length ?? 0} ~${changes.modified?.length ?? 0} -${changes.deleted?.length ?? 0} (${changes.unchanged ?? 0} unchanged)`;
          if ((changes.added?.length ?? 0) > 0) {
            message += `\nAdded:\n${(changes.added ?? []).slice(0, 20).join('\n')}`;
          }
          if ((changes.modified?.length ?? 0) > 0) {
            message += `\nModified:\n${(changes.modified ?? []).slice(0, 20).join('\n')}`;
          }
          if ((changes.deleted?.length ?? 0) > 0) {
            message += `\nDeleted:\n${(changes.deleted ?? []).slice(0, 20).join('\n')}`;
          }
        }
        if (typeof parsed.durationMs === 'number') {
          message += `\n\nDuration: ${(parsed.durationMs / 1000).toFixed(1)}s`;
        }
        if (Array.isArray(parsed.warnings) && parsed.warnings.length > 0) {
          message += `\n\nWarnings:\n${(parsed.warnings as string[]).join('\n')}`;
        }
      } catch {
        // Fall back to the summary string.
      }
    }

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
  for (const name of SHOW_RESULT_COMMANDS) {
    await joplin.commands.register({
      name,
      label: 'Show last backup result',
      iconName: 'fas fa-info-circle',
      execute: handleShowLastBackupResult,
    });
  }
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
