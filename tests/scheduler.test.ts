import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return { default: memfs.fs.promises, ...memfs.fs.promises };
});

import fs from 'fs/promises';
import path from 'path';
import { vol } from 'memfs';
import {
  CATCH_UP_GRACE_MS,
  createScheduler,
  HOUR_IN_MS,
  initScheduler,
  isSchedulerRunning,
  MAX_TIMEOUT_MS,
  parseLastBackup,
  RETRY_DELAY_MS,
  Scheduler,
  stopScheduler,
} from '../src/scheduler';
import type { BackupResult } from '../src/backup';
import { runBackup } from '../src/backup';
import { mockState, resetMockJoplin } from '../src/__mocks__/joplin';
import { SETTING_KEYS } from '../src/settings';
import type { Settings } from '../src/settings';

const BACKUP_ROOT = '/backups';

const NOW = Date.parse('2026-01-02T12:00:00.000Z');

function successResult(): BackupResult {
  return { status: 'success', message: 'ok' };
}

function makeSettings(backupInterval: number, lastBackup = ''): Settings {
  return {
    backupPath: BACKUP_ROOT,
    backupRetention: 5,
    backupInterval,
    onlyOnChange: true,
    lastBackup,
    lastSnapshot: '',
  };
}

interface ManualTimer {
  handler: () => void;
  timeout: number;
  cleared: boolean;
  fired: boolean;
}

/** A deterministic setTimeout/clearTimeout pair the test can drive. */
function createManualTimers() {
  const timers: ManualTimer[] = [];
  return {
    timers,
    setTimeoutFn: (handler: () => void, timeout: number) => {
      const timer: ManualTimer = { handler, timeout, cleared: false, fired: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
      (handle as unknown as ManualTimer).cleared = true;
    },
    /** The most recently armed timer. */
    last(): ManualTimer | undefined {
      return timers[timers.length - 1];
    },
    /** Fire one specific timer, even if it already fired before. */
    fire(timer: ManualTimer) {
      if (timer.cleared) return;
      timer.fired = true;
      timer.handler();
    },
    /**
     * Fire every timer that has not fired yet, as the event loop would.
     *
     * The list is snapshotted first: a timer that re-arms itself must not be
     * fired again by the same sweep.
     */
    fireAll() {
      for (const timer of [...timers]) {
        if (!timer.cleared && !timer.fired) this.fire(timer);
      }
    },
  };
}

beforeEach(() => {
  vol.reset();
  resetMockJoplin();
});

describe('parseLastBackup', () => {
  it('parses an ISO timestamp', () => {
    expect(parseLastBackup('2026-01-02T03:04:05.000Z')).toBe(
      Date.parse('2026-01-02T03:04:05.000Z'),
    );
  });

  it('treats missing or invalid values as "never backed up"', () => {
    expect(parseLastBackup('')).toBeNull();
    expect(parseLastBackup(undefined)).toBeNull();
    expect(parseLastBackup('not a date')).toBeNull();
  });
});

describe('Scheduler.start / stop', () => {
  it('arms a timer for the configured interval', () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => NOW,
    });

    // Last backup was one hour ago → the run is due in 23 hours.
    scheduler.start(24, new Date(NOW - HOUR_IN_MS).toISOString());

    expect(scheduler.isRunning()).toBe(true);
    expect(manual.timers).toHaveLength(1);
    expect(manual.timers[0].timeout).toBe(23 * HOUR_IN_MS);
  });

  it('does not schedule when the interval is 0', () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => NOW,
    });

    scheduler.start(0);

    expect(scheduler.isRunning()).toBe(false);
    expect(manual.timers).toHaveLength(0);
  });

  it('stop clears the active timer', () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => NOW,
    });

    scheduler.start(1, new Date(NOW - HOUR_IN_MS).toISOString());
    scheduler.stop();

    expect(scheduler.isRunning()).toBe(false);
    expect(manual.timers[0].cleared).toBe(true);
  });
});

describe('Scheduler startup catch-up', () => {
  function schedulerAt(now: number, manual: ReturnType<typeof createManualTimers>) {
    return createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => now,
    });
  }

  it('runs shortly after startup when there was never a backup', () => {
    const manual = createManualTimers();

    schedulerAt(NOW, manual).start(24);

    expect(manual.timers[0].timeout).toBe(CATCH_UP_GRACE_MS);
  });

  it('runs shortly after startup when the last backup is at least 2 intervals old', () => {
    const manual = createManualTimers();
    const twoIntervalsAgo = new Date(NOW - 48 * HOUR_IN_MS).toISOString();

    schedulerAt(NOW, manual).start(24, twoIntervalsAgo);

    expect(manual.timers[0].timeout).toBe(CATCH_UP_GRACE_MS);
  });

  it('waits for the next interval boundary when the last backup is 1 to 2 intervals old', () => {
    const manual = createManualTimers();
    const thirtyHoursAgo = new Date(NOW - 30 * HOUR_IN_MS).toISOString();

    schedulerAt(NOW, manual).start(24, thirtyHoursAgo);

    // Next boundary after 30h is 48h → 18h from now.
    expect(manual.timers[0].timeout).toBe(18 * HOUR_IN_MS);
  });

  it('waits for the remaining time when the last backup is younger than one interval', () => {
    const manual = createManualTimers();
    const sixHoursAgo = new Date(NOW - 6 * HOUR_IN_MS).toISOString();

    schedulerAt(NOW, manual).start(24, sixHoursAgo);

    expect(manual.timers[0].timeout).toBe(18 * HOUR_IN_MS);
  });

  it('treats an unparseable timestamp as "never backed up"', () => {
    const manual = createManualTimers();

    schedulerAt(NOW, manual).start(24, 'garbage');

    expect(manual.timers[0].timeout).toBe(CATCH_UP_GRACE_MS);
  });
});

describe('Scheduler re-arming', () => {
  it('re-arms one interval after a successful run', async () => {
    const manual = createManualTimers();
    let clock = NOW;
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => clock,
    });

    scheduler.start(24, new Date(NOW - 25 * HOUR_IN_MS).toISOString());
    expect(manual.timers).toHaveLength(1);

    clock = NOW + 1000;
    manual.fireAll();

    await vi.waitFor(() => expect(manual.timers).toHaveLength(2));
    expect(manual.timers[1].timeout).toBe(24 * HOUR_IN_MS);
  });

  it('re-arms after five minutes when the run fails', async () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => {
        throw new Error('boom');
      },
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => NOW,
    });

    scheduler.start(24, new Date(NOW - 25 * HOUR_IN_MS).toISOString());
    manual.fireAll();

    await vi.waitFor(() => expect(manual.timers).toHaveLength(2));
    expect(manual.timers[1].timeout).toBe(RETRY_DELAY_MS);
  });

  it('re-arms after five minutes when another backup holds the lock', async () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => {
        throw Object.assign(new Error('locked'), { code: 'EEXIST' });
      },
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => NOW,
    });

    scheduler.start(24, new Date(NOW - 25 * HOUR_IN_MS).toISOString());
    manual.fireAll();

    await vi.waitFor(() => expect(manual.timers).toHaveLength(2));
    expect(manual.timers[1].timeout).toBe(RETRY_DELAY_MS);
  });

  it('caps the delay at MAX_TIMEOUT_MS and re-arms instead of firing early', async () => {
    const manual = createManualTimers();
    const runBackupFn = vi.fn(async () => successResult());
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => NOW,
    });

    // 365 days — far beyond the 2³¹−1 ms limit of a single setTimeout.
    scheduler.start(8760, new Date(NOW - HOUR_IN_MS).toISOString());

    expect(manual.timers[0].timeout).toBe(MAX_TIMEOUT_MS);

    manual.fireAll();

    await vi.waitFor(() => expect(manual.timers).toHaveLength(2));
    expect(manual.timers[1].timeout).toBe(MAX_TIMEOUT_MS);
    expect(runBackupFn).not.toHaveBeenCalled();
  });
});

describe('Scheduler tick', () => {
  it('firing the timer calls runBackup once', async () => {
    const manual = createManualTimers();
    const runBackupFn = vi.fn(async () => successResult());
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => NOW,
    });

    scheduler.start(24, new Date(NOW - 25 * HOUR_IN_MS).toISOString());
    manual.fireAll();

    await vi.waitFor(() => expect(runBackupFn).toHaveBeenCalledTimes(1));
  });

  it('ignores a tick while a backup is already running', async () => {
    const manual = createManualTimers();
    let resolveRun: ((result: BackupResult) => void) | undefined;
    const runBackupFn = vi.fn(
      () =>
        new Promise<BackupResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      now: () => NOW,
    });

    scheduler.start(24, new Date(NOW - 25 * HOUR_IN_MS).toISOString());
    manual.fire(manual.timers[0]);
    manual.fire(manual.timers[0]);

    expect(runBackupFn).toHaveBeenCalledTimes(1);

    resolveRun!(successResult());
    await vi.waitFor(() => expect(scheduler.isRunning()).toBe(true));
  });

  it('swallows EEXIST without throwing', async () => {
    const scheduler = createScheduler({
      runBackup: async () => {
        throw Object.assign(new Error('locked'), { code: 'EEXIST' });
      },
    });

    await expect(scheduler.executeScheduledBackup()).resolves.toBeNull();
  });

  it('swallows other errors without throwing', async () => {
    const scheduler = createScheduler({
      runBackup: async () => {
        throw new Error('boom');
      },
    });

    await expect(scheduler.executeScheduledBackup()).resolves.toBeNull();
  });
});

describe('Scheduler.init and settings changes', () => {
  it('starts from the persisted interval and subscribes to changes', async () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(3),
      now: () => NOW,
    });

    await scheduler.init();

    expect(scheduler.isRunning()).toBe(true);
    // No previous backup → a catch-up run shortly after startup.
    expect(manual.timers[0].timeout).toBe(CATCH_UP_GRACE_MS);
    expect(mockState.onChangeHandlers).toHaveLength(1);
  });

  it('resets the timer when backupInterval changes', async () => {
    const manual = createManualTimers();
    let interval = 1;
    let lastBackup = new Date(NOW - 30 * 60 * 1000).toISOString();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(interval, lastBackup),
      now: () => NOW,
    });

    await scheduler.init();

    interval = 6;
    lastBackup = new Date(NOW - 30 * 60 * 1000).toISOString();
    await scheduler.handleSettingsChange([SETTING_KEYS.backupInterval]);

    expect(manual.timers).toHaveLength(2);
    expect(manual.timers[0].cleared).toBe(true);
    // 6 hour interval, last backup 30 minutes ago → due in 5.5 hours.
    expect(manual.timers[1].timeout).toBe(5.5 * HOUR_IN_MS);
  });

  it('disables the timer when the new interval is 0', async () => {
    const manual = createManualTimers();
    let interval = 4;
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(interval),
      now: () => NOW,
    });

    await scheduler.init();
    interval = 0;
    await scheduler.handleSettingsChange([SETTING_KEYS.backupInterval]);

    expect(scheduler.isRunning()).toBe(false);
    expect(manual.timers[0].cleared).toBe(true);
  });

  it('ignores changes to unrelated settings', async () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(1),
      now: () => NOW,
    });

    await scheduler.init();
    await scheduler.handleSettingsChange([SETTING_KEYS.onlyOnChange]);

    expect(manual.timers).toHaveLength(1);
  });
});

describe('module-level default scheduler', () => {
  it('initScheduler wires a scheduler with injected deps', async () => {
    const scheduler = await initScheduler({
      runBackup: async () => successResult(),
      loadSettings: async () => makeSettings(2),
    });

    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('initScheduler without deps uses the shared singleton', async () => {
    mockState.values = {
      [SETTING_KEYS.backupPath]: BACKUP_ROOT,
      [SETTING_KEYS.backupRetention]: 5,
      [SETTING_KEYS.backupInterval]: 0,
      [SETTING_KEYS.onlyOnChange]: true,
    };

    const scheduler = await initScheduler();

    expect(isSchedulerRunning()).toBe(false);
    stopScheduler();
    expect(scheduler).toBeInstanceOf(Scheduler);
  });
});

describe('overlapping runs self-serialize via the lock', () => {
  it('a second concurrent runBackup fails with EEXIST', async () => {
    await fs.mkdir(BACKUP_ROOT, { recursive: true });
    mockState.values = {
      [SETTING_KEYS.backupPath]: BACKUP_ROOT,
      [SETTING_KEYS.backupRetention]: 5,
      [SETTING_KEYS.backupInterval]: 0,
      [SETTING_KEYS.onlyOnChange]: true,
      [SETTING_KEYS.lastBackup]: '',
      [SETTING_KEYS.lastSnapshot]: '',
    };
    mockState.dataItems = {
      notes: [],
      folders: [],
      resources: [],
    };

    // First run holds the lock while the export never resolves.
    let releaseExport: (() => void) | undefined;
    mockState.commandHandlers.exportFolders = () =>
      new Promise<void>((resolve) => {
        releaseExport = resolve;
      });

    const first = runBackup({ backupRoot: BACKUP_ROOT, exportRetries: 1 });
    // Let the lock be acquired before starting the second run.
    await vi.waitFor(async () => {
      const hasLock = await fs
        .stat(path.join(BACKUP_ROOT, '.backup.lock'))
        .then(() => true)
        .catch(() => false);
      expect(hasLock).toBe(true);
    });

    await expect(runBackup({ backupRoot: BACKUP_ROOT, exportRetries: 1 })).rejects.toMatchObject({
      code: 'EEXIST',
    });

    releaseExport?.();
    await first.catch(() => undefined);
  });
});
