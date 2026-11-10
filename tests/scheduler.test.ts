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
  FAILURE_BACKOFF_MS,
  HOUR_IN_MS,
  initScheduler,
  isSchedulerRunning,
  MAX_TIMEOUT_MS,
  parseLastBackup,
  RETRY_DELAY_MS,
  Scheduler,
  stopScheduler,
} from '../src/scheduler';
import type { BackupOptions, BackupResult } from '../src/backup';
import { runBackup } from '../src/backup';
import { mockState, resetMockJoplin } from '../src/__mocks__/joplin';
import { LockError } from '../src/platform';
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
    stageLocally: false,
    lastBackup,
    lastSnapshot: '',
    initializedBackupRoots: [],
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

/** Let pending promise continuations (and the ticks after them) run. */
const flushEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Timers that are still armed. */
const live = (timers: Array<{ cleared: boolean; fired: boolean }>) =>
  timers.filter((timer) => !timer.cleared && !timer.fired);

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
        throw new LockError('/backups/.backup.lock');
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

describe('Scheduler — repeated failures', () => {
  const MINUTE = 60 * 1000;

  /**
   * A scheduler whose runs follow `outcomes` (a failure, a filesystem
   * `EEXIST` failure, lock contention or success), with
   * the options of each call recorded. Returns the re-arm delay after each run.
   */
  function setup(outcomes: Array<'fail' | 'eexist' | 'lock' | 'ok'>, intervalHours = 24) {
    const manual = createManualTimers();
    const calls: Array<BackupOptions | undefined> = [];
    let index = 0;
    const scheduler = createScheduler({
      runBackup: async (options) => {
        calls.push(options);
        const outcome = outcomes[index++];
        if (outcome === 'fail') throw new Error('drive missing');
        if (outcome === 'eexist') throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        if (outcome === 'lock') throw new LockError('/backups/.backup.lock');
        return successResult();
      },
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(intervalHours),
      now: () => NOW,
    });
    scheduler.start(intervalHours, new Date(NOW - 25 * HOUR_IN_MS).toISOString());

    const runAll = async (): Promise<number[]> => {
      for (let run = 1; run <= outcomes.length; run++) {
        manual.fire(manual.last()!);
        await vi.waitFor(() => expect(manual.timers).toHaveLength(run + 1));
      }
      return manual.timers.slice(1).map((timer) => timer.timeout);
    };
    return { scheduler, calls, runAll };
  }

  it('backs off 5m → 15m → 1h → the interval while failures repeat', async () => {
    const { runAll } = setup(['fail', 'fail', 'fail', 'fail', 'fail']);
    expect(await runAll()).toEqual([
      5 * MINUTE,
      15 * MINUTE,
      60 * MINUTE,
      24 * HOUR_IN_MS,
      24 * HOUR_IN_MS,
    ]);
    expect(FAILURE_BACKOFF_MS[0]).toBe(RETRY_DELAY_MS);
  });

  it('runs quietly after a failure, until a run succeeds', async () => {
    const { calls, runAll } = setup(['fail', 'fail', 'fail', 'ok', 'fail']);
    await runAll();
    expect(calls.map((options) => options?.quiet)).toEqual([false, true, true, true, false]);
  });

  it('starts over after a successful run', async () => {
    const { runAll } = setup(['fail', 'fail', 'ok', 'fail']);
    expect(await runAll()).toEqual([5 * MINUTE, 15 * MINUTE, 24 * HOUR_IN_MS, 5 * MINUTE]);
  });

  it('never waits longer than the interval', async () => {
    const { runAll } = setup(['fail', 'fail', 'fail'], 0.5);
    expect(await runAll()).toEqual([5 * MINUTE, 15 * MINUTE, 30 * MINUTE]);
  });

  it('does not count lock contention as a failure', async () => {
    const { calls, runAll } = setup(['fail', 'lock', 'lock', 'fail']);
    expect(await runAll()).toEqual([5 * MINUTE, 5 * MINUTE, 5 * MINUTE, 15 * MINUTE]);
    expect(calls.map((options) => options?.quiet)).toEqual([false, true, true, true]);
  });

  it('counts a filesystem EEXIST error as a failure, not as lock contention', async () => {
    const { calls, runAll } = setup(['eexist', 'eexist', 'eexist']);
    expect(await runAll()).toEqual([5 * MINUTE, 15 * MINUTE, 60 * MINUTE]);
    expect(calls.map((options) => options?.quiet)).toEqual([false, true, true]);
  });

  it('starts over when the settings change', async () => {
    const { scheduler, calls, runAll } = setup(['fail', 'fail']);
    await runAll();
    scheduler.start(24, new Date(NOW - 25 * HOUR_IN_MS).toISOString());
    // Nothing else is recorded about the restart: the next run toasts again.
    await expect(scheduler.executeScheduledBackup()).resolves.toEqual(successResult());
    expect(calls.at(-1)?.quiet).toBe(false);
  });

  it('does not let a run that fails after a settings change carry its failure over', async () => {
    const manual = createManualTimers();
    const calls: Array<BackupOptions | undefined> = [];
    let rejectRun: ((error: Error) => void) | undefined;
    const scheduler = createScheduler({
      runBackup: (options) => {
        calls.push(options);
        return new Promise<BackupResult>((_resolve, reject) => {
          rejectRun = reject;
        });
      },
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24),
      now: () => NOW,
    });
    const lastBackup = new Date(NOW - 25 * HOUR_IN_MS).toISOString();
    scheduler.start(24, lastBackup);

    manual.fire(manual.last()!);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The user changes the settings while the run is still waiting on the drive.
    scheduler.start(24, lastBackup);
    rejectRun!(new Error('drive missing'));
    await flushEventLoop();

    manual.fire(manual.last()!);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.quiet).toBe(false);
    rejectRun!(new Error('drive missing'));
    // Armed: the first schedule, the restarted one, then the retry. The old
    // run's failure re-armed nothing.
    await vi.waitFor(() => expect(manual.timers).toHaveLength(3));
    expect(manual.last()!.timeout).toBe(5 * MINUTE);
  });

  it('keeps a quiet flag passed by the caller', async () => {
    const calls: Array<BackupOptions | undefined> = [];
    const scheduler = createScheduler({
      runBackup: async (options) => {
        calls.push(options);
        return successResult();
      },
    });
    await scheduler.executeScheduledBackup({ quiet: true });
    expect(calls[0]?.quiet).toBe(true);
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
    await flushEventLoop();

    expect(runBackupFn).toHaveBeenCalledTimes(1);

    resolveRun!(successResult());
    await vi.waitFor(() => expect(scheduler.isRunning()).toBe(true));
  });

  it('swallows lock contention without throwing', async () => {
    const scheduler = createScheduler({
      runBackup: async () => {
        throw new LockError('/backups/.backup.lock');
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

describe('Scheduler — another backup ran since the timer was armed', () => {
  it('re-arms a full interval after a manual backup instead of running', async () => {
    const manual = createManualTimers();
    let clock = NOW;
    let lastBackup = new Date(NOW - 23 * HOUR_IN_MS).toISOString();
    const runBackupFn = vi.fn(async () => successResult());
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, lastBackup),
      now: () => clock,
    });

    await scheduler.init();
    // Last backup 23 hours ago on a 24 hour interval → due in 1 hour.
    expect(manual.timers[0].timeout).toBe(HOUR_IN_MS);

    // A manual backup runs 50 minutes later; the timer fires 10 minutes after it.
    const manualAt = NOW + 50 * 60 * 1000;
    lastBackup = new Date(manualAt).toISOString();
    clock = NOW + HOUR_IN_MS;
    manual.fire(manual.timers[0]);
    await flushEventLoop();

    expect(runBackupFn).not.toHaveBeenCalled();
    expect(live(manual.timers)).toHaveLength(1);
    expect(manual.last()!.timeout).toBe(manualAt + 24 * HOUR_IN_MS - clock);
  });

  it('runs when lastBackup is unchanged, passing it on for the post-lock check', async () => {
    const manual = createManualTimers();
    const lastBackup = new Date(NOW - 23 * HOUR_IN_MS).toISOString();
    const runBackupFn = vi.fn(async (_options?: BackupOptions) => successResult());
    let clock = NOW;
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, lastBackup),
      now: () => clock,
    });

    await scheduler.init();
    clock = NOW + HOUR_IN_MS;
    manual.fire(manual.timers[0]);
    await flushEventLoop();

    expect(runBackupFn).toHaveBeenCalledTimes(1);
    expect(runBackupFn.mock.calls[0][0]).toEqual({
      quiet: false,
      skipIfBackedUpAfter: Date.parse(lastBackup),
    });
  });

  it('passes -Infinity when no backup was ever recorded', async () => {
    const manual = createManualTimers();
    const runBackupFn = vi.fn(async (_options?: BackupOptions) => successResult());
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24),
      now: () => NOW,
    });

    await scheduler.init();
    manual.fire(manual.timers[0]);
    await flushEventLoop();

    expect(runBackupFn.mock.calls[0][0]).toEqual({
      quiet: false,
      skipIfBackedUpAfter: Number.NEGATIVE_INFINITY,
    });
  });

  it('still runs, keeping the armed baseline, when settings cannot be read', async () => {
    const manual = createManualTimers();
    let fail = false;
    const runBackupFn = vi.fn(async (_options?: BackupOptions) => successResult());
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => {
        if (fail) throw new Error('settings unavailable');
        return makeSettings(24);
      },
      now: () => NOW,
    });

    await scheduler.init();
    fail = true;
    manual.fire(manual.timers[0]);
    await flushEventLoop();

    expect(runBackupFn).toHaveBeenCalledTimes(1);
    expect(runBackupFn.mock.calls[0][0]).toEqual({
      quiet: false,
      skipIfBackedUpAfter: Number.NEGATIVE_INFINITY,
    });
  });

  it('does not mistake its own successful run for another backup', async () => {
    const manual = createManualTimers();
    let clock = NOW;
    let lastBackup = new Date(NOW - 25 * HOUR_IN_MS).toISOString();
    const runBackupFn = vi.fn(async (_options?: BackupOptions) => {
      lastBackup = new Date(clock).toISOString();
      return successResult();
    });
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, lastBackup),
      now: () => clock,
    });

    await scheduler.init();
    manual.fire(manual.last()!);
    await flushEventLoop();
    expect(runBackupFn).toHaveBeenCalledTimes(1);

    clock += 24 * HOUR_IN_MS;
    manual.fire(manual.last()!);
    await flushEventLoop();

    expect(runBackupFn).toHaveBeenCalledTimes(2);
    expect(runBackupFn.mock.calls[1][0]).toEqual({ quiet: false, skipIfBackedUpAfter: NOW });
  });

  it('runs when lastBackup is in the future (clock corrected backwards)', async () => {
    const manual = createManualTimers();
    const future = new Date(NOW + 2 * 24 * HOUR_IN_MS).toISOString();
    const runBackupFn = vi.fn(async (_options?: BackupOptions) => successResult());
    let clock = NOW;
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, future),
      now: () => clock,
    });

    // Armed for lastBackup + interval; the clock never gets there in this
    // test, but a timer that does fire must not be pushed out again.
    scheduler.start(24, future);
    clock = NOW + HOUR_IN_MS;
    manual.fire(manual.last()!);
    await flushEventLoop();

    expect(runBackupFn).toHaveBeenCalledTimes(1);
  });

  it('re-arms from the superseding backup when the post-lock check skips', async () => {
    const manual = createManualTimers();
    const manualAt = NOW + 50 * 60 * 1000;
    let lastBackup = new Date(NOW - 23 * HOUR_IN_MS).toISOString();
    let clock = NOW;
    const scheduler = createScheduler({
      runBackup: async () => {
        // A manual backup finished while this run waited for the lock.
        lastBackup = new Date(manualAt).toISOString();
        clock = manualAt + 5 * 60 * 1000;
        return { status: 'skipped', message: 'superseded', supersededBy: manualAt };
      },
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, lastBackup),
      now: () => clock,
    });

    await scheduler.init();
    clock = NOW + HOUR_IN_MS;
    manual.fire(manual.last()!);
    await flushEventLoop();

    expect(live(manual.timers)).toHaveLength(1);
    expect(manual.last()!.timeout).toBe(manualAt + 24 * HOUR_IN_MS - clock);
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
    await flushEventLoop();
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

  it('runs the catch-up backup for the new directory when its timer fires', async () => {
    const manual = createManualTimers();
    let backupPath = '/old';
    const runBackupFn = vi.fn(async (_options?: BackupOptions) => successResult());
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setTimeoutFn: manual.setTimeoutFn,
      clearTimeoutFn: manual.clearTimeoutFn,
      loadSettings: async () => makeSettings(24, recent(), backupPath),
      now: () => NOW,
      hasSnapshots: async () => false,
    });

    await scheduler.init();
    backupPath = '/new';
    await scheduler.handleSettingsChange([SETTING_KEYS.backupPath]);
    manual.fire(manual.last()!);
    await flushEventLoop();

    // The old directory's recent lastBackup must not cancel the catch-up.
    expect(runBackupFn).toHaveBeenCalledTimes(1);
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
