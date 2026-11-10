import { describe, expect, it, vi } from 'vitest';

// The e2e suites run outside Joplin, where the plugin API (`api`) does not
// exist, and import these modules directly.
vi.mock('api', () => {
  throw new Error('the e2e helpers must not load the Joplin plugin API');
});

describe('modules the e2e suites import', () => {
  it('load without the Joplin plugin API', async () => {
    await expect(import('../src/snapshots')).resolves.toHaveProperty('LOCK_FILENAME');
    await expect(import('../src/retention')).resolves.toHaveProperty('listSnapshots');
  });
});
