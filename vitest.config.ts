import { defineConfig } from 'vitest/config';

/**
 * Repo-level tests — invariants that span packages and therefore belong to no
 * single one. Package tests live in each package's own test directory and run
 * under turbo.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
