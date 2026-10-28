import type { Toast } from '../../api/types';

/**
 * Runtime stand-in for the generated `api/index.ts` used by unit tests. The
 * real module only declares a global `joplin` provided by the host, so tests
 * alias `api` to this file via `vitest.config.ts`.
 */
export interface MockJoplinState {
  values: Record<string, unknown>;
  registeredSection: { name: string; section: unknown } | null;
  registeredSettings: Record<string, unknown> | null;
  setValues: Array<{ key: string; value: unknown }>;
  onChangeHandlers: Array<(event: { keys: string[] }) => void>;
  executedCommands: Array<{ name: string; args: unknown[] }>;
  commandResults: Record<string, unknown>;
  /** Optional side effects per command name (e.g. writing export files). */
  commandHandlers: Record<string, (...args: unknown[]) => unknown>;
  /** Commands registered by the plugin (name → definition). */
  registeredCommands: Record<
    string,
    { name: string; label?: string; execute?: (...args: unknown[]) => unknown }
  >;
  /** Menus created by the plugin. */
  createdMenus: Array<{ id: string; label: string; items: unknown[]; location?: string }>;
  /** Messages shown via `views.dialogs.showMessageBox`. */
  messageBoxes: string[];
  /** Toasts shown via `views.dialogs.showToast`. */
  toasts: Toast[];
  showToastCalls: Toast[];
  toastMessages: string[];
  /** Canned items returned by `data.get`, keyed by resource name. */
  dataItems: Record<string, Array<Record<string, unknown>>>;
  /** When set, `data.get` rejects with this error (used for transient-failure tests). */
  dataError: Error | null;
  versionError: Error | null;
  dataPageLimit: number;
  /** The plugin script passed to `joplin.plugins.register()`. */
  pluginScript: { onStart?: () => Promise<void> } | null;
}

function createState(): MockJoplinState {
  return {
    values: {},
    registeredSection: null,
    registeredSettings: null,
    setValues: [],
    onChangeHandlers: [],
    executedCommands: [],
    commandResults: {},
    commandHandlers: {},
    registeredCommands: {},
    createdMenus: [],
    messageBoxes: [],
    toasts: [],
    showToastCalls: [],
    toastMessages: [],
    dataItems: {},
    dataError: null,
    versionError: null,
    dataPageLimit: 100,
    pluginScript: null,
  };
}

export const mockState: MockJoplinState = createState();

export function resetMockJoplin(): void {
  const fresh = createState();
  Object.assign(mockState, fresh);
}

const joplin = {
  settings: {
    async registerSection(name: string, section: unknown): Promise<void> {
      mockState.registeredSection = { name, section };
    },
    async registerSettings(settings: Record<string, unknown>): Promise<void> {
      mockState.registeredSettings = settings;
    },
    async value(key: string): Promise<unknown> {
      return mockState.values[key];
    },
    async values(keys: string[] | string): Promise<Record<string, unknown>> {
      const list = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of list) result[key] = mockState.values[key];
      return result;
    },
    async setValue(key: string, value: unknown): Promise<void> {
      mockState.values[key] = value;
      mockState.setValues.push({ key, value });
    },
    async onChange(handler: (event: { keys: string[] }) => void): Promise<void> {
      mockState.onChangeHandlers.push(handler);
    },
  },
  commands: {
    async execute(name: string, ...args: unknown[]): Promise<unknown> {
      mockState.executedCommands.push({ name, args });
      const handler = mockState.commandHandlers[name];
      if (handler) return handler(...args);
      return mockState.commandResults[name];
    },
    async register(command: {
      name: string;
      label?: string;
      execute?: (...args: unknown[]) => unknown;
    }): Promise<void> {
      mockState.registeredCommands[command.name] = command;
    },
  },
  views: {
    menus: {
      async create(id: string, label: string, items: unknown[], location?: string): Promise<void> {
        mockState.createdMenus.push({ id, label, items, location });
      },
      async addItems(_menu: string, _items: unknown[]): Promise<void> {},
    },
    dialogs: {
      async showMessageBox(message: string): Promise<number> {
        mockState.messageBoxes.push(message);
        return 0;
      },
      async showToast(toast: Toast): Promise<void> {
        mockState.toasts.push(toast);
        mockState.showToastCalls.push(toast);
        mockState.toastMessages.push(toast.message);
      },
    },
  },
  data: {
    async get(path: unknown, query?: unknown): Promise<unknown> {
      if (mockState.dataError) throw mockState.dataError;

      const resource = Array.isArray(path) ? String(path[0]) : String(path);
      const all = mockState.dataItems[resource] ?? [];
      const page = Number((query as { page?: unknown } | undefined)?.page ?? 1) || 1;
      const limit = mockState.dataPageLimit;
      const start = (page - 1) * limit;
      const items = all.slice(start, start + limit);
      return { items, has_more: start + items.length < all.length };
    },
  },
  plugins: {
    register(script: { onStart?: () => Promise<void> }): void {
      mockState.pluginScript = script;
    },
  },
  async versionInfo(): Promise<{
    version: string;
    profileVersion: number;
    syncVersion: number;
    platform: 'desktop';
  }> {
    if (mockState.versionError) throw mockState.versionError;
    return {
      version: '3.7.0',
      profileVersion: 1,
      syncVersion: 1,
      platform: 'desktop',
    };
  },
};

export default joplin;
