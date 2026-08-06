/**
 * Where the engine's two non-JavaScript assets live, when the default answer is
 * wrong.
 *
 * Both defaults are relative to this module's own URL:
 *
 * - `parse/treesitter.ts` resolves the vendored grammar as
 *   `../../vendor/tree-sitter-solidity.wasm`, which is right from `dist/parse/`
 *   and right from `src/parse/`.
 * - `parse/workers.ts` resolves the pool's worker as `./worker-entry.js` beside
 *   itself, and falls back to inline parsing when that file is not there.
 *
 * A **bundler breaks both**, and a `.vsix` is a bundle: the grammar is data a
 * bundler will not follow, and the worker is an entry point that no longer sits
 * beside the code that names it. Phase 1's notes flagged this as Phase 8's
 * problem in as many words, and this file is the answer — a host that knows
 * where it put its own files says so once, at startup, and nothing below it
 * changes.
 *
 * ### Why an override and not a search
 *
 * A search would guess. The failure mode this seam exists to prevent is a path
 * that resolves in a workspace and not in a `.vsix` — which passes every test in
 * CI and reads as "the graph is empty" on a user's machine — and the way to
 * prevent it is for the packaged host to name the paths it packaged, so that a
 * wrong answer is wrong immediately and everywhere rather than only where
 * nobody is looking.
 *
 * ### Worker threads do not inherit this
 *
 * `configureRuntime` sets module state, and a worker thread is a second module
 * registry. The pool therefore ships the current assets through `workerData`
 * and the worker entry calls `configureRuntime` with them before it builds a
 * parser. Without that, a bundled extension would parse correctly on the main
 * thread and load no grammar in its workers.
 */

export interface RuntimeAssets {
  /** Absolute path to `tree-sitter-solidity.wasm`. */
  grammarWasm?: string;
  /** Absolute path to the parse pool's built worker entry. */
  workerEntry?: string;
}

let assets: RuntimeAssets = {};

/**
 * Point the engine at assets a host has placed somewhere of its own choosing.
 *
 * Called once, before anything parses. Fields left out keep their default;
 * calling it twice merges rather than replaces, so a host may name the grammar
 * without having an opinion about the worker.
 */
export function configureRuntime(next: RuntimeAssets): void {
  assets = { ...assets, ...next };
}

/** What a host configured, for the two call sites that need it. */
export function runtimeAssets(): Readonly<RuntimeAssets> {
  return assets;
}
