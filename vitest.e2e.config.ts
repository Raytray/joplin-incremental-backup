import { defineConfig } from 'vitest/config';

// End-to-end tests against a real Joplin desktop app (see e2e/joplin.ts).
// Unlike vitest.config.ts, nothing is aliased to mocks.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.test.ts'],
    // One Joplin at a time; each launch takes tens of seconds.
    fileParallelism: false,
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 2 * 60 * 1000,
  },
});
