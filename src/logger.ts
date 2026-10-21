const PREFIX = '[IncrementalBackup]';

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

function write(method: 'info' | 'warn' | 'error' | 'debug', args: unknown[]): void {
  // eslint-disable-next-line no-console
  console[method](PREFIX, ...args);
}

export const logger: Logger = {
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
  debug: (...args) => write('debug', args),
};

export default logger;
