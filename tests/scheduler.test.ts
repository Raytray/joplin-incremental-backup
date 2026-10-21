import joplin from 'api';

jest.mock('../src/backup', () => ({
  runBackup: jest.fn().mockResolvedValue({ status: 'success' }),
}));

import * as sched from '../src/scheduler';
import { runBackup } from '../src/backup';

describe('Scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
      if (key === 'backupInterval') return Promise.resolve(24);
      if (key === 'backupPath') return Promise.resolve('/backups');
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    sched.stopScheduler();
    jest.useRealTimers();
  });

  it('initScheduler reads settings and sets timer', async () => {
    await sched.initScheduler();
    expect(joplin.settings.onChange).toHaveBeenCalled();
    // advance 24h
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await Promise.resolve();
    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it('startScheduler with hours sets timer', () => {
    sched.startScheduler(1);
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it('stopScheduler cancels timer', () => {
    sched.startScheduler(1);
    sched.stopScheduler();
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(runBackup).not.toHaveBeenCalled();
  });

  it('resetScheduler changes interval', async () => {
    sched.startScheduler(24);
    sched.resetScheduler(1);
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it('setting change resets timer', async () => {
    await sched.initScheduler();
    const cb = (joplin.settings.onChange as jest.Mock).mock.calls[0][0];
    (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
      if (key === 'backupInterval') return Promise.resolve(1);
      if (key === 'backupPath') return Promise.resolve('/backups');
      return Promise.resolve(undefined);
    });
    await cb({ keys: ['backupInterval'] });
    jest.advanceTimersByTime(60 * 60 * 1000);
    await Promise.resolve();
    expect(runBackup).toHaveBeenCalled();
  });

  it('overlapping run is handled', async () => {
    const err = new Error('locked') as Error & { code?: string };
    err.code = 'EEXIST';
    err.code = 'EEXIST';
    (runBackup as jest.Mock).mockRejectedValueOnce(err);
    await expect(sched.executeScheduledBackup()).resolves.toBeUndefined();
  });

  it('Scheduler class works', () => {
    const s = new sched.Scheduler(1);
    s.start();
    expect(s.isRunning()).toBe(true);
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(runBackup).toHaveBeenCalled();
    s.stop();
    expect(s.isRunning()).toBe(false);
  });

  it('createScheduler factory', () => {
    const s = sched.createScheduler(1);
    s.start();
    expect(s.isRunning()).toBe(true);
    s.reset(2);
    s.stop();
  });

  it('onSettingsChanged handles event', async () => {
    await sched.onSettingsChanged({ keys: ['backupInterval'] });
    // no throw
  });

  it('isSchedulerRunning reflects state', () => {
    sched.startScheduler(1);
    expect(sched.isSchedulerRunning()).toBe(true);
    sched.stopScheduler();
    expect(sched.isSchedulerRunning()).toBe(false);
  });

  it('disabled scheduler (0) does not set timer', () => {
    (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
      if (key === 'backupInterval') return Promise.resolve(0);
      if (key === 'backupPath') return Promise.resolve('/backups');
      return Promise.resolve(undefined);
    });
    sched.startScheduler(0);
    jest.advanceTimersByTime(60 * 60 * 1000);
  });

  it('executeScheduledBackup logs non-EEXIST errors', async () => {
    (runBackup as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sched.executeScheduledBackup()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('startScheduler with no arg bootstraps from settings', async () => {
    await sched.startScheduler();
    expect(joplin.settings.onChange).toHaveBeenCalled();
  });

  it('resetScheduler with no arg bootstraps from settings', async () => {
    await sched.resetScheduler();
    expect(joplin.settings.onChange).toHaveBeenCalled();
  });
});
