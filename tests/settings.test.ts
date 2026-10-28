import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSettings,
  clampRetention,
  getSettings,
  isSchedulerEnabled,
  normalizeInterval,
  registerSettings,
  SETTING_KEYS,
  SETTING_SECTION_NAME,
  setLastBackup,
  setLastSnapshot,
  validateBackupPath,
} from '../src/settings';
import { mockState, resetMockJoplin } from '../src/__mocks__/joplin';
import { logger } from '../src/logger';

function registeredSettings(): Record<string, { public: boolean; value: unknown }> {
  return mockState.registeredSettings as Record<string, { public: boolean; value: unknown }>;
}

beforeEach(() => {
  resetMockJoplin();
});

describe('getSettings', () => {
  it('returns typed values from joplin.settings.value', async () => {
    mockState.values = {
      [SETTING_KEYS.backupPath]: '/tmp/backups',
      [SETTING_KEYS.backupRetention]: 3,
      [SETTING_KEYS.backupInterval]: 12,
      [SETTING_KEYS.onlyOnChange]: false,
      [SETTING_KEYS.lastBackup]: '2026-01-01T00:00:00.000Z',
      [SETTING_KEYS.lastSnapshot]: '20260101T000000',
    };

    await expect(getSettings()).resolves.toEqual({
      backupPath: '/tmp/backups',
      backupRetention: 3,
      backupInterval: 12,
      onlyOnChange: false,
      lastBackup: '2026-01-01T00:00:00.000Z',
      lastSnapshot: '20260101T000000',
      lastBackupResult: '',
      lastBackupResultJson: '',
      lastRunResult: '',
      lastBackupSummary: '',
      lastBackupDetails: '',
      lastBackupRun: '',
      lastBackupRunResult: '',
    });
  });

  it('throws when backupPath is empty', async () => {
    mockState.values = { [SETTING_KEYS.backupPath]: '   ' };
    await expect(getSettings()).rejects.toThrow(/Backup path/);
  });

  it('clamps retention to at least 1 and defaults on invalid input', async () => {
    mockState.values = {
      [SETTING_KEYS.backupPath]: '/tmp/backups',
      [SETTING_KEYS.backupRetention]: 0,
    };

    const settings = await getSettings();
    expect(settings.backupRetention).toBe(1);
    expect(clampRetention('not-a-number')).toBe(5);
  });
});

describe('scheduler interval', () => {
  it('is disabled when backupInterval is 0', () => {
    expect(isSchedulerEnabled(0)).toBe(false);
    expect(isSchedulerEnabled({ backupInterval: 0 })).toBe(false);
  });

  it('is enabled for a positive interval', () => {
    expect(isSchedulerEnabled(24)).toBe(true);
    expect(isSchedulerEnabled({ backupInterval: 1 })).toBe(true);
  });

  it('normalizes negative/invalid intervals', () => {
    expect(normalizeInterval(-5)).toBe(24);
    expect(normalizeInterval('nope')).toBe(24);
    expect(normalizeInterval(6)).toBe(6);
  });
});

describe('validateBackupPath', () => {
  it('throws on empty paths', () => {
    expect(() => validateBackupPath('', 'linux')).toThrow(/must not be empty/);
    expect(() => validateBackupPath('   ', 'linux')).toThrow(/must not be empty/);
  });

  it('warns on long Windows paths', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    validateBackupPath(`C:\\${'a'.repeat(200)}`, 'win32');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Windows/);
    warn.mockRestore();
  });

  it('does not warn for short Windows paths or on other platforms', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    validateBackupPath('C:\\backups', 'win32');
    validateBackupPath('/this/is/a/very/long/path/'.concat('a'.repeat(200)), 'linux');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('registerSettings', () => {
  it('registers the section and all settings with correct visibility', async () => {
    await registerSettings();

    expect(mockState.registeredSection?.name).toBe(SETTING_SECTION_NAME);

    const settings = registeredSettings();
    expect(settings[SETTING_KEYS.backupPath].public).toBe(true);
    expect(settings[SETTING_KEYS.backupRetention].public).toBe(true);
    expect(settings[SETTING_KEYS.backupInterval].public).toBe(true);
    expect(settings[SETTING_KEYS.onlyOnChange].public).toBe(true);
    expect(settings[SETTING_KEYS.lastBackup].public).toBe(false);
    expect(settings[SETTING_KEYS.lastSnapshot].public).toBe(false);
  });

  it('buildSettings exposes the documented defaults', () => {
    const settings = buildSettings();
    expect(settings[SETTING_KEYS.backupPath].value).toBe('');
    expect(settings[SETTING_KEYS.backupRetention].value).toBe(5);
    expect(settings[SETTING_KEYS.backupInterval].value).toBe(24);
    expect(settings[SETTING_KEYS.onlyOnChange].value).toBe(true);
  });
});

describe('hidden state setters', () => {
  it('persists the last backup and snapshot values', async () => {
    await setLastBackup('2026-01-01T00:00:00.000Z');
    await setLastSnapshot('20260101T000000');

    expect(mockState.values[SETTING_KEYS.lastBackup]).toBe('2026-01-01T00:00:00.000Z');
    expect(mockState.values[SETTING_KEYS.lastSnapshot]).toBe('20260101T000000');
  });
});
