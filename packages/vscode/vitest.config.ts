import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `vscode` is not a package — it is injected by the extension host at runtime,
 * and nothing can `npm install` it. The alias points at a stub that carries the
 * *shapes* this package uses and no behaviour; see `test/vscode-stub.ts` for
 * what that buys and what it deliberately does not.
 */
export default defineConfig({
  resolve: {
    alias: {
      vscode: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'test',
        'vscode-stub.ts',
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
