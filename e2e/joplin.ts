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
import { createReadStream, createWriteStream, existsSync, realpathSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import pluginManifest from '../src/manifest.json';

export const REPO_ROOT = path.resolve(__dirname, '..');
export const PLUGIN_ID: string = pluginManifest.id;

/** Joplin's clipper server takes the first free port from 41184 upwards. */
const CLIPPER_PORTS = Array.from({ length: 10 }, (_, i) => 41184 + i);
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
/** The database counts as idle once no write transaction has been open for this long. */
const DB_IDLE_MS = 1_000;
const DB_IDLE_TIMEOUT_MS = 15_000;

export function joplinBinary(): string {
  const bin = process.env.JOPLIN_BIN ?? path.join(REPO_ROOT, '.cache/joplin/current/joplin');
  if (!existsSync(bin)) {
    throw new Error(
      `Joplin executable not found at ${bin}. Run scripts/fetch-joplin.sh or set JOPLIN_BIN.`,
    );
  }
  return bin;
}

const flagSupport = new Map<string, Promise<boolean>>();

/**
 * Whether this Joplin build knows a start-up flag. Joplin exits on flags it
 * does not recognise, and some (e.g. `--running-tests`, absent from 3.2) are
 * newer than the oldest supported version. The app's code ships uncompressed
 * in resources/app.asar, so the flag's name appears there iff it is parsed.
 */
export function joplinAcceptsFlag(bin: string, flag: string): Promise<boolean> {
  const asar = path.join(path.dirname(realpathSync(bin)), 'resources', 'app.asar');
  const key = `${asar}\0${flag}`;
  let result = flagSupport.get(key);
  if (!result) {
    result = containsBytes(asar, Buffer.from(flag));
    flagSupport.set(key, result);
  }
  return result;
}

/** Stream `file` looking for `needle`, keeping an overlap across chunk boundaries. */
function containsBytes(file: string, needle: Buffer): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    let tail = Buffer.alloc(0);
    stream.on('data', (chunk: string | Buffer) => {
      const window = Buffer.concat([tail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (window.includes(needle)) {
        stream.destroy();
        resolve(true);
        return;
      }
      tail = window.subarray(Math.max(0, window.length - needle.length + 1));
    });
    stream.on('end', () => resolve(false));
    stream.on('error', reject);
  });
}

export function pluginSettingKey(key: string): string {
  return `plugin-${PLUGIN_ID}.${key}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown from a `waitFor` check to stop waiting at once (e.g. the app died). */
export class WaitAborted extends Error {}

/** Busy timeout for profile-database connections: Joplin may hold a write lock. */
const DB_BUSY_TIMEOUT_MS = 5_000;

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
      if (error instanceof WaitAborted) throw error;
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
  /** Resolves once the app has exited and its launch log is flushed. */
  private exited: Promise<void> | null = null;
  private spawnError: Error | null = null;
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

  /** Where the plugin stages exports locally (`joplin.plugins.dataDir()`/staging). */
  get localStagingRoot(): string {
    return path.join(this.profileDir, 'plugin-data', PLUGIN_ID, 'staging');
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

    const bin = joplinBinary();
    const child = spawn(
      bin,
      [
        // The extracted AppImage's chrome-sandbox is not setuid, and CI
        // runners restrict unprivileged user namespaces.
        '--no-sandbox',
        '--disable-gpu',
        // Newer Joplin (e.g. 3.7) locks the profile and refuses to start it
        // again for a few seconds after a forced quit; this flag turns that
        // off. Older versions (e.g. 3.2) do not know the flag and use
        // Electron's single-instance lock, which the isolated HOME already
        // keeps apart from a Joplin the developer has open.
        ...((await joplinAcceptsFlag(bin, '--running-tests')) ? ['--running-tests'] : []),
        '--no-welcome',
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
    // Two writers share the log, so neither may end it; it is ended once
    // the child's stdio has closed.
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    this.child = child;
    this.spawnError = null;
    this.exited = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.child = null;
        this.port = null;
        log.end(() => resolve());
      };
      // 'close' follows 'exit' once stdout/stderr are drained. A failed
      // spawn (e.g. EACCES) emits 'error' and may never emit 'close'.
      child.once('close', finish);
      child.once('error', (error) => {
        this.spawnError = error;
        if (child.pid === undefined) finish();
      });
    });

    try {
      this.port = await waitFor(
        'the Joplin Data API to come up',
        async () => {
          if (this.spawnError) {
            throw new WaitAborted(`Could not start Joplin: ${this.spawnError.message}`);
          }
          if (!this.child) throw new WaitAborted(`Joplin exited during startup; see ${logPath}`);
          return this.findOwnClipperPort();
        },
        START_TIMEOUT_MS,
      );
    } catch (error) {
      try {
        await this.stop();
      } catch {
        // Report why startup failed, not why cleanup did.
      }
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
    if (!child) return;
    if (child.pid === undefined) {
      await this.exited;
      return;
    }
    const pid = child.pid;
    await this.waitForDatabaseIdle();
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

  /**
   * Wait until no write transaction has been open for DB_IDLE_MS. The Data
   * API can answer before its write commits (seen on 3.2.11), and SIGTERM
   * does not wait for it: the write is rolled back, leaving a hot journal.
   * In Joplin's journal mode, database.sqlite-journal exists only while a
   * write transaction is open. Gives up after DB_IDLE_TIMEOUT_MS, since a
   * busy app (e.g. indexing) is still better stopped than waited on forever.
   */
  private async waitForDatabaseIdle(): Promise<void> {
    const journal = `${this.databasePath}-journal`;
    const deadline = Date.now() + DB_IDLE_TIMEOUT_MS;
    let idleSince = Date.now();
    while (Date.now() < deadline) {
      if (existsSync(journal)) idleSince = Date.now();
      else if (Date.now() - idleSince >= DB_IDLE_MS) return;
      await sleep(50);
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
    const db = new DatabaseSync(this.databasePath, {
      readOnly: this.child !== null,
      timeout: DB_BUSY_TIMEOUT_MS,
    });
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
    const db = new DatabaseSync(this.databasePath, { timeout: DB_BUSY_TIMEOUT_MS });
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
