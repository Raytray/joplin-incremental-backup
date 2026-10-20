/**
 * Lightweight console logger with a consistent prefix and log levels.
 */

export const LOG_PREFIX = '[IncrementalBackup]';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function formatMessage(level: LogLevel, message: string): string {
  return `${LOG_PREFIX} [${level.toUpperCase()}] ${message}`;
}

export function log(level: LogLevel, message: string, ...args: unknown[]): void {
  const formatted = formatMessage(level, message);
  switch (level) {
    case 'debug':
      console.debug(formatted, ...args);
      break;
    case 'info':
      console.info(formatted, ...args);
      break;
    case 'warn':
      console.warn(formatted, ...args);
      break;
    case 'error':
      console.error(formatted, ...args);
      break;
    default:
      console.log(formatted, ...args);
  }
}

export const logger = {
  debug: (message: string, ...args: unknown[]) => log('debug', message, ...args),
  info: (message: string, ...args: unknown[]) => log('info', message, ...args),
  warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
  error: (message: string, ...args: unknown[]) => log('error', message, ...args),
};

export default logger;