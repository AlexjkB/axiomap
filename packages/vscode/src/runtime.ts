/**
 * Where the *engine's* two non-JavaScript assets live inside a packaged
 * extension.
 *
 * `assets.ts` is the same question asked about the webview bundle; this is the
 * question asked about the parser. They are separate files because they are
 * answered by separate build steps and fail in separate ways: a missing webview
 * bundle is a blank panel, and a missing grammar is a graph that cannot be
 * built at all.
 *
 * ### The failure this exists to prevent
 *
 * `@axiomap/core` resolves the grammar `.wasm` and the parse pool's worker
 * relative to its own module URL, which is correct from `dist/` and from `src/`
 * and wrong from inside a bundle. A `.vsix` is a bundle. A path that resolves in
 * a workspace and not in the package fails as "the graph is empty" on a user's
 * machine and passes everything in CI, so `packagedAssets` names only paths it
 * has **checked exist**, and `configureEngine` returns what it configured so a
 * caller — and a test — can see which of the two answers it got.
 *
 * ### Both are optional, and they degrade differently
 *
 * - **No worker entry** is the good failure: `parse/workers.ts` falls back to
 *   inline parsing, so the extension is slower on a large project and correct
 *   everywhere. This is the state a source checkout is in under F5, where the
 *   default beside `core/dist/parse/` is found anyway.
 * - **No grammar** is not survivable, and there is nothing useful to do about it
 *   here: leaving it unconfigured lets core's default answer, which is right in
 *   a source checkout and the only remaining candidate in a packaged one.
 */

import fs from 'node:fs';
import path from 'node:path';

import { configureRuntime, type RuntimeAssets } from '@axiomap/core';

/** Where `scripts/package-vsix.mjs` puts each asset inside the extension. */
export const WASM_DIR = 'wasm';
export const GRAMMAR_WASM = 'tree-sitter-solidity.wasm';
export const WORKER_ENTRY = path.join('dist', 'worker-entry.cjs');

/**
 * The packaged assets that are actually there.
 *
 * Absent keys mean "core's default is the better answer", never "" or a path
 * pointing at nothing — an override that does not exist is strictly worse than
 * no override, because it replaces a wrong-but-relative guess with a
 * confidently wrong absolute one.
 */
export function packagedAssets(
  extensionPath: string,
  exists: (file: string) => boolean = fs.existsSync,
): RuntimeAssets {
  const assets: RuntimeAssets = {};

  const grammar = path.join(extensionPath, WASM_DIR, GRAMMAR_WASM);
  if (exists(grammar)) assets.grammarWasm = grammar;

  const worker = path.join(extensionPath, WORKER_ENTRY);
  if (exists(worker)) assets.workerEntry = worker;

  return assets;
}

/** Point core at them, once, before anything parses. Returns what it set. */
export function configureEngine(
  extensionPath: string,
  exists?: (file: string) => boolean,
): RuntimeAssets {
  const assets = packagedAssets(extensionPath, exists);
  configureRuntime(assets);
  return assets;
}
