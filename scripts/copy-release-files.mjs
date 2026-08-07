#!/usr/bin/env node
/**
 * Copies `LICENSE` and `THIRD-PARTY-NOTICES.md` from the repo root into a
 * publishable package before `npm pack`/`npm publish` picks it up.
 *
 * §7 Phase 9's 7e amendment: `npm i -g @axiomap/cli` puts elkjs (EPL-2.0) on a
 * user's disk as a consequence of installing an MIT package, the same way the
 * `.vsix` redistributes it — so the notice has to travel with the npm tarball
 * too, not just the extension. Run as each publishable package's `prepack`
 * lifecycle script rather than committed into the package directory, so there
 * is exactly one copy of each file to keep current (the same reason
 * `notices.mjs` generates rather than hand-maintains the notices themselves).
 *
 * Usage: node ../../scripts/copy-release-files.mjs   (from a package directory)
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PKG_DIR = process.cwd();

const files = ['LICENSE', 'THIRD-PARTY-NOTICES.md'];

for (const file of files) {
  const src = join(REPO_ROOT, file);
  if (!existsSync(src)) {
    console.error(`copy-release-files: missing ${file} at repo root — run \`pnpm notices\` first if it's THIRD-PARTY-NOTICES.md`);
    process.exit(1);
  }
  copyFileSync(src, join(PKG_DIR, file));
}
