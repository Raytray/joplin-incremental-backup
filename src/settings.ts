import path from 'path';
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
  };
}

/**
 * Keys written by earlier versions that nothing reads any more. Joplin rejects
 * `setValue` on an unregistered key, so they are registered as hidden
 * placeholders purely so `clearRetiredSettings` can wipe values left in
 * existing profiles. Safe to drop once old installs have upgraded.
 */
export const RETIRED_SETTING_KEYS = [
  'lastRunResult',
  'lastBackupSummary',
  'lastBackupDetails',
  'lastBackupRun',
  'lastBackupRunResult',
] as const;

export function buildRetiredSettings(): Record<string, SettingItem> {
  const items: Record<string, SettingItem> = {};
  for (const key of RETIRED_SETTING_KEYS) {
    items[key] = {
      value: '',
      type: SettingItemType.String,
      public: false,
      section: SETTING_SECTION_NAME,
      label: `Retired (${key})`,
    };
  }
  return items;
}

/** Clear values stored under retired keys. Never fails startup. */
export async function clearRetiredSettings(): Promise<void> {
  for (const key of RETIRED_SETTING_KEYS) {
    try {
      const value = await joplin.settings.value(key);
      if (value !== undefined && value !== null && value !== '') {
        await joplin.settings.setValue(key, '');
      }
    } catch (error) {
      logger.warn(`Could not clear retired setting "${key}".`, error);
    }
  }
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
  await joplin.settings.registerSettings({ ...buildSettings(), ...buildRetiredSettings() });
  await clearRetiredSettings();
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

export const MISSING_BACKUP_PATH_MESSAGE =
  'No backup directory is set. Choose one in Tools > Options > Incremental Backup.';

function isAbsoluteFor(platform: NodeJS.Platform, backupPath: string): boolean {
  return platform === 'win32'
    ? path.win32.isAbsolute(backupPath)
    : path.posix.isAbsolute(backupPath);
}

/**
 * Why `backupPath` cannot be used as a backup directory, or `null` when it
 * can. This is the single definition of a usable path: it must be set and
 * absolute (a relative path would resolve against Joplin's working
 * directory). Paths are expected to be trimmed already — `getSettings` does
 * that — so surrounding whitespace counts as unusable here.
 */
export function backupPathProblem(
  backupPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!backupPath) return MISSING_BACKUP_PATH_MESSAGE;
  if (backupPath !== backupPath.trim() || !isAbsoluteFor(platform, backupPath)) {
    return (
      `Backup directory "${backupPath}" is not an absolute path. ` +
      'Choose a full path in Tools > Options > Incremental Backup.'
    );
  }
  return null;
}

/** Throw a user-facing error when `backupPath` is unusable; warn on long Windows paths. */
export function validateBackupPath(
  backupPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const problem = backupPathProblem(backupPath, platform);
  if (problem) throw new Error(problem);

  if (platform === 'win32' && backupPath.length > WIN32_MAX_SAFE_PATH_LENGTH) {
    logger.warn(
      `Backup path is ${backupPath.length} characters long; Windows may fail to create long paths (safe limit ~${WIN32_MAX_SAFE_PATH_LENGTH}).`,
    );
  }
}

/** True when a usable backup directory is configured. */
export function hasBackupPath(settings: Pick<Settings, 'backupPath'>): boolean {
  return backupPathProblem(settings.backupPath) === null;
}

/** Return the configured backup directory, or throw a user-facing error when it is unusable. */
export function requireBackupPath(settings: Pick<Settings, 'backupPath'>): string {
  validateBackupPath(settings.backupPath);
  return settings.backupPath;
}

export async function getSettings(): Promise<Settings> {
  const values = await joplin.settings.values(Object.values(SETTING_KEYS));

  const rawBackupPath = values[SETTING_KEYS.backupPath];
  // The only place the path is normalized. An unset or invalid path is a
  // normal state (e.g. a fresh install), not an error here: callers that need
  // a directory check it with `requireBackupPath`.
  const backupPath = typeof rawBackupPath === 'string' ? rawBackupPath.trim() : '';

  return {
    backupPath,
    backupRetention: clampRetention(values[SETTING_KEYS.backupRetention]),
    backupInterval: normalizeInterval(values[SETTING_KEYS.backupInterval]),
    onlyOnChange: values[SETTING_KEYS.onlyOnChange] !== false,
    lastBackup: String(values[SETTING_KEYS.lastBackup] ?? ''),
    lastSnapshot: String(values[SETTING_KEYS.lastSnapshot] ?? ''),
    lastBackupResult: String(values[SETTING_KEYS.lastBackupResult] ?? ''),
    lastBackupResultJson: String(values[SETTING_KEYS.lastBackupResultJson] ?? ''),
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

export async function setLastBackupResult(value: string): Promise<void> {
  await joplin.settings.setValue(SETTING_KEYS.lastBackupResult, value);
}

export async function setLastBackupResultJson(value: string): Promise<void> {
  await joplin.settings.setValue(SETTING_KEYS.lastBackupResultJson, value);
}
