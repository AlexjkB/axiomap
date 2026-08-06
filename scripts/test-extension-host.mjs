#!/usr/bin/env node
/**
 * Run the extension in a real VS Code, against the **packaged** tree.
 *
 * Phase 8a's note: "The editor half is still unverified by anything. That a
 * `reveal` moves a cursor, that a lens draws above a function, that the watch
 * fires: all of it is unit-tested against shapes and none of it has run in an
 * extension host."
 *
 * `extensionDevelopmentPath` is `packages/vscode/.vsix` — the staged tree
 * `scripts/package-vsix.mjs` builds and `vsce` zips, not the workspace package.
 * So the editor loads the CommonJS bundle, the packaged manifest, the packaged
 * grammar and the packaged webview, and the suite exercises them over
 * `fixtures/defi`. A path that resolves only in this repo fails here.
 *
 * The workspace is a **copy** of the fixture in a temp directory, for the same
 * reason `verify-vsix.mjs` copies one: opening it in place would let the
 * extension reach this repo's `node_modules` by walking upwards, and would write
 * `.axiomap/` into a tracked fixture.
 *
 * Usage: node scripts/test-extension-host.mjs
 *
 * Note: this launches a real editor window. There is no `xvfb` here, so it
 * appears on the desktop for the length of the run.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const VSCODE_PKG = join(REPO_ROOT, 'packages/vscode');
const STAGE = join(VSCODE_PKG, '.vsix');
const OUT = join(VSCODE_PKG, 'dist-host');

if (!existsSync(join(STAGE, 'package.json'))) {
  console.error(
    'packages/vscode/.vsix is not staged.\n  Run: pnpm package:vsix',
  );
  process.exit(1);
}

// The suite runs in the host's CommonJS registry, exactly as the extension does.
// `vscode` is injected by the host; `mocha` is resolved from this repo, which is
// fine — it is test scaffolding and never inside the `.vsix`.
await build({
  entryPoints: [join(VSCODE_PKG, 'test-host/index.ts')],
  outfile: join(OUT, 'index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode', 'mocha'],
  logLevel: 'warning',
});

const workspace = mkdtempSync(join(tmpdir(), 'axiomap-host-'));
cpSync(join(REPO_ROOT, 'fixtures/defi'), join(workspace, 'defi'), { recursive: true });
rmSync(join(workspace, 'defi/.axiomap'), { recursive: true, force: true });

try {
  await runTests({
    extensionDevelopmentPath: STAGE,
    extensionTestsPath: join(OUT, 'index.cjs'),
    launchArgs: [
      join(workspace, 'defi'),
      // Any other extension in this machine's profile is noise at best and a
      // second Solidity CodeLens provider at worst.
      '--disable-extensions',
      '--disable-gpu',
      `--user-data-dir=${join(workspace, 'user-data')}`,
    ],
    // Where the theme dumps land. The suite runs from a bundle and has no
    // notion of this repo's layout; the runner does.
    extensionTestsEnv: { AXIOMAP_THEME_DUMP_DIR: join(REPO_ROOT, 'packages/webview/test/themes') },
  });
  console.log('\nThe extension host suite passed.');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
