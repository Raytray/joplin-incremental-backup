/**
 * Step 0 smoke test — plugin entry point.
 *
 * Verifies that importing index.ts causes joplin.plugins.register to be called
 * with a valid registration object containing an async onStart handler.
 */

describe('Plugin entry point', () => {
  beforeEach(() => {
    // Isolate module registry so each test gets a fresh import
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('calls joplin.plugins.register on load', async () => {
    const { default: joplin } = await import('api');
    await import('../src/index');

    expect(joplin.plugins.register).toHaveBeenCalledTimes(1);
  });

  it('provides an async onStart handler', async () => {
    const { default: joplin } = await import('api');
    await import('../src/index');

    const [registration] = (joplin.plugins.register as jest.Mock).mock.calls[0];
    expect(typeof registration.onStart).toBe('function');

    // onStart must resolve without throwing
    await expect(registration.onStart()).resolves.toBeUndefined();
  });
});
