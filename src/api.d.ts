/**
 * Ambient type declarations for Joplin's plugin API.
 *
 * The `api` module is NOT a real npm package — Joplin injects it at runtime
 * inside the plugin sandbox. These declarations let TypeScript type-check plugin
 * source code during development without requiring the actual Joplin runtime.
 *
 * Jest tests redirect this module to src/__mocks__/joplin.ts via moduleNameMapper.
 *
 * Extend these interfaces as additional Joplin APIs are used in subsequent steps.
 */

declare module 'api' {
  export interface PluginRegistration {
    onStart: () => Promise<void>;
  }

  export interface JoplinPlugins {
    register(options: PluginRegistration): void;
  }

  export interface SettingsChangeEvent {
    keys: string[];
  }

  export interface SettingSection {
    label: string;
    iconName?: string;
    description?: string;
  }

  export interface SettingItem {
    value: unknown;
    type: unknown;
    public: boolean;
    label: string;
    description?: string;
    minimum?: number;
    maximum?: number;
    storage?: unknown;
    section?: string;
  }

  export interface JoplinSettings {
    registerSection(name: string, options: SettingSection): Promise<void>;
    registerSettings(settings: Record<string, SettingItem>): Promise<void>;
    value(key: string): Promise<unknown>;
    setValue(key: string, value: unknown): Promise<void>;
    onChange(handler: (event: SettingsChangeEvent) => Promise<void>): Promise<void>;
  }

  export interface CommandRegistration {
    name: string;
    label: string;
    execute: () => Promise<void>;
  }

  export interface JoplinCommands {
    register(options: CommandRegistration): Promise<void>;
    execute(name: string, ...args: unknown[]): Promise<unknown>;
  }

  export interface JoplinViewsMenuItems {
    create(
      id: string,
      commandName: string,
      location: unknown,
      options?: Record<string, unknown>,
    ): Promise<void>;
  }

  export interface JoplinViewsDialogs {
    showMessageBox(message: string): Promise<number>;
  }

  export interface JoplinViews {
    menuItems: JoplinViewsMenuItems;
    dialogs: JoplinViewsDialogs;
  }

  export interface DataQuery {
    fields?: string[];
    query?: Record<string, unknown>;
    page?: number;
  }

  export interface DataResponse<T = unknown> {
    items: T[];
    has_more: boolean;
  }

  export interface JoplinData {
    get<T = unknown>(path: string[], query?: DataQuery): Promise<DataResponse<T>>;
  }

  export interface Joplin {
    plugins: JoplinPlugins;
    settings: JoplinSettings;
    commands: JoplinCommands;
    views: JoplinViews;
    data: JoplinData;
    appVersion?(): Promise<string>;
    versionInfo(): Promise<{
      version: string;
      platform: string;
      profileVersion: number;
      syncVersion: number;
    }>;
  }

  const joplin: Joplin;
  export default joplin;
}

declare module 'api/types' {
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
}
