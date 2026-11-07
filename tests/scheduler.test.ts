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

function makeSettings(backupInterval: number, lastBackup = '', backupPath = BACKUP_ROOT): Settings {
  return {
    backupPath,
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
      for (const timer of timers.slice()) {
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

describe('Scheduler.reschedule', () => {
  it('re-arms a full interval after the lastBackup set by a manual backup', async () => {
    const manual = createManualTimers();
    let lastBackup = new Date(NOW - 23 * HOUR_IN_MS).toISOString();
    const runBackupFn = vi.fn(async () => successResult());
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, lastBackup),
      now: () => NOW,
    });

    await scheduler.init();
    // Last backup 23 hours ago on a 24 hour interval → due in 1 hour.
    expect(manual.timers[0].timeout).toBe(HOUR_IN_MS);

    // A manual backup just finished and recorded the current time.
    lastBackup = new Date(NOW).toISOString();
    await scheduler.reschedule();

    expect(manual.timers[0].cleared).toBe(true);
    expect(manual.timers).toHaveLength(2);
    expect(manual.timers[1].timeout).toBe(24 * HOUR_IN_MS);

    // The stale timer no longer triggers a backup.
    manual.fire(manual.timers[0]);
    expect(runBackupFn).not.toHaveBeenCalled();
  });

  it('logs instead of throwing when the settings cannot be read', async () => {
    let fail = false;
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: createManualTimers().setTimeoutFn,
      clearTimeoutFn: () => undefined,
      loadSettings: async () => {
        if (fail) throw new Error('settings unavailable');
        return makeSettings(24);
      },
      now: () => NOW,
    });

    await scheduler.init();
    fail = true;
    await expect(scheduler.reschedule()).resolves.toBeUndefined();
  });
});

describe('Scheduler without a backup directory', () => {
  it('does not arm a timer at startup when no backup directory is set', async () => {
    const manual = createManualTimers();
    const runBackup = vi.fn(async () => successResult());
    const scheduler = createScheduler({
      runBackup,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, '', ''),
      now: () => NOW,
    });

    await scheduler.init();

    expect(scheduler.isRunning()).toBe(false);
    expect(manual.timers).toHaveLength(0);
    expect(runBackup).not.toHaveBeenCalled();
  });

  it('starts once a backup directory is set', async () => {
    const manual = createManualTimers();
    let backupPath = '';
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, '', backupPath),
      now: () => NOW,
    });

    await scheduler.init();
    expect(scheduler.isRunning()).toBe(false);

    backupPath = BACKUP_ROOT;
    await scheduler.handleSettingsChange([SETTING_KEYS.backupPath]);

    expect(scheduler.isRunning()).toBe(true);
    expect(manual.timers[0].timeout).toBe(CATCH_UP_GRACE_MS);
  });

  it('stops when the backup directory is cleared', async () => {
    const manual = createManualTimers();
    let backupPath = BACKUP_ROOT;
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, '', backupPath),
      now: () => NOW,
    });

    await scheduler.init();
    expect(scheduler.isRunning()).toBe(true);

    backupPath = '';
    await scheduler.handleSettingsChange([SETTING_KEYS.backupPath]);

    expect(scheduler.isRunning()).toBe(false);
    expect(manual.timers[0].cleared).toBe(true);
  });
});

describe('Scheduler — settings change while a backup is running', () => {
  /** A runBackup whose completion the test controls. */
  function controlledRun() {
    let finish: (result: BackupResult) => void = () => undefined;
    const runBackup = vi.fn(
      () =>
        new Promise<BackupResult>((resolve) => {
          finish = resolve;
        }),
    );
    return { runBackup, finish: (result = successResult()) => finish(result) };
  }

  /** Let the finished backup's continuation (and the tick after it) run. */
  const flushEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  const live = (timers: Array<{ cleared: boolean; fired: boolean }>) =>
    timers.filter((timer) => !timer.cleared && !timer.fired);

  it('stays paused when the directory is cleared mid-backup', async () => {
    const manual = createManualTimers();
    const backup = controlledRun();
    let backupPath = BACKUP_ROOT;
    const scheduler = createScheduler({
      runBackup: backup.runBackup,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, '', backupPath),
      now: () => NOW,
    });

    await scheduler.init();
    manual.fireAll(); // startup catch-up begins; the backup is now in flight
    expect(backup.runBackup).toHaveBeenCalledTimes(1);

    backupPath = '';
    await scheduler.handleSettingsChange([SETTING_KEYS.backupPath]);
    backup.finish();
    await flushEventLoop();

    expect(scheduler.isRunning()).toBe(false);
    expect(live(manual.timers)).toHaveLength(0);
  });

  it('keeps a single live timer when the interval changes mid-backup', async () => {
    const manual = createManualTimers();
    const backup = controlledRun();
    let interval = 24;
    const scheduler = createScheduler({
      runBackup: backup.runBackup,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(interval),
      now: () => NOW,
    });

    await scheduler.init();
    manual.fireAll();

    interval = 6;
    await scheduler.handleSettingsChange([SETTING_KEYS.backupInterval]);
    const armedBySettings = manual.last();
    backup.finish();
    await flushEventLoop();

    expect(live(manual.timers)).toEqual([armedBySettings]);
  });
});

describe('Scheduler — backup directory changes', () => {
  const recent = () => new Date(NOW - 60 * 60 * 1000).toISOString();

  it('backs up soon when switching to a directory with no snapshots', async () => {
    const manual = createManualTimers();
    let backupPath = '/old';
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, recent(), backupPath),
      now: () => NOW,
      hasSnapshots: async () => false,
    });

    await scheduler.init();
    expect(manual.last()!.timeout).toBe(23 * HOUR_IN_MS);

    backupPath = '/new';
    await scheduler.handleSettingsChange([SETTING_KEYS.backupPath]);

    expect(manual.last()!.timeout).toBe(CATCH_UP_GRACE_MS);
  });

  it('keeps the regular schedule when the new directory already has snapshots', async () => {
    const manual = createManualTimers();
    let backupPath = '/old';
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, recent(), backupPath),
      now: () => NOW,
      hasSnapshots: async () => true,
    });

    await scheduler.init();
    backupPath = '/existing';
    await scheduler.handleSettingsChange([SETTING_KEYS.backupPath]);

    expect(manual.last()!.timeout).toBe(23 * HOUR_IN_MS);
  });

  it('detects snapshots on disk by default', async () => {
    await fs.mkdir(path.join('/existing', '20260101T000000'), { recursive: true });
    const manual = createManualTimers();
    let backupPath = '/old';
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, recent(), backupPath),
      now: () => NOW,
    });

    await scheduler.init();
    backupPath = '/existing';
    await scheduler.handleSettingsChange([SETTING_KEYS.backupPath]);
    expect(manual.last()!.timeout).toBe(23 * HOUR_IN_MS);

    backupPath = '/empty';
    await scheduler.handleSettingsChange([SETTING_KEYS.backupPath]);
    expect(manual.last()!.timeout).toBe(CATCH_UP_GRACE_MS);
  });

  it('stays paused for a relative directory', async () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, '', 'relative/backups'),
      now: () => NOW,
    });

    await scheduler.init();
    expect(scheduler.isRunning()).toBe(false);
    expect(manual.timers).toHaveLength(0);
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
