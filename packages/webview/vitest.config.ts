import { defineConfig } from 'vitest/config';

/**
 * `jsx: 'automatic'` matches `tsconfig.ui.json`'s `react-jsx`: the components
 * under test do not import React, because the bundler does not need them to.
 * The default here is the classic runtime, which fails at the first element.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
