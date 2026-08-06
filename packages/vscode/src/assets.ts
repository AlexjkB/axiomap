/**
 * Where the built webview lives, from the extension's point of view.
 *
 * Two places, and which one exists tells you how the extension is running:
 *
 * - **`<extension>/media/`** — a packaged `.vsix`, where the bundle was copied
 *   in at package time. A published extension has no workspace beside it.
 * - **the `@axiomap/webview` package** — a source checkout, where the bundle is
 *   whatever `pnpm build` last wrote. Resolved through the package's
 *   `package.json`, which is the one path a package manager guarantees.
 *
 * `media/` is checked first so that a packaged extension never accidentally
 * loads a stale bundle from a workspace that happens to be open.
 *
 * ### No import, here either
 *
 * §5 allows `vscode → webview`, and the extension *does* import that package —
 * for the protocol types and the bridge shape. What it does not do is import the
 * bundle: the UI is files handed to a webview, exactly as `axiomap serve` hands
 * them to a browser. The relationship is file-serving in both hosts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Set by the webview package as `VSCODE_DIST`; asserted equal by a test. */
const VSCODE_DIST = 'dist/vscode';
/** Where the packaging step copies that directory inside the extension. */
export const MEDIA_DIR = 'media';

export class BundleMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleMissingError';
  }
}

export interface WebviewBundle {
  /** Directory the webview may load resources from. */
  dir: string;
  /** The single chunk (`vite.vscode.config.ts`). */
  script: string;
  style: string;
  /**
   * elkjs's worker, as source.
   *
   * Read rather than served, and handed to the page as a string, because a
   * webview document's origin is not the origin its resources come from and a
   * cross-origin worker script is refused. The entry turns it into a `Blob`.
   * This is the sense in which §7's Phase 9 says the `.vsix` "redistributes"
   * elkjs — the notices file it asks for covers exactly this.
   */
  elkWorker: string;
}

function bundleIn(dir: string): WebviewBundle | null {
  const script = path.join(dir, 'vscode.js');
  const style = path.join(dir, 'vscode.css');
  if (!fs.existsSync(script) || !fs.existsSync(style)) return null;

  const assets = path.join(dir, 'assets');
  // Content-hashed, so it is found rather than named.
  const worker = fs.existsSync(assets)
    ? fs.readdirSync(assets).find((file) => file.startsWith('elk-worker') && file.endsWith('.js'))
    : undefined;
  if (worker === undefined) return null;

  return {
    dir,
    script,
    style,
    elkWorker: fs.readFileSync(path.join(assets, worker), 'utf8'),
  };
}

/**
 * The bundle, or an error naming the command that produces it.
 *
 * A missing bundle in a source checkout is a normal state — somebody cloned and
 * pressed F5 — and the useful answer is `pnpm build`, not a blank panel.
 */
export function webviewBundle(extensionPath: string): WebviewBundle {
  const packaged = bundleIn(path.join(extensionPath, MEDIA_DIR));
  if (packaged !== null) return packaged;

  let packageJson: string;
  try {
    packageJson = createRequire(import.meta.url).resolve('@axiomap/webview/package.json');
  } catch {
    throw new BundleMissingError(
      'The Axiomap webview bundle is not in this extension and @axiomap/webview is not ' +
        'installed beside it, so there is no UI to show.',
    );
  }

  const workspace = bundleIn(path.join(path.dirname(packageJson), VSCODE_DIST));
  if (workspace === null) {
    throw new BundleMissingError(
      `The Axiomap webview bundle is not built: ${path.join(path.dirname(packageJson), VSCODE_DIST)} ` +
        'is missing or incomplete.\nRun pnpm build (or pnpm --filter @axiomap/webview build) and try again.',
    );
  }
  return workspace;
}
