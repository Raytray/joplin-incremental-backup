import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return { default: memfs.fs.promises, ...memfs.fs.promises };
});

import fs from 'fs/promises';
import path from 'path';
import { vol } from 'memfs';
import {
  createScheduler,
  HOUR_IN_MS,
  initScheduler,
  isSchedulerRunning,
  Scheduler,
  stopScheduler,
} from '../src/scheduler';
import type { BackupResult } from '../src/backup';
import { runBackup } from '../src/backup';
import { mockState, resetMockJoplin } from '../src/__mocks__/joplin';
import { SETTING_KEYS } from '../src/settings';
import type { Settings } from '../src/settings';

const BACKUP_ROOT = '/backups';

function successResult(): BackupResult {
  return { status: 'success', message: 'ok' };
}

function makeSettings(backupInterval: number): Settings {
  return {
    backupPath: BACKUP_ROOT,
    backupRetention: 5,
    backupInterval,
    onlyOnChange: true,
    lastBackup: '',
    lastSnapshot: '',
  };
}

/** A deterministic setInterval/clearInterval pair the test can drive. */
function createManualTimers() {
  const timers: Array<{ handler: () => void; timeout: number; cleared: boolean }> = [];
  return {
    timers,
    setIntervalFn: (handler: () => void, timeout: number) => {
      const timer = { handler, timeout, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: (handle: ReturnType<typeof setInterval>) => {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
    /** Fire every non-cleared timer, as the event loop would after the delay. */
    fireAll() {
      for (const timer of timers) {
        if (!timer.cleared) timer.handler();
      }
    },
  };
}

beforeEach(() => {
  vol.reset();
  resetMockJoplin();
});

describe('Scheduler.start / stop', () => {
  it('schedules an interval of the configured hours', () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
    });

    scheduler.start(2);

    expect(scheduler.isRunning()).toBe(true);
    expect(manual.timers).toHaveLength(1);
    expect(manual.timers[0].timeout).toBe(2 * HOUR_IN_MS);
  });

  it('does not schedule when the interval is 0', () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
    });

    scheduler.start(0);

    expect(scheduler.isRunning()).toBe(false);
    expect(manual.timers).toHaveLength(0);
  });

  it('stop clears the active timer', () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
    });

    scheduler.start(1);
    scheduler.stop();

    expect(scheduler.isRunning()).toBe(false);
    expect(manual.timers[0].cleared).toBe(true);
  });
});

describe('Scheduler tick', () => {
  it('advancing one interval calls runBackup once', async () => {
    const manual = createManualTimers();
    const runBackupFn = vi.fn(async () => successResult());
    const scheduler = createScheduler({
      runBackup: runBackupFn,
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
    });

    scheduler.start(1);
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
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
    });

    scheduler.start(1);
    manual.fireAll();
    manual.fireAll();

    expect(runBackupFn).toHaveBeenCalledTimes(1);

    resolveRun!(successResult());
    await vi.waitFor(() => expect(scheduler.isRunning()).toBe(true));
  });

  it('swallows EEXIST without throwing', async () => {
    const manual = createManualTimers();
    const scheduler = createScheduler({
      runBackup: async () => {
        throw Object.assign(new Error('locked'), { code: 'EEXIST' });
      },
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
    });

    scheduler.start(1);
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
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
      loadSettings: async () => makeSettings(3),
    });

    await scheduler.init();

    expect(scheduler.isRunning()).toBe(true);
    expect(manual.timers[0].timeout).toBe(3 * HOUR_IN_MS);
    expect(mockState.onChangeHandlers).toHaveLength(1);
  });

  it('resets the timer when backupInterval changes', async () => {
    const manual = createManualTimers();
    let interval = 1;
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
      loadSettings: async () => makeSettings(interval),
    });

    await scheduler.init();

    interval = 6;
    await scheduler.handleSettingsChange([SETTING_KEYS.backupInterval]);

    expect(manual.timers).toHaveLength(2);
    expect(manual.timers[0].cleared).toBe(true);
    expect(manual.timers[1].timeout).toBe(6 * HOUR_IN_MS);
  });

  it('disables the timer when the new interval is 0', async () => {
    const manual = createManualTimers();
    let interval = 4;
    const scheduler = createScheduler({
      runBackup: async () => successResult(),
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
      loadSettings: async () => makeSettings(interval),
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
      setIntervalFn: manual.setIntervalFn,
      clearIntervalFn: manual.clearIntervalFn,
      loadSettings: async () => makeSettings(1),
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
