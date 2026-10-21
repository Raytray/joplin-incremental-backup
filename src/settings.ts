import joplin from 'api';
import { SettingItemSubType, SettingItemType } from 'api/types';
import type { SettingItem, SettingSection } from 'api/types';
import { logger } from './logger';

export const SETTING_SECTION_NAME = 'incrementalBackup';

export const SETTING_KEYS = {
  backupPath: 'backupPath',
  backupRetention: 'backupRetention',
  backupInterval: 'backupInterval',
  onlyOnChange: 'onlyOnChange',
  lastBackup: 'lastBackup',
  lastSnapshot: 'lastSnapshot',
} as const;

export const DEFAULT_RETENTION = 5;
export const DEFAULT_INTERVAL_HOURS = 24;
export const MIN_RETENTION = 1;

const WIN32_MAX_SAFE_PATH_LENGTH = 180;

export interface Settings {
  backupPath: string;
  backupRetention: number;
  backupInterval: number;
  onlyOnChange: boolean;
  lastBackup: string;
  lastSnapshot: string;
}

export function buildSettings(): Record<string, SettingItem> {
  return {
    [SETTING_KEYS.backupPath]: {
      value: '',
      type: SettingItemType.String,
      subType: SettingItemSubType.DirectoryPath,
      public: true,
      section: SETTING_SECTION_NAME,
      label: 'Backup directory',
      description: 'Absolute path where snapshots are stored.',
    },
    [SETTING_KEYS.backupRetention]: {
      value: DEFAULT_RETENTION,
      type: SettingItemType.Int,
      public: true,
      section: SETTING_SECTION_NAME,
      label: 'Snapshots to keep',
      description: 'Older snapshots are pruned after each successful backup (minimum 1).',
      minimum: MIN_RETENTION,
      maximum: 365,
      step: 1,
    },
    [SETTING_KEYS.backupInterval]: {
      value: DEFAULT_INTERVAL_HOURS,
      type: SettingItemType.Int,
      public: true,
      section: SETTING_SECTION_NAME,
      label: 'Auto-backup interval (hours)',
      description: 'Set to 0 to disable automatic backups.',
      minimum: 0,
      maximum: 8760,
      step: 1,
    },
    [SETTING_KEYS.onlyOnChange]: {
      value: true,
      type: SettingItemType.Bool,
      public: true,
      section: SETTING_SECTION_NAME,
      label: 'Only back up when something changed',
      description: 'Skip creating a snapshot when the data fingerprint is unchanged.',
    },
    [SETTING_KEYS.lastBackup]: {
      value: '',
      type: SettingItemType.String,
      public: false,
      section: SETTING_SECTION_NAME,
      label: 'Last backup',
    },
    [SETTING_KEYS.lastSnapshot]: {
      value: '',
      type: SettingItemType.String,
      public: false,
      section: SETTING_SECTION_NAME,
      label: 'Last snapshot',
    },
  };
}

export async function registerSettings(): Promise<void> {
  const section: SettingSection = {
    name: SETTING_SECTION_NAME,
    label: 'Incremental Backup',
    iconName: 'fas fa-archive',
    description: 'Deduplicated incremental snapshots using the native Raw export format.',
  };

  await joplin.settings.registerSection(SETTING_SECTION_NAME, section);
  await joplin.settings.registerSettings(buildSettings());
}

export function clampRetention(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION;
  return Math.max(MIN_RETENTION, Math.floor(parsed));
}

export function normalizeInterval(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_INTERVAL_HOURS;
  return Math.floor(parsed);
}

export function validateBackupPath(
  backupPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!backupPath || !backupPath.trim()) {
    throw new Error('Backup path must not be empty.');
  }

  if (platform === 'win32' && backupPath.length > WIN32_MAX_SAFE_PATH_LENGTH) {
    logger.warn(
      `Backup path is ${backupPath.length} characters long; Windows may fail to create long paths (safe limit ~${WIN32_MAX_SAFE_PATH_LENGTH}).`,
    );
  }
}

export async function getSettings(): Promise<Settings> {
  const values = await joplin.settings.values(Object.values(SETTING_KEYS));

  const rawBackupPath = values[SETTING_KEYS.backupPath];
  const backupPath = typeof rawBackupPath === 'string' ? rawBackupPath.trim() : '';
  validateBackupPath(backupPath);

  return {
    backupPath,
    backupRetention: clampRetention(values[SETTING_KEYS.backupRetention]),
    backupInterval: normalizeInterval(values[SETTING_KEYS.backupInterval]),
    onlyOnChange: values[SETTING_KEYS.onlyOnChange] !== false,
    lastBackup: String(values[SETTING_KEYS.lastBackup] ?? ''),
    lastSnapshot: String(values[SETTING_KEYS.lastSnapshot] ?? ''),
  };
}

export function isSchedulerEnabled(
  settingsOrInterval: Pick<Settings, 'backupInterval'> | number,
): boolean {
  const interval =
    typeof settingsOrInterval === 'number' ? settingsOrInterval : settingsOrInterval.backupInterval;
  return Number.isFinite(interval) && interval > 0;
}

export async function setLastBackup(timestamp: string): Promise<void> {
  await joplin.settings.setValue(SETTING_KEYS.lastBackup, timestamp);
}

export async function setLastSnapshot(snapshotDirName: string): Promise<void> {
  await joplin.settings.setValue(SETTING_KEYS.lastSnapshot, snapshotDirName);
}
