import { formatMessage, logger, log } from '../src/logger';

describe('logger', () => {
  beforeEach(() => jest.clearAllMocks());

  it('formats messages with prefix and level', () => {
    expect(formatMessage('info', 'hello')).toBe('[IncrementalBackup] [INFO] hello');
  });

  it('calls console.info for info level', () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('test message', 42);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('calls console.error for error level', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('boom');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('calls console.debug for debug level', () => {
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    logger.debug('dbg');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('calls console.warn for warn level', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('warn');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('falls back to console.log for unknown level', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    log('verbose' as never, 'msg');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
