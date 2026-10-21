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
  };
}

export const mockState: MockJoplinState = createState();

export function resetMockJoplin(): void {
  mockState.values = {};
  mockState.registeredSection = null;
  mockState.registeredSettings = null;
  mockState.setValues = [];
  mockState.onChangeHandlers = [];
  mockState.executedCommands = [];
  mockState.commandResults = {};
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
      return mockState.commandResults[name];
    },
    async register(_command: unknown): Promise<void> {},
  },
  views: {
    menus: {
      async create(_name: string): Promise<string> {
        return 'menu';
      },
      async addItems(_menu: string, _items: unknown[]): Promise<void> {},
    },
    dialogs: {
      async showMessageBox(_message: string): Promise<number> {
        return 0;
      },
    },
  },
  data: {
    async get(_path: unknown, _query?: unknown): Promise<unknown> {
      return { items: [], has_more: false };
    },
  },
  plugins: {
    register(_options: unknown): void {},
  },
  async versionInfo(): Promise<{
    version: string;
    profileVersion: number;
    syncVersion: number;
    platform: 'desktop';
  }> {
    return {
      version: '3.7.0',
      profileVersion: 1,
      syncVersion: 1,
      platform: 'desktop',
    };
  },
};

export default joplin;
