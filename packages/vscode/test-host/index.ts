/**
 * What `@vscode/test-electron` loads inside the editor: build a Mocha, add the
 * suite, run it, resolve or reject.
 *
 * Mocha rather than vitest because this file runs in the extension host's
 * CommonJS module registry, which is the same constraint the extension itself is
 * under (`scripts/package-vsix.mjs`) — vitest expects to own the process.
 */

import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 180_000 });
  // Bundled into this file by `scripts/test-extension-host.mjs`; the side effect
  // of importing it is the `suite()` registration.
  mocha.suite.emit('pre-require', globalThis, 'suite', mocha);

  return new Promise((resolve, reject) => {
    void import('./suite.js').then(() => {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${String(failures)} extension-host test(s) failed`));
        else resolve();
      });
    }, reject);
  });
}
