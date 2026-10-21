import joplin from 'api';
import { logger } from './logger';
import { runBackup } from './backup';
import type { BackupResult } from './backup';
import { getSettings, isSchedulerEnabled, SETTING_KEYS } from './settings';
import type { Settings } from './settings';
import { errorCode } from './platform';

export const HOUR_IN_MS = 60 * 60 * 1000;

/**
 * A startup catch-up backup only runs when the last successful backup is at
 * least this many intervals old. Anything less is left to the regular
 * schedule, so launching Joplin never triggers an unexpected export.
 */
export const CATCH_UP_OVERDUE_FACTOR = 2;

/** Grace period before a startup catch-up export, so Joplin can finish loading. */
export const CATCH_UP_GRACE_MS = 5 * 1000;

/** Re-arm delay after a failed run — much sooner than a full interval. */
export const RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * Node's `setTimeout` fires *immediately* for delays above 2³¹−1 ms, so long
 * delays are split into chunks of at most this value and re-armed.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Runs one scheduled backup; injected in tests. */
export type BackupRunner = () => Promise<BackupResult>;

export interface SchedulerDependencies {
  runBackup?: BackupRunner;
  setTimeoutFn?: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  loadSettings?: () => Promise<Settings>;
  /** Injectable clock, in milliseconds since the epoch. */
  now?: () => number;
}

/** Parse a persisted `lastBackup` timestamp; invalid values mean "never". */
export function parseLastBackup(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * Runs `runBackup` on a fixed interval. `backupInterval = 0` disables it — there
 * is no separate "enabled" setting.
 *
 * The timer is a self-rearming `setTimeout` rather than a `setInterval`:
 *  - `setInterval` delays above 2³¹−1 ms fire immediately in Node, which
 *    silently breaks every interval longer than ~24.8 days.
 *  - A one-shot timer lets the next run be anchored to the last *successful*
 *    backup instead of to the moment the plugin happened to start.
 */
export class Scheduler {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private intervalMs = 0;

  private readonly runBackup: BackupRunner;
  private readonly setTimeoutFn: NonNullable<SchedulerDependencies['setTimeoutFn']>;
  private readonly clearTimeoutFn: NonNullable<SchedulerDependencies['clearTimeoutFn']>;
  private readonly loadSettings: () => Promise<Settings>;
  private readonly now: () => number;

  constructor(dependencies: SchedulerDependencies = {}) {
    this.runBackup = dependencies.runBackup ?? runBackup;
    this.setTimeoutFn =
      dependencies.setTimeoutFn ?? ((handler, timeout) => setTimeout(handler, timeout));
    this.clearTimeoutFn = dependencies.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    this.loadSettings = dependencies.loadSettings ?? getSettings;
    this.now = dependencies.now ?? (() => Date.now());
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  stop(): void {
    if (this.handle !== null) {
      this.clearTimeoutFn(this.handle);
      this.handle = null;
    }
  }

  /**
   * Arm the timer for `dueAt`.
   *
   * Delays longer than `MAX_TIMEOUT_MS` are split: the timer simply re-arms
   * for the next chunk instead of firing the backup early.
   */
  private armAt(dueAt: number): void {
    const delay = dueAt - this.now();

    if (delay > MAX_TIMEOUT_MS) {
      this.handle = this.setTimeoutFn(() => {
        this.armAt(dueAt);
      }, MAX_TIMEOUT_MS);
      return;
    }

    this.handle = this.setTimeoutFn(
      () => {
        void this.tick();
      },
      Math.max(0, delay),
    );
  }

  /**
   * Decide when the next backup is due and arm the timer.
   *
   *  - never backed up            → run shortly after startup
   *  - overdue by ≥ 2 intervals    → run shortly after startup
   *  - overdue by ≥ 1 interval     → run at the next interval boundary
   *  - otherwise                  → run when the interval elapses
   */
  start(intervalHours: number, lastBackupIso?: string): void {
    this.stop();

    if (!isSchedulerEnabled(intervalHours)) {
      this.intervalMs = 0;
      logger.info('Auto-backup disabled (interval is 0).');
      return;
    }

    this.intervalMs = intervalHours * HOUR_IN_MS;
    const lastBackupMs = parseLastBackup(lastBackupIso);
    const now = this.now();

    if (lastBackupMs === null) {
      logger.info('No previous backup recorded; scheduling a backup after startup.');
      this.armAt(now + CATCH_UP_GRACE_MS);
      return;
    }

    const age = now - lastBackupMs;

    if (age >= CATCH_UP_OVERDUE_FACTOR * this.intervalMs) {
      logger.info(
        `Last backup is ${formatDuration(age)} old (≥ ${CATCH_UP_OVERDUE_FACTOR} intervals); ` +
          'scheduling a catch-up backup.',
      );
      this.armAt(now + CATCH_UP_GRACE_MS);
      return;
    }

    if (age >= this.intervalMs) {
      // Overdue, but not badly enough to export right now: wait for the next
      // interval boundary so the cadence stays anchored to the last backup.
      const boundaries = Math.ceil(age / this.intervalMs);
      const dueAt = lastBackupMs + boundaries * this.intervalMs;
      logger.info(
        `Last backup is ${formatDuration(age)} old; scheduling the next run in ` +
          `${formatDuration(dueAt - now)}.`,
      );
      this.armAt(dueAt);
      return;
    }

    this.armAt(lastBackupMs + this.intervalMs);
  }

  reset(intervalHours: number, lastBackupIso?: string): void {
    this.start(intervalHours, lastBackupIso);
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

  /** The timer fired: run a backup and re-arm the next one. */
  private async tick(): Promise<void> {
    this.handle = null;

    const result = await this.executeScheduledBackup();

    if (result === null) {
      // The run failed (or was skipped because another one was in flight).
      // Retry much sooner than a full interval would.
      this.armAt(this.now() + RETRY_DELAY_MS);
      return;
    }

    this.armAt(this.now() + this.intervalMs);
  }

  /** Read the interval, start the timer, and watch for setting changes. */
  async init(): Promise<void> {
    const settings = await this.loadSettings();
    this.start(settings.backupInterval, settings.lastBackup);

    await joplin.settings.onChange((event) => {
      void this.handleSettingsChange(event.keys);
    });
  }

  async handleSettingsChange(keys: readonly string[]): Promise<void> {
    if (!keys.includes(SETTING_KEYS.backupInterval)) return;

    try {
      const settings = await this.loadSettings();
      this.reset(settings.backupInterval, settings.lastBackup);
    } catch (error) {
      logger.error('Could not apply the updated backup interval.', error);
    }
  }
}

/** Human-readable duration used in log messages. */
function formatDuration(ms: number): string {
  if (ms < 60 * 1000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < HOUR_IN_MS) return `${Math.round(ms / (60 * 1000))}m`;
  if (ms < 24 * HOUR_IN_MS) return `${Math.round(ms / HOUR_IN_MS)}h`;
  return `${Math.round(ms / (24 * HOUR_IN_MS))}d`;
}

export function createScheduler(dependencies: SchedulerDependencies = {}): Scheduler {
  return new Scheduler(dependencies);
}

const defaultScheduler = createScheduler();

export function startScheduler(intervalHours: number, lastBackupIso?: string): void {
  defaultScheduler.start(intervalHours, lastBackupIso);
}

export function stopScheduler(): void {
  defaultScheduler.stop();
}

export function resetScheduler(intervalHours: number, lastBackupIso?: string): void {
  defaultScheduler.reset(intervalHours, lastBackupIso);
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
