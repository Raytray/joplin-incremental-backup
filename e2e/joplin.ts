/**
 * Drives a real Joplin desktop app (Electron) for end-to-end tests.
 *
 * Each `JoplinInstance` owns a throwaway profile. The app is started with the
 * plugin loaded from this repository (`--dev-plugins`), and the Web Clipper
 * service (Joplin's Data API) is enabled so tests can create and edit notes.
 *
 * Plugin settings live in the profile's SQLite database, not in
 * `settings.json`, so they are read and written directly while the app is
 * stopped (and read, read-only, while it runs).
 */
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { createWriteStream, existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

export const REPO_ROOT = path.resolve(__dirname, '..');
export const PLUGIN_ID = 'io.github.raytray.joplin-incremental-backup';

/** Joplin's clipper server takes the first free port from 41184 upwards. */
const CLIPPER_PORTS = Array.from({ length: 10 }, (_, i) => 41184 + i);
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

export function joplinBinary(): string {
  const bin = process.env.JOPLIN_BIN ?? path.join(REPO_ROOT, '.cache/joplin/current/joplin');
  if (!existsSync(bin)) {
    throw new Error(
      `Joplin executable not found at ${bin}. Run scripts/fetch-joplin.sh or set JOPLIN_BIN.`,
    );
  }
  return bin;
}

export function pluginSettingKey(key: string): string {
  return `plugin-${PLUGIN_ID}.${key}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until it returns a non-undefined value. */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const reason = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}${reason}`);
}

export interface JoplinApiItem {
  id: string;
  [key: string]: unknown;
}

export class JoplinInstance {
  readonly profileDir: string;
  /** HOME for the app, so Electron's own data stays out of the real one. */
  readonly homeDir: string;
  readonly token = randomBytes(32).toString('hex');

  private child: ChildProcess | null = null;
  private exited: Promise<void> | null = null;
  private port: number | null = null;
  private launchCount = 0;

  constructor(readonly workDir: string) {
    this.profileDir = path.join(workDir, 'profile');
    this.homeDir = path.join(workDir, 'home');
  }

  /** stdout/stderr of the current (or most recent) launch. */
  get launchLogPath(): string {
    return path.join(this.workDir, `joplin-launch-${this.launchCount}.log`);
  }

  /** The plugin's log lines (`[IncrementalBackup] ...`) from the most recent launch. */
  async pluginLog(): Promise<string[]> {
    const text = await fs.readFile(this.launchLogPath, 'utf8');
    return text.split('\n').filter((line) => line.includes('[IncrementalBackup]'));
  }

  get databasePath(): string {
    return path.join(this.profileDir, 'database.sqlite');
  }

  /** Start the app and wait until the Data API answers with our token. */
  async start(): Promise<void> {
    if (this.child) throw new Error('Joplin is already running.');
    if (!process.env.DISPLAY) {
      throw new Error('No X display. Run `npm run test:e2e:headless` (needs xvfb).');
    }
    const pluginManifest = path.join(REPO_ROOT, 'dist', 'manifest.json');
    if (!existsSync(pluginManifest)) {
      throw new Error(`${pluginManifest} is missing. Build the plugin with \`npm run dist\`.`);
    }

    await fs.mkdir(this.profileDir, { recursive: true });
    await fs.mkdir(this.homeDir, { recursive: true });
    await this.writeFileSettings();

    this.launchCount += 1;
    const logPath = this.launchLogPath;
    const log = createWriteStream(logPath);

    const child = spawn(
      joplinBinary(),
      [
        // The extracted AppImage's chrome-sandbox is not setuid, and CI
        // runners restrict unprivileged user namespaces.
        '--no-sandbox',
        '--disable-gpu',
        // Disables the single-instance lock, so a Joplin the developer
        // already has open does not swallow this instance.
        '--running-tests',
        '--no-welcome',
        '--lang=en-GB',
        '--log-level',
        'debug',
        // Electron copies renderer console output (the plugin's logger) to
        // stderr, which ends up in the launch log.
        '--enable-logging',
        '--profile',
        this.profileDir,
        '--dev-plugins',
        REPO_ROOT,
      ],
      {
        env: this.childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so stop() can take Electron's helpers down too.
        detached: true,
      },
    );
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once('exit', () => {
        this.child = null;
        this.port = null;
        resolve();
      });
    });

    try {
      this.port = await waitFor(
        'the Joplin Data API to come up',
        async () => {
          if (!this.child) throw new Error(`Joplin exited during startup; see ${logPath}`);
          return this.findOwnClipperPort();
        },
        START_TIMEOUT_MS,
      );
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /**
   * Quit gracefully: SIGTERM to the main process only, which Electron turns
   * into app.quit(). Signalling the whole group would kill the renderer
   * (where Joplin's database lives) before it finishes its last writes.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    const pid = child.pid;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        // Already gone.
      }
    };

    child.kill('SIGTERM');
    const timedOut = await Promise.race([
      this.exited!.then(() => false),
      sleep(STOP_TIMEOUT_MS).then(() => true),
    ]);
    if (timedOut) {
      killGroup('SIGKILL');
      await this.exited;
      throw new Error(`Joplin did not quit within ${STOP_TIMEOUT_MS} ms and was killed.`);
    }

    // The renderer can outlive the main process by a moment while it
    // finishes writing; killing it then leaves a hot SQLite journal (a lost
    // write). Give the rest of the group time to exit on its own.
    const groupAlive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (groupAlive() && Date.now() < deadline) await sleep(100);
    if (groupAlive()) {
      killGroup('SIGKILL');
      throw new Error(`Joplin's helper processes did not exit within ${STOP_TIMEOUT_MS} ms.`);
    }
  }

  // -------------------------------------------------------------------------
  // Data API
  // -------------------------------------------------------------------------

  async api<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    route: string,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<T> {
    if (this.port === null) throw new Error('Joplin is not running.');
    const url = new URL(`http://127.0.0.1:${this.port}/${route}`);
    url.searchParams.set('token', this.token);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const init: RequestInit = { method };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }

    const response = await fetch(url, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} /${route} failed with ${response.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  createFolder(title: string): Promise<JoplinApiItem> {
    return this.api('POST', 'folders', { title });
  }

  createNote(props: { title: string; body: string; parent_id: string }): Promise<JoplinApiItem> {
    return this.api('POST', 'notes', props);
  }

  createTag(title: string): Promise<JoplinApiItem> {
    return this.api('POST', 'tags', { title });
  }

  tagNote(tagId: string, noteId: string): Promise<unknown> {
    return this.api('POST', `tags/${tagId}/notes`, { id: noteId });
  }

  createResource(filename: string, content: Buffer, mime: string): Promise<JoplinApiItem> {
    const form = new FormData();
    form.append('data', new Blob([content], { type: mime }), filename);
    form.append('props', JSON.stringify({ title: filename }));
    return this.api('POST', 'resources', form);
  }

  updateNote(id: string, props: Record<string, unknown>): Promise<JoplinApiItem> {
    return this.api('PUT', `notes/${id}`, props);
  }

  deleteNotePermanently(id: string): Promise<unknown> {
    return this.api('DELETE', `notes/${id}`, undefined, { permanent: '1' });
  }

  // -------------------------------------------------------------------------
  // Settings stored in the profile database
  // -------------------------------------------------------------------------

  /**
   * Read a setting. While the app runs the connection is read-only. Once it
   * has quit, it is read-write: Joplin's SIGTERM quit can interrupt a
   * write in progress, leaving a hot journal that only a writable connection
   * can roll back (as Joplin itself does on its next start).
   */
  readSetting(key: string): string | undefined {
    const db = new DatabaseSync(this.databasePath, { readOnly: this.child !== null });
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value: string } | undefined;
      return row?.value;
    } finally {
      db.close();
    }
  }

  readPluginSetting(key: string): string | undefined {
    return this.readSetting(pluginSettingKey(key));
  }

  /** Write plugin settings. Only while the app is stopped, or it would overwrite them. */
  writePluginSettings(values: Record<string, string | number | boolean>): void {
    if (this.child) throw new Error('Stop Joplin before editing its database.');
    const db = new DatabaseSync(this.databasePath);
    try {
      const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(values)) {
        const stored = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
        insert.run(pluginSettingKey(key), stored);
      }
    } finally {
      db.close();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The app's environment: an isolated HOME, and X11 only. Electron prefers
   * Wayland when WAYLAND_DISPLAY is set (WSLg sets it), which would put the
   * window on the real desktop even under xvfb-run.
   */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.homeDir,
      XDG_CONFIG_HOME: path.join(this.homeDir, '.config'),
      XDG_DATA_HOME: path.join(this.homeDir, '.local/share'),
      XDG_CACHE_HOME: path.join(this.homeDir, '.cache'),
    };
    delete env.WAYLAND_DISPLAY;
    return env;
  }

  /**
   * Settings that Joplin keeps in settings.json, which it reads before the
   * database exists: enable the Data API with a known token.
   */
  private async writeFileSettings(): Promise<void> {
    const file = path.join(this.profileDir, 'settings.json');
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // First launch.
    }
    const next = { ...current, 'clipperServer.autoStart': true, 'api.token': this.token };
    await fs.writeFile(file, JSON.stringify(next, null, 2));
  }

  /**
   * The clipper port of *this* instance. Another Joplin may already own
   * 41184, so a port only counts once it accepts our token.
   */
  private async findOwnClipperPort(): Promise<number | undefined> {
    for (const port of CLIPPER_PORTS) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/folders?limit=1&token=${this.token}`,
          { signal: AbortSignal.timeout(2_000) },
        );
        if (response.ok) return port;
      } catch {
        // Nothing listening yet.
      }
    }
    return undefined;
  }
}
