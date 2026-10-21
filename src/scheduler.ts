import joplin from 'api';
import { logger } from './logger';
import { runBackup } from './backup';
import type { BackupResult } from './backup';
import { getSettings, isSchedulerEnabled, SETTING_KEYS } from './settings';
import type { Settings } from './settings';

export const HOUR_IN_MS = 60 * 60 * 1000;

/** Runs one scheduled backup; injected in tests. */
export type BackupRunner = () => Promise<BackupResult>;

export interface SchedulerDependencies {
  runBackup?: BackupRunner;
  setIntervalFn?: (handler: () => void, timeout: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  loadSettings?: () => Promise<Settings>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

/**
 * Runs `runBackup` on a fixed interval. `backupInterval = 0` disables it — there
 * is no separate "enabled" setting.
 */
export class Scheduler {
  private handle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly runBackup: BackupRunner;
  private readonly setIntervalFn: NonNullable<SchedulerDependencies['setIntervalFn']>;
  private readonly clearIntervalFn: NonNullable<SchedulerDependencies['clearIntervalFn']>;
  private readonly loadSettings: () => Promise<Settings>;

  constructor(dependencies: SchedulerDependencies = {}) {
    this.runBackup = dependencies.runBackup ?? runBackup;
    this.setIntervalFn =
      dependencies.setIntervalFn ?? ((handler, timeout) => setInterval(handler, timeout));
    this.clearIntervalFn = dependencies.clearIntervalFn ?? ((handle) => clearInterval(handle));
    this.loadSettings = dependencies.loadSettings ?? getSettings;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  stop(): void {
    if (this.handle !== null) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }

  start(intervalHours: number): void {
    this.stop();
    if (!isSchedulerEnabled(intervalHours)) {
      logger.info('Auto-backup disabled (interval is 0).');
      return;
    }

    const intervalMs = intervalHours * HOUR_IN_MS;
    this.handle = this.setIntervalFn(() => {
      void this.executeScheduledBackup();
    }, intervalMs);
    logger.info(`Auto-backup scheduled every ${intervalHours} hour(s).`);
  }

  reset(intervalHours: number): void {
    this.start(intervalHours);
  }

  /** Run a backup, skipping if one is already in flight. */
  async executeScheduledBackup(): Promise<BackupResult | null> {
    if (this.running) {
      logger.warn('Scheduled backup already in progress; skipping this tick.');
      return null;
    }

    this.running = true;
    try {
      return await this.runBackup();
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        logger.warn('Another backup holds the lock; skipping this scheduled run.');
      } else {
        logger.error('Scheduled backup failed.', error);
      }
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Read the interval, start the timer, and watch for setting changes. */
  async init(): Promise<void> {
    const settings = await this.loadSettings();
    this.start(settings.backupInterval);

    await joplin.settings.onChange((event) => {
      void this.handleSettingsChange(event.keys);
    });
  }

  async handleSettingsChange(keys: readonly string[]): Promise<void> {
    if (!keys.includes(SETTING_KEYS.backupInterval)) return;

    try {
      const settings = await this.loadSettings();
      this.reset(settings.backupInterval);
    } catch (error) {
      logger.error('Could not apply the updated backup interval.', error);
    }
  }
}

export function createScheduler(dependencies: SchedulerDependencies = {}): Scheduler {
  return new Scheduler(dependencies);
}

const defaultScheduler = createScheduler();

export function startScheduler(intervalHours: number): void {
  defaultScheduler.start(intervalHours);
}

export function stopScheduler(): void {
  defaultScheduler.stop();
}

export function resetScheduler(intervalHours: number): void {
  defaultScheduler.reset(intervalHours);
}

export function executeScheduledBackup(): Promise<BackupResult | null> {
  return defaultScheduler.executeScheduledBackup();
}

export function isSchedulerRunning(): boolean {
  return defaultScheduler.isRunning();
}

export async function initScheduler(dependencies?: SchedulerDependencies): Promise<Scheduler> {
  const scheduler = dependencies ? createScheduler(dependencies) : defaultScheduler;
  await scheduler.init();
  return scheduler;
}

/** Alias kept for parity with the plan's naming. */
export const scheduleBackup = startScheduler;
export const cancelScheduledBackup = stopScheduler;
