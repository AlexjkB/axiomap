/**
 * The two files that decide where a packaged extension's own files are.
 *
 * `assets.ts` finds the webview bundle; `runtime.ts` finds the parser's grammar
 * and the parse pool's worker. Both were at **0% coverage** at the Phase 8b
 * boundary audit, and both answer the one question this phase exists to get
 * right: a path that resolves in the workspace and not in the `.vsix` fails as
 * "the graph is empty" on a user's machine and passes everything in CI.
 *
 * `scripts/verify-vsix.mjs` proves the real artifact; this proves the *rules*,
 * including the branches a correct package never takes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configureRuntime, runtimeAssets } from '@axiomap/core';

import { BundleMissingError, MEDIA_DIR, webviewBundle } from '../src/assets.js';
import {
  GRAMMAR_WASM,
  WASM_DIR,
  WORKER_ENTRY,
  configureEngine,
  packagedAssets,
} from '../src/runtime.js';

const temporary: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-pkg-'));
  temporary.push(dir);
  return dir;
}

/** A `media/` laid out the way `scripts/package-vsix.mjs` stages it. */
function stageBundle(extension: string, worker = 'elk-worker.min-abc123.js'): void {
  const media = path.join(extension, MEDIA_DIR);
  fs.mkdirSync(path.join(media, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(media, 'vscode.js'), '// bundle');
  fs.writeFileSync(path.join(media, 'vscode.css'), '/* bundle */');
  fs.writeFileSync(path.join(media, 'assets', worker), 'self.onmessage = () => {};');
}

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the webview bundle, from the extension’s point of view', () => {
  it('prefers the packaged media/ over anything in a workspace', () => {
    const extension = scratch();
    stageBundle(extension);

    const bundle = webviewBundle(extension);
    expect(bundle.dir).toBe(path.join(extension, MEDIA_DIR));
    expect(bundle.script).toBe(path.join(extension, MEDIA_DIR, 'vscode.js'));
    // Read as source, not served: a webview document's origin is not the origin
    // its resources come from, so a worker started from an asset URL is refused
    // as cross-origin. The entry turns this string into a same-origin Blob.
    expect(bundle.elkWorker).toContain('self.onmessage');
  });

  it('finds elkjs’s worker by prefix, because vite content-hashes it', () => {
    const extension = scratch();
    stageBundle(extension, 'elk-worker.min-ZZZZZZZZ.js');
    expect(webviewBundle(extension).elkWorker).toContain('self.onmessage');
  });

  it('is incomplete rather than packaged when the worker is missing', () => {
    const extension = scratch();
    stageBundle(extension);
    fs.rmSync(path.join(extension, MEDIA_DIR, 'assets'), { recursive: true });

    // Falls through to the workspace lookup, which in this test run resolves to
    // the real built bundle — so what is asserted is that it did *not* return
    // the incomplete packaged one.
    let dir: string;
    try {
      dir = webviewBundle(extension).dir;
    } catch (error) {
      expect(error).toBeInstanceOf(BundleMissingError);
      return;
    }
    expect(dir).not.toBe(path.join(extension, MEDIA_DIR));
  });
});

describe('the engine’s assets, from the extension’s point of view', () => {
  it('names the grammar and the worker when the package has them', () => {
    const extension = scratch();
    fs.mkdirSync(path.join(extension, WASM_DIR), { recursive: true });
    fs.mkdirSync(path.join(extension, path.dirname(WORKER_ENTRY)), { recursive: true });
    fs.writeFileSync(path.join(extension, WASM_DIR, GRAMMAR_WASM), 'wasm');
    fs.writeFileSync(path.join(extension, WORKER_ENTRY), '// worker');

    expect(packagedAssets(extension)).toEqual({
      grammarWasm: path.join(extension, WASM_DIR, GRAMMAR_WASM),
      workerEntry: path.join(extension, WORKER_ENTRY),
    });
  });

  it('names nothing at all in a source checkout', () => {
    // F5 out of a clone: neither file exists, and core's own module-relative
    // defaults are the right answer. An override pointing at nothing would be
    // strictly worse — it replaces a relative guess with a confident absolute
    // one.
    expect(packagedAssets(scratch())).toEqual({});
  });

  it('names the grammar without the worker, which is the slow-not-broken case', () => {
    const extension = scratch();
    fs.mkdirSync(path.join(extension, WASM_DIR), { recursive: true });
    fs.writeFileSync(path.join(extension, WASM_DIR, GRAMMAR_WASM), 'wasm');

    const assets = packagedAssets(extension);
    expect(assets.grammarWasm).toBe(path.join(extension, WASM_DIR, GRAMMAR_WASM));
    // No worker means the parse pool parses inline: slower on a large project
    // and identical in what it produces, which is the failure mode to prefer.
    expect(assets.workerEntry).toBeUndefined();
  });

  it('configures core with what it found, and reports it', () => {
    const extension = scratch();
    fs.mkdirSync(path.join(extension, WASM_DIR), { recursive: true });
    fs.writeFileSync(path.join(extension, WASM_DIR, GRAMMAR_WASM), 'wasm');

    const configured = configureEngine(extension);
    expect(configured.grammarWasm).toBe(path.join(extension, WASM_DIR, GRAMMAR_WASM));
    expect(runtimeAssets().grammarWasm).toBe(configured.grammarWasm);

    // Put back, or every test after this one parses with a file full of the
    // word "wasm". `configureRuntime` merges rather than replaces, which is what
    // lets a host name one asset without an opinion about the other — and is
    // also why this cannot be undone by passing `{}`.
    configureRuntime({ grammarWasm: undefined });
    expect(runtimeAssets().grammarWasm).toBeUndefined();
  });

  it('asks about exactly the two paths, and nothing else', () => {
    const asked: string[] = [];
    packagedAssets('/extension', (file) => {
      asked.push(file);
      return false;
    });
    expect(asked).toEqual([
      path.join('/extension', WASM_DIR, GRAMMAR_WASM),
      path.join('/extension', WORKER_ENTRY),
    ]);
  });
});
