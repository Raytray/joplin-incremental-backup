import joplin from 'api';
import { SettingItemType } from 'api/types';
import {
  registerSettings,
  getSettings,
  validateBackupPath,
  isSchedulerEnabled,
  setLastBackup,
  setLastSnapshot,
  SECTION_NAME,
  SettingKeys,
  WINDOWS_MAX_PATH_LIMIT,
} from '../src/settings';

describe('Settings module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('registerSettings', () => {
    it('registers setting section and all settings with Joplin', async () => {
      await registerSettings();

      expect(joplin.settings.registerSection).toHaveBeenCalledTimes(1);
      expect(joplin.settings.registerSection).toHaveBeenCalledWith(
        SECTION_NAME,
        expect.objectContaining({
          label: 'Incremental Backup',
          iconName: 'fas fa-archive',
        }),
      );

      expect(joplin.settings.registerSettings).toHaveBeenCalledTimes(1);
      const registeredSettings = (joplin.settings.registerSettings as jest.Mock).mock.calls[0][0];

      // Verify all 6 settings are registered
      expect(registeredSettings).toHaveProperty(SettingKeys.BackupPath);
      expect(registeredSettings[SettingKeys.BackupPath]).toEqual({
        value: '',
        type: SettingItemType.String,
        section: SECTION_NAME,
        public: true,
        label: 'Backup path',
        description: expect.any(String),
      });

      expect(registeredSettings).toHaveProperty(SettingKeys.BackupRetention);
      expect(registeredSettings[SettingKeys.BackupRetention]).toEqual(
        expect.objectContaining({
          value: 5,
          type: SettingItemType.Int,
          section: SECTION_NAME,
          public: true,
          minimum: 1,
        }),
      );

      expect(registeredSettings).toHaveProperty(SettingKeys.BackupInterval);
      expect(registeredSettings[SettingKeys.BackupInterval]).toEqual(
        expect.objectContaining({
          value: 24,
          type: SettingItemType.Int,
          section: SECTION_NAME,
          public: true,
          minimum: 0,
        }),
      );

      expect(registeredSettings).toHaveProperty(SettingKeys.OnlyOnChange);
      expect(registeredSettings[SettingKeys.OnlyOnChange]).toEqual(
        expect.objectContaining({
          value: true,
          type: SettingItemType.Bool,
          section: SECTION_NAME,
          public: true,
        }),
      );

      expect(registeredSettings).toHaveProperty(SettingKeys.LastBackup);
      expect(registeredSettings[SettingKeys.LastBackup]).toEqual(
        expect.objectContaining({
          value: '',
          type: SettingItemType.String,
          section: SECTION_NAME,
          public: false,
        }),
      );

      expect(registeredSettings).toHaveProperty(SettingKeys.LastSnapshot);
      expect(registeredSettings[SettingKeys.LastSnapshot]).toEqual(
        expect.objectContaining({
          value: '',
          type: SettingItemType.String,
          section: SECTION_NAME,
          public: false,
        }),
      );
    });
  });

  describe('getSettings', () => {
    it('returns correct typed values when settings are configured', async () => {
      (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
        switch (key) {
          case SettingKeys.BackupPath:
            return Promise.resolve('/home/user/joplin-backups');
          case SettingKeys.BackupRetention:
            return Promise.resolve(10);
          case SettingKeys.BackupInterval:
            return Promise.resolve(12);
          case SettingKeys.OnlyOnChange:
            return Promise.resolve(false);
          case SettingKeys.LastBackup:
            return Promise.resolve('2026-10-19T14:00:00.000Z');
          case SettingKeys.LastSnapshot:
            return Promise.resolve('20261019T140000');
          default:
            return Promise.resolve(undefined);
        }
      });

      const settings = await getSettings();

      expect(settings).toEqual({
        backupPath: '/home/user/joplin-backups',
        backupRetention: 10,
        backupInterval: 12,
        onlyOnChange: false,
        lastBackup: '2026-10-19T14:00:00.000Z',
        lastSnapshot: '20261019T140000',
      });
    });

    it('falls back to default values when optional/numeric settings are undefined', async () => {
      (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
        if (key === SettingKeys.BackupPath) {
          return Promise.resolve('/valid/path');
        }
        return Promise.resolve(undefined);
      });

      const settings = await getSettings();

      expect(settings.backupRetention).toBe(5);
      expect(settings.backupInterval).toBe(24);
      expect(settings.onlyOnChange).toBe(true);
      expect(settings.lastBackup).toBe('');
      expect(settings.lastSnapshot).toBe('');
    });

    it('throws descriptive error when backupPath is undefined or not a string', async () => {
      (joplin.settings.value as jest.Mock).mockResolvedValue(undefined);

      await expect(getSettings()).rejects.toThrow(
        'Backup path is empty. Please configure a valid backup directory in settings.',
      );
    });

    it('throws descriptive error when backupPath is empty', async () => {
      (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
        if (key === SettingKeys.BackupPath) {
          return Promise.resolve('');
        }
        return Promise.resolve(undefined);
      });

      await expect(getSettings()).rejects.toThrow(
        'Backup path is empty. Please configure a valid backup directory in settings.',
      );
    });

    it('throws descriptive error when backupPath contains only whitespace', async () => {
      (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
        if (key === SettingKeys.BackupPath) {
          return Promise.resolve('   \t\n  ');
        }
        return Promise.resolve(undefined);
      });

      await expect(getSettings()).rejects.toThrow(
        'Backup path is empty. Please configure a valid backup directory in settings.',
      );
    });
  });

  describe('Scheduler signal & backupInterval', () => {
    it('backupInterval = 0 correctly signals disabled scheduler', async () => {
      (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
        if (key === SettingKeys.BackupPath) return Promise.resolve('/backups');
        if (key === SettingKeys.BackupInterval) return Promise.resolve(0);
        return Promise.resolve(undefined);
      });

      const settings = await getSettings();

      expect(settings.backupInterval).toBe(0);
      expect(isSchedulerEnabled(settings)).toBe(false);
      expect(isSchedulerEnabled(settings.backupInterval)).toBe(false);
      expect(isSchedulerEnabled(0)).toBe(false);
    });

    it('backupInterval > 0 correctly signals enabled scheduler', async () => {
      (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
        if (key === SettingKeys.BackupPath) return Promise.resolve('/backups');
        if (key === SettingKeys.BackupInterval) return Promise.resolve(6);
        return Promise.resolve(undefined);
      });

      const settings = await getSettings();

      expect(settings.backupInterval).toBe(6);
      expect(isSchedulerEnabled(settings)).toBe(true);
      expect(isSchedulerEnabled(6)).toBe(true);
    });
  });

  describe('Path length validation on Windows', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('fires path length warning when path exceeds threshold on Windows', async () => {
      const longPath = 'C:\\' + 'a'.repeat(WINDOWS_MAX_PATH_LIMIT + 10);
      (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
        if (key === SettingKeys.BackupPath) return Promise.resolve(longPath);
        return Promise.resolve(undefined);
      });

      await getSettings('win32');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Backup path length'));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('exceeds 180 characters on Windows'),
      );
    });

    it('does not fire path length warning when path is within limit on Windows', async () => {
      const normalPath = 'C:\\backups\\joplin';
      (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
        if (key === SettingKeys.BackupPath) return Promise.resolve(normalPath);
        return Promise.resolve(undefined);
      });

      await getSettings('win32');

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not fire Windows path length warning on non-Windows platforms', async () => {
      const longPath = '/var/backups/' + 'a'.repeat(WINDOWS_MAX_PATH_LIMIT + 10);
      (joplin.settings.value as jest.Mock).mockImplementation((key: string) => {
        if (key === SettingKeys.BackupPath) return Promise.resolve(longPath);
        return Promise.resolve(undefined);
      });

      await getSettings('linux');

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('validateBackupPath directly throws on empty path and warns on long Windows path', () => {
      expect(() => validateBackupPath('')).toThrow();
      expect(() => validateBackupPath('   ')).toThrow();

      const longWinPath = 'C:\\' + 'x'.repeat(200);
      validateBackupPath(longWinPath, 'win32');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockClear();
      validateBackupPath(longWinPath, 'linux');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('Setting setters', () => {
    it('setLastBackup updates lastBackup setting', async () => {
      const timestamp = '2026-10-20T12:00:00.000Z';
      await setLastBackup(timestamp);

      expect(joplin.settings.setValue).toHaveBeenCalledTimes(1);
      expect(joplin.settings.setValue).toHaveBeenCalledWith(SettingKeys.LastBackup, timestamp);
    });

    it('setLastSnapshot updates lastSnapshot setting', async () => {
      const snapshotName = '20261020T120000';
      await setLastSnapshot(snapshotName);

      expect(joplin.settings.setValue).toHaveBeenCalledTimes(1);
      expect(joplin.settings.setValue).toHaveBeenCalledWith(SettingKeys.LastSnapshot, snapshotName);
    });
  });
});
