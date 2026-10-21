/**
 * Jest mock for Joplin's plugin API.
 *
 * Mapped to 'api' and 'api/types' via moduleNameMapper in jest.config.js.
 * All Joplin API methods are jest.fn() stubs. Tests configure return values
 * with mockResolvedValue / mockReturnValue as needed, and reset state with
 * jest.clearAllMocks() in beforeEach blocks.
 */

const joplin = {
  plugins: {
    register: jest.fn(),
  },
  settings: {
    registerSection: jest.fn().mockResolvedValue(undefined),
    registerSettings: jest.fn().mockResolvedValue(undefined),
    value: jest.fn().mockResolvedValue(undefined),
    setValue: jest.fn().mockResolvedValue(undefined),
    onChange: jest.fn().mockResolvedValue(undefined),
  },
  commands: {
    register: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue(undefined),
  },
  views: {
    menuItems: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    dialogs: {
      showMessageBox: jest.fn().mockResolvedValue(0),
    },
  },
  data: {
    get: jest.fn().mockResolvedValue({ items: [], has_more: false }),
  },
  appVersion: jest.fn().mockResolvedValue('2.14.0'),
  versionInfo: jest.fn().mockResolvedValue({
    version: '2.14.0',
    platform: 'desktop',
    profileVersion: 0,
    syncVersion: 0,
  }),
};

export default joplin;

// Re-export enums so tests can import from 'api' or 'api/types' interchangeably
export enum SettingItemType {
  Int = 1,
  String = 2,
  Bool = 3,
  Array = 4,
  Object = 5,
  Button = 6,
}

export enum SettingStorage {
  Database = 1,
  File = 2,
}

export enum MenuItemLocation {
  File = 'file',
  Edit = 'edit',
  View = 'view',
  Note = 'note',
  Tools = 'tools',
  Help = 'help',
  NoteListContextMenu = 'noteListContextMenu',
  EditorContextMenu = 'editorContextMenu',
  FolderContextMenu = 'folderContextMenu',
}
