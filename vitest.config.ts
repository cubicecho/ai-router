import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const resolve = createRequire(import.meta.url).resolve;

export default defineConfig({
  resolve: {
    alias: [
      // graphql ships no exports map: Vite follows `module` to index.mjs while Node follows
      // `main` to index.js, and the two copies fail each other's instanceof checks.
      { find: /^graphql$/, replacement: resolve('graphql') },
    ],
  },
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**'],
    // A test that forgets its throwaway db fails loudly instead of writing to a real one.
    env: { DATABASE_URL: '', DATA_DIR: '' },
    // Threads share one process, where a fork per file each loads its own copy of everything.
    pool: 'threads',
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          // Diffs the tables once per run, so no test file has to load drizzle-kit.
          globalSetup: ['./tests/global-setup.ts'],
          include: ['tests/**/*.test.ts'],
        },
      },
    ],
  },
});
