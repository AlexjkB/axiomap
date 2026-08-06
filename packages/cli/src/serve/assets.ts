/**
 * Where the built webview lives.
 *
 * ### Why this is resolved rather than imported
 *
 * §5's permitted dependency graph is `cli → core`, and this file does not
 * change that: **no module of `@axiomap/webview` is imported here, and none can
 * be.** The CLI needs the package's *built output* — an `index.html` and its
 * assets — to hand a browser, which is a file-serving relationship rather than a
 * code one. The ESLint rule that enforces §5 still forbids every import of that
 * package from this one, and its test still asserts so.
 *
 * The package is a `dependencies` entry so that pnpm links it and Turborepo
 * builds it first. Resolution goes through its `package.json` because that is
 * the one path a package manager guarantees, whatever hoisting it did.
 *
 * ### When it is missing
 *
 * A source checkout that has not run `pnpm build` has no bundle, and the honest
 * answer is to say which command produces it rather than to serve a 404 that
 * looks like a broken UI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Set by the webview package as `WEB_DIST`; duplicated here, and asserted equal by a test. */
const WEB_DIST = 'dist/web';
/** The single-chunk build `--format html` inlines. `EXPORT_DIST` in the webview. */
const EXPORT_DIST = 'dist/export';

export class AssetsMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetsMissingError';
  }
}

function webviewRoot(what: string): string {
  const require = createRequire(import.meta.url);
  let packageJson: string;
  try {
    packageJson = require.resolve('@axiomap/webview/package.json');
  } catch {
    throw new AssetsMissingError(
      `The @axiomap/webview package is not installed beside this CLI, so there is no ${what}.\n` +
        'From a source checkout: pnpm install && pnpm build.',
    );
  }
  return path.dirname(packageJson);
}

/** The directory `vite build` wrote, or an error naming the command that writes it. */
export function webviewAssets(): string {
  const dist = path.join(webviewRoot('UI to serve'), WEB_DIST);
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new AssetsMissingError(
      `The webview bundle is not built: ${dist} has no index.html.\n` +
        'Run pnpm build (or pnpm --filter @axiomap/webview build) and try again.',
    );
  }
  return dist;
}

/**
 * The three files `--format html` inlines: one script, one stylesheet, and
 * elkjs's worker.
 *
 * The worker's name is content-hashed, so it is found rather than named. It is
 * read as *source* rather than served: the export turns it into a `Blob` URL,
 * since a single file has no `assets/` directory to load a worker out of. That
 * is the sense in which §7's Phase 9 says the export "redistributes" elkjs.
 */
export function exportBundle(): { script: string; style: string; elkWorker: string } {
  const dist = path.join(webviewRoot('UI to export'), EXPORT_DIST);
  const script = path.join(dist, 'export.js');
  const style = path.join(dist, 'export.css');

  if (!fs.existsSync(script) || !fs.existsSync(style)) {
    throw new AssetsMissingError(
      `The export bundle is not built: ${dist} has no export.js.\n` +
        'Run pnpm build (or pnpm --filter @axiomap/webview build) and try again.',
    );
  }

  const assets = path.join(dist, 'assets');
  const worker = fs.existsSync(assets)
    ? fs.readdirSync(assets).find((file) => file.startsWith('elk-worker') && file.endsWith('.js'))
    : undefined;
  if (worker === undefined) {
    throw new AssetsMissingError(
      `The export bundle has no ELK worker in ${assets}. Run pnpm build and try again.`,
    );
  }

  return {
    script: fs.readFileSync(script, 'utf8'),
    style: fs.readFileSync(style, 'utf8'),
    elkWorker: fs.readFileSync(path.join(assets, worker), 'utf8'),
  };
}
