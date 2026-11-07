import joplin from 'api';
import { logger } from './logger';
import { resolveBackupRoot, runBackup } from './backup';
import type { BackupOptions, BackupResult } from './backup';
import {
  getSettings,
  hasBackupPath,
  isSchedulerEnabled,
  parseLastBackup,
  SETTING_KEYS,
} from './settings';

export { parseLastBackup };
import type { Settings } from './settings';
import { errorCode } from './platform';
import { listSnapshots } from './retention';

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
export type BackupRunner = (options?: BackupOptions) => Promise<BackupResult>;

export interface SchedulerDependencies {
  runBackup?: BackupRunner;
  setTimeoutFn?: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  loadSettings?: () => Promise<Settings>;
  /** Injectable clock, in milliseconds since the epoch. */
  now?: () => number;
  /** Whether a backup directory already holds at least one snapshot. */
  hasSnapshots?: (backupPath: string) => Promise<boolean>;
}

async function directoryHasSnapshots(backupPath: string): Promise<boolean> {
  try {
    return (await listSnapshots(resolveBackupRoot(backupPath))).length > 0;
  } catch {
    // Unreadable: treat as empty so a backup runs soon and reports the real error.
    return false;
  }
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
  /**
   * Bumped whenever the schedule is replaced or stopped. A timer or an
   * in-flight backup belongs to the generation it was armed in; when it
   * finishes under a newer generation it must not re-arm, or a paused
   * scheduler would restart and a replaced timer would be orphaned.
   */
  private generation = 0;
  /** Backup path the current schedule was computed for (`undefined` before init). */
  private appliedPath: string | undefined;

  private readonly runBackup: BackupRunner;
  private readonly setTimeoutFn: NonNullable<SchedulerDependencies['setTimeoutFn']>;
  private readonly clearTimeoutFn: NonNullable<SchedulerDependencies['clearTimeoutFn']>;
  private readonly loadSettings: () => Promise<Settings>;
  private readonly now: () => number;
  private readonly hasSnapshots: (backupPath: string) => Promise<boolean>;

  constructor(dependencies: SchedulerDependencies = {}) {
    this.runBackup = dependencies.runBackup ?? runBackup;
    this.setTimeoutFn =
      dependencies.setTimeoutFn ?? ((handler, timeout) => setTimeout(handler, timeout));
    this.clearTimeoutFn = dependencies.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    this.loadSettings = dependencies.loadSettings ?? getSettings;
    this.now = dependencies.now ?? (() => Date.now());
    this.hasSnapshots = dependencies.hasSnapshots ?? directoryHasSnapshots;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  stop(): void {
    this.generation += 1;
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
    const generation = this.generation;

    if (delay > MAX_TIMEOUT_MS) {
      this.handle = this.setTimeoutFn(() => {
        if (generation === this.generation) this.armAt(dueAt);
      }, MAX_TIMEOUT_MS);
      return;
    }

    this.handle = this.setTimeoutFn(
      () => {
        if (generation === this.generation) void this.tick(generation);
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

  /** Run a backup, skipping if one is already in flight. */
  async executeScheduledBackup(options?: BackupOptions): Promise<BackupResult | null> {
    if (this.running) {
      logger.warn('Scheduled backup already in progress; skipping this tick.');
      return null;
    }

    this.running = true;
    try {
      return await this.runBackup(options);
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

  /**
   * Read the persisted `lastBackup`. `undefined` means it could not be read,
   * which is different from `null` ("never backed up").
   */
  private async readLastBackup(): Promise<number | null | undefined> {
    try {
      return parseLastBackup((await this.loadSettings()).lastBackup);
    } catch (error) {
      logger.warn(
        'Could not read the last backup time; running the scheduled backup anyway.',
        error,
      );
      return undefined;
    }
  }

  /** The timer fired: run a backup (unless one ran meanwhile) and re-arm the next one. */
  private async tick(generation: number): Promise<void> {
    this.handle = null;

    // Another backup (e.g. a manual one) may have run since this timer was
    // armed. If so, the timer is stale: move it to a full interval after that
    // backup instead of taking a redundant snapshot.
    const lastBackupMs = await this.readLastBackup();
    if (generation !== this.generation) return;
    if (typeof lastBackupMs === 'number' && this.now() < lastBackupMs + this.intervalMs) {
      this.armAt(lastBackupMs + this.intervalMs);
      return;
    }

    // Repeat the check once the lock is held: a backup that was running when
    // this timer fired may finish while this one waits to start.
    const result = await this.executeScheduledBackup(
      lastBackupMs === undefined
        ? undefined
        : { skipIfBackedUpAfter: lastBackupMs ?? Number.NEGATIVE_INFINITY },
    );

    // The settings changed while the backup ran: whoever changed them has
    // already re-armed (or paused) the schedule.
    if (generation !== this.generation) return;

    if (result === null) {
      // The run failed (or was skipped because another one was in flight).
      // Retry much sooner than a full interval would.
      this.armAt(this.now() + RETRY_DELAY_MS);
      return;
    }

    this.armAt(this.now() + this.intervalMs);
  }

  /**
   * Arm (or disarm) the timer from the current settings.
   *
   * Automatic backups stay paused until a usable backup directory is set;
   * otherwise a fresh install would attempt — and fail — a backup every few
   * minutes. When the directory changes to one with no snapshots yet, the
   * `lastBackup` time (which belongs to the old directory) is ignored so the
   * new one gets a catch-up backup shortly instead of waiting an interval.
   */
  private async applySettings(settings: Settings): Promise<void> {
    const previousPath = this.appliedPath;
    this.appliedPath = settings.backupPath;

    if (!hasBackupPath(settings)) {
      this.stop();
      logger.info('Auto-backup paused: no usable backup directory is set.');
      return;
    }

    const pathChanged = previousPath !== undefined && previousPath !== settings.backupPath;
    if (pathChanged && !(await this.hasSnapshots(settings.backupPath))) {
      logger.info('Backup directory changed to one with no snapshots; scheduling a backup soon.');
      this.start(settings.backupInterval, undefined);
      return;
    }

    this.start(settings.backupInterval, settings.lastBackup);
  }

  /** Read the settings, start the timer, and watch for setting changes. */
  async init(): Promise<void> {
    await this.applySettings(await this.loadSettings());

    await joplin.settings.onChange((event) => {
      void this.handleSettingsChange(event.keys);
    });
  }

  async handleSettingsChange(keys: readonly string[]): Promise<void> {
    if (!keys.includes(SETTING_KEYS.backupInterval) && !keys.includes(SETTING_KEYS.backupPath)) {
      return;
    }

    try {
      await this.applySettings(await this.loadSettings());
    } catch (error) {
      logger.error('Could not apply the updated backup settings.', error);
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

export function stopScheduler(): void {
  defaultScheduler.stop();
}

export function isSchedulerRunning(): boolean {
  return defaultScheduler.isRunning();
}

export async function initScheduler(dependencies?: SchedulerDependencies): Promise<Scheduler> {
  const scheduler = dependencies ? createScheduler(dependencies) : defaultScheduler;
  await scheduler.init();
  return scheduler;
}
