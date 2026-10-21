import path from 'path';
import { defineConfig } from 'vitest/config';

// `api` resolves to the generated Joplin API typings for type-checking, but at
// runtime tests need a working (mock) implementation. `api/types` stays mapped
// to the real enum values so runtime constants are correct.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^api$/, replacement: path.resolve(process.cwd(), 'src/__mocks__/joplin.ts') },
      { find: /^api\/types$/, replacement: path.resolve(process.cwd(), 'api/types.ts') },
    ],
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/platform.ts',
        'src/settings.ts',
        'src/manifest.ts',
        'src/dedup.ts',
        'src/retention.ts',
      ],
      exclude: ['src/__mocks__/**'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 75,
      },
    },
  },
});
