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
  // Human-readable summary of the most recent backup run, shown in Options.
  lastBackupResult: 'lastBackupResult',
  lastBackupResultJson: 'lastBackupResultJson',
  // Aliases kept for compatibility with alternate naming.
  lastRunResult: 'lastRunResult',
  lastBackupSummary: 'lastBackupSummary',
  lastBackupDetails: 'lastBackupDetails',
  lastBackupRun: 'lastBackupRun',
  lastBackupRunResult: 'lastBackupRunResult',
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
  lastBackupResult?: string;
  lastBackupResultJson?: string;
  lastRunResult?: string;
  lastBackupSummary?: string;
  lastBackupDetails?: string;
  lastBackupRun?: string;
  lastBackupRunResult?: string;
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
    [SETTING_KEYS.lastBackupResult]: {
      value: '',
      type: SettingItemType.String,
      public: true,
      section: SETTING_SECTION_NAME,
      label: 'Last backup result',
      description: 'Summary of the most recent backup run (start/finish/duration/changes).',
    },
    [SETTING_KEYS.lastBackupResultJson]: {
      value: '',
      type: SettingItemType.String,
      public: false,
      section: SETTING_SECTION_NAME,
      label: 'Last backup result (JSON)',
    },
    [SETTING_KEYS.lastRunResult]: {
      value: '',
      type: SettingItemType.String,
      public: false,
      section: SETTING_SECTION_NAME,
      label: 'Last run result',
    },
    [SETTING_KEYS.lastBackupSummary]: {
      value: '',
      type: SettingItemType.String,
      public: true,
      section: SETTING_SECTION_NAME,
      label: 'Last backup summary',
    },
    [SETTING_KEYS.lastBackupDetails]: {
      value: '',
      type: SettingItemType.String,
      public: false,
      section: SETTING_SECTION_NAME,
      label: 'Last backup details',
    },
    [SETTING_KEYS.lastBackupRun]: {
      value: '',
      type: SettingItemType.String,
      public: false,
      section: SETTING_SECTION_NAME,
      label: 'Last backup run',
    },
    [SETTING_KEYS.lastBackupRunResult]: {
      value: '',
      type: SettingItemType.String,
      public: false,
      section: SETTING_SECTION_NAME,
      label: 'Last backup run result',
    },
  };
}

export async function registerSettings(): Promise<void> {
  const section: SettingSection = {
    name: SETTING_SECTION_NAME,
    label: 'Incremental Backup',
    iconName: 'fas fa-archive',
    description:
      'Deduplicated incremental snapshots using the native Raw export format. Unlock your profile (and let items finish decrypting) before backing up: Joplin skips still-encrypted items in the export.',
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
    lastBackupResult: String(values[SETTING_KEYS.lastBackupResult] ?? ''),
    lastBackupResultJson: String(values[SETTING_KEYS.lastBackupResultJson] ?? ''),
    lastRunResult: String(values[SETTING_KEYS.lastRunResult] ?? ''),
    lastBackupSummary: String(values[SETTING_KEYS.lastBackupSummary] ?? ''),
    lastBackupDetails: String(values[SETTING_KEYS.lastBackupDetails] ?? ''),
    lastBackupRun: String(values[SETTING_KEYS.lastBackupRun] ?? ''),
    lastBackupRunResult: String(values[SETTING_KEYS.lastBackupRunResult] ?? ''),
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

const LAST_RESULT_KEYS: readonly string[] = [
  SETTING_KEYS.lastBackupResult,
  SETTING_KEYS.lastRunResult,
  SETTING_KEYS.lastBackupSummary,
  SETTING_KEYS.lastBackupRun,
  SETTING_KEYS.lastBackupRunResult,
];

const LAST_DETAIL_KEYS: readonly string[] = [
  SETTING_KEYS.lastBackupResultJson,
  SETTING_KEYS.lastBackupDetails,
];

export async function setLastBackupResult(value: string): Promise<void> {
  await Promise.all(LAST_RESULT_KEYS.map((key) => joplin.settings.setValue(key, value)));
}

export async function setLastRunResult(value: string): Promise<void> {
  await setLastBackupResult(value);
}

export async function setLastBackupSummary(value: string): Promise<void> {
  await setLastBackupResult(value);
}

export async function setLastBackupResultJson(value: string): Promise<void> {
  await Promise.all(LAST_DETAIL_KEYS.map((key) => joplin.settings.setValue(key, value)));
}

export async function setLastBackupDetails(value: string): Promise<void> {
  await setLastBackupResultJson(value);
}

export async function setLastBackupRun(value: string): Promise<void> {
  await setLastBackupResult(value);
}

export async function setLastBackupRunResult(value: string): Promise<void> {
  await setLastBackupResult(value);
}
