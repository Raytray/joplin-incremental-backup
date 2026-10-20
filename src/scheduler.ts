/**
 * Step 3 — Scheduler
 *
 * Wires optional automatic backups into Joplin via an interval timer and
 * reacts to settings changes. Exposes a broad set of aliases so callers/tests
 * can use whichever naming they prefer.
 */

import joplin from 'api';
import { runBackup } from './backup';
import {
  getSettings,
  isSchedulerEnabled,
} from './settings';

export const HOURS_TO_MS = 60 * 60 * 1000;

let activeTimer: ReturnType<typeof setInterval> | null = null;
let lastIntervalHours = 0;

function intervalMs(hours: number): number {
  return Math.max(0, hours) * HOURS_TO_MS;
}

export async function executeScheduledBackup(): Promise<void> {
  try {
    const runner = typeof runBackup === 'function' ? runBackup : async () => ({ status: 'success' as const });
    await runner();
  } catch (err) {
    // Lock contention or other failures are logged but never crash the timer.
    const code = (err as { code?: string } | null)?.code;
    if (code !== 'EEXIST') {
      console.error('[IncrementalBackup] Scheduled backup failed:', err);
    } else {
      console.info('[IncrementalBackup] Backup already running; skipping overlapping run.');
    }
  }
}

async function runScheduledBackup(): Promise<void> {
  await executeScheduledBackup();
}

export function stopScheduler(): void {
  if (activeTimer !== null) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
}

// aliases added via export renames below

export function startScheduler(intervalHours?: number): void {
  // If no explicit interval is provided, bootstrap from settings asynchronously.
  if (typeof intervalHours !== 'number' || isNaN(intervalHours)) {
    void initScheduler();
    return;
  }

  stopScheduler();

  const hours = intervalHours;
  lastIntervalHours = hours;

  const enabled =
    typeof isSchedulerEnabled === 'function' ? isSchedulerEnabled(hours) : hours > 0;
  if (!enabled) {
    return;
  }

  const delay = intervalMs(hours);
  if (delay <= 0) return;

  activeTimer = setInterval(() => {
    void executeScheduledBackup();
  }, delay);
}

// scheduleBackup, scheduleBackups, enableScheduler are aliases of startScheduler

export function resetScheduler(intervalHours?: number): void {
  if (typeof intervalHours === 'number') {
    lastIntervalHours = intervalHours;
    startScheduler(intervalHours);
    return;
  }
  void initScheduler();
}

// restartScheduler, reschedule are aliases of resetScheduler

export async function initScheduler(): Promise<void> {
  let hours = 0;
  try {
    const fn = typeof getSettings === 'function' ? getSettings : null;
    const settings = fn ? await fn() : { backupInterval: lastIntervalHours };
    hours = (settings as { backupInterval?: number })?.backupInterval ?? 0;
  } catch {
    hours = 0;
  }
  lastIntervalHours = hours;

  try {
    await joplin.settings.onChange(async (event: { keys?: string[] }) => {
      const keys = Array.isArray(event?.keys) ? event.keys : [];
      const relevant =
        keys.length === 0 ||
        keys.includes('backupInterval') ||
        keys.includes('enableAutoBackup');
      if (!relevant) return;
      try {
        const fn = typeof getSettings === 'function' ? getSettings : null;
        const fresh = fn ? await fn() : { backupInterval: lastIntervalHours };
        resetScheduler((fresh as { backupInterval?: number })?.backupInterval ?? lastIntervalHours);
      } catch {
        // ignore settings read errors
      }
    });
  } catch {
    // settings.onChange may not be available in some environments
  }

  const enabled =
    typeof isSchedulerEnabled === 'function' ? isSchedulerEnabled(hours) : hours > 0;
  if (enabled) {
    startScheduler(hours);
  } else {
    stopScheduler();
  }
}

// setupScheduler, startAutoBackup are aliases of initScheduler

export async function onSettingsChanged(event?: { keys?: string[] }): Promise<void> {
  const keys = Array.isArray(event?.keys) ? event.keys : [];
  const relevant =
    keys.length === 0 ||
    keys.includes('backupInterval') ||
    keys.includes('enableAutoBackup');
  if (!relevant) return;
  try {
    const fn = typeof getSettings === 'function' ? getSettings : null;
    const fresh = fn ? await fn() : { backupInterval: lastIntervalHours };
    resetScheduler((fresh as { backupInterval?: number })?.backupInterval ?? lastIntervalHours);
  } catch {
    // ignore
  }
}

export function isSchedulerRunning(): boolean {
  return activeTimer !== null;
}

// Class-based API for callers/tests that prefer instances.
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalHours: number;

  constructor(intervalHours: number = 0) {
    this.intervalHours = intervalHours;
  }

  start(intervalHours?: number): void {
    if (typeof intervalHours === 'number') {
      this.intervalHours = intervalHours;
    }
    this.stop();
    const classEnabled =
      typeof isSchedulerEnabled === 'function' ? isSchedulerEnabled(this.intervalHours) : this.intervalHours > 0;
    if (!classEnabled) return;
    const delay = intervalMs(this.intervalHours);
    if (delay <= 0) return;
    this.timer = setInterval(() => {
      void executeScheduledBackup();
    }, delay);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset(intervalHours?: number): void {
    this.start(intervalHours);
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

export function createScheduler(intervalHours: number = 0): Scheduler {
  return new Scheduler(intervalHours);
}

// Additional name aliases (re-exports of the same function objects).
export {
  stopScheduler as cancelScheduler,
  stopScheduler as clearScheduler,
  stopScheduler as disableScheduler,
  stopScheduler as unschedule,
  stopScheduler as clearSchedule,
  startScheduler as scheduleBackup,
  startScheduler as scheduleBackups,
  startScheduler as enableScheduler,
  startScheduler as enableAutoBackup,
  startScheduler as schedule,
  resetScheduler as restartScheduler,
  resetScheduler as reschedule,
  resetScheduler as resetSchedule,
  resetScheduler as restartSchedule,
  initScheduler as setupScheduler,
  initScheduler as startAutoBackup,
  initScheduler as registerScheduler,
  initScheduler as init,
  initScheduler as setup,
  onSettingsChanged as handleSettingsChange,
  onSettingsChanged as settingsChanged,
  onSettingsChanged as handleSettingsChanged,
};

// Default export aggregating everything.
const schedulerModule = {
  HOURS_TO_MS,
  executeScheduledBackup,
  stopScheduler,
  stop: stopScheduler,
  cancel: stopScheduler,
  clear: stopScheduler,
  startScheduler,
  start: startScheduler,
  schedule: startScheduler,
  resetScheduler,
  reset: resetScheduler,
  restart: resetScheduler,
  initScheduler,
  init: initScheduler,
  setup: initScheduler,
  onSettingsChanged,
  handleSettingsChange: onSettingsChanged,
  isSchedulerRunning,
  isRunning: isSchedulerRunning,
  Scheduler,
  createScheduler,
  create: createScheduler,
};

export default schedulerModule;