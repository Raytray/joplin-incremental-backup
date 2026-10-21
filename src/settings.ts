import joplin from 'api';
import { logger } from './logger';

// Joplin injects the plugin API as the global `joplin` at runtime; the values
// below mirror Joplin's SettingItemType enum so settings can be registered
// without a runtime dependency on the type-only 'api/types' module.
enum SettingItemType {
  Int = 1,
  String = 2,
  Bool = 3,
}

export const SECTION_NAME = 'incrementalBackupSection';
export const WINDOWS_MAX_PATH_LIMIT = 180;

export const SettingKeys = {
  BackupPath: 'backupPath',
  BackupRetention: 'backupRetention',
  BackupInterval: 'backupInterval',
  OnlyOnChange: 'onlyOnChange',
  LastBackup: 'lastBackup',
  LastSnapshot: 'lastSnapshot',
} as const;

export interface BackupSettings {
  backupPath: string;
  backupRetention: number;
  backupInterval: number;
  onlyOnChange: boolean;
  lastBackup: string;
  lastSnapshot: string;
}

/**
 * Validates the configured backup path.
 * - Throws a descriptive error if the path is empty.
 * - Logs a warning on Windows if the path length exceeds 180 characters.
 */
export function validateBackupPath(
  backupPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!backupPath || !backupPath.trim()) {
    throw new Error('Backup path is empty. Please configure a valid backup directory in settings.');
  }

  if (platform === 'win32' && backupPath.length > WINDOWS_MAX_PATH_LIMIT) {
    logger.warn(
      `Backup path length (${backupPath.length}) exceeds ` +
        `${WINDOWS_MAX_PATH_LIMIT} characters on Windows. Long path names may cause issues ` +
        `during backup file operations.`,
    );
  }
}

/**
 * Check whether auto-backup scheduler is enabled based on backup interval.
 * backupInterval = 0 signals disabled scheduler.
 */
export function isSchedulerEnabled(settingsOrInterval: BackupSettings | number): boolean {
  const interval =
    typeof settingsOrInterval === 'number' ? settingsOrInterval : settingsOrInterval.backupInterval;
  return interval > 0;
}

/**
 * Registers all plugin settings and setting section with Joplin.
 */
export async function registerSettings(): Promise<void> {
  await joplin.settings.registerSection(SECTION_NAME, {
    label: 'Incremental Backup',
    iconName: 'fas fa-archive',
    description: 'Configuration for incremental Joplin backups',
  });

  await joplin.settings.registerSettings({
    [SettingKeys.BackupPath]: {
      value: '',
      type: SettingItemType.String,
      section: SECTION_NAME,
      public: true,
      label: 'Backup path',
      description: 'Absolute path to backup root directory.',
    },
    [SettingKeys.BackupRetention]: {
      value: 5,
      type: SettingItemType.Int,
      section: SECTION_NAME,
      public: true,
      minimum: 1,
      label: 'Backup retention count',
      description: 'Number of snapshots to retain before pruning.',
    },
    [SettingKeys.BackupInterval]: {
      value: 24,
      type: SettingItemType.Int,
      section: SECTION_NAME,
      public: true,
      minimum: 0,
      label: 'Backup interval (hours)',
      description: 'Auto-backup interval in hours. Set to 0 to disable automatic backups.',
    },
    [SettingKeys.OnlyOnChange]: {
      value: true,
      type: SettingItemType.Bool,
      section: SECTION_NAME,
      public: true,
      label: 'Only backup on changes',
      description: 'Skip snapshot creation if no notes have changed since the last backup.',
    },
    [SettingKeys.LastBackup]: {
      value: '',
      type: SettingItemType.String,
      section: SECTION_NAME,
      public: false,
      label: 'Last backup timestamp',
      description: 'ISO timestamp of last successful backup run.',
    },
    [SettingKeys.LastSnapshot]: {
      value: '',
      type: SettingItemType.String,
      section: SECTION_NAME,
      public: false,
      label: 'Last snapshot directory',
      description: 'Directory name of last snapshot.',
    },
  });
}

/**
 * Retrieves and validates the current plugin settings from Joplin.
 * Throws if backupPath is empty.
 */
export async function getSettings(
  platform: NodeJS.Platform = process.platform,
): Promise<BackupSettings> {
  const [
    backupPathVal,
    backupRetentionVal,
    backupIntervalVal,
    onlyOnChangeVal,
    lastBackupVal,
    lastSnapshotVal,
  ] = await Promise.all([
    joplin.settings.value(SettingKeys.BackupPath),
    joplin.settings.value(SettingKeys.BackupRetention),
    joplin.settings.value(SettingKeys.BackupInterval),
    joplin.settings.value(SettingKeys.OnlyOnChange),
    joplin.settings.value(SettingKeys.LastBackup),
    joplin.settings.value(SettingKeys.LastSnapshot),
  ]);

  const backupPath = typeof backupPathVal === 'string' ? backupPathVal.trim() : '';
  const backupRetention = typeof backupRetentionVal === 'number' ? backupRetentionVal : 5;
  const backupInterval = typeof backupIntervalVal === 'number' ? backupIntervalVal : 24;
  const onlyOnChange = typeof onlyOnChangeVal === 'boolean' ? onlyOnChangeVal : true;
  const lastBackup = typeof lastBackupVal === 'string' ? lastBackupVal : '';
  const lastSnapshot = typeof lastSnapshotVal === 'string' ? lastSnapshotVal : '';

  validateBackupPath(backupPath, platform);

  return {
    backupPath,
    backupRetention,
    backupInterval,
    onlyOnChange,
    lastBackup,
    lastSnapshot,
  };
}

/**
 * Update the recorded timestamp of the last successful backup run.
 */
export async function setLastBackup(timestamp: string): Promise<void> {
  await joplin.settings.setValue(SettingKeys.LastBackup, timestamp);
}

/**
 * Update the directory name of the last snapshot.
 */
export async function setLastSnapshot(snapshotDirName: string): Promise<void> {
  await joplin.settings.setValue(SettingKeys.LastSnapshot, snapshotDirName);
}
