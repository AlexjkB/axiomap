#!/usr/bin/env node
/**
 * Run the **packaged** extension, out of a directory with no workspace above it.
 *
 * This is the test Phase 8b is actually about. A path that resolves in the
 * workspace and not in the `.vsix` fails as "the graph is empty" on a user's
 * machine and passes everything in CI, so the only honest check is to unpack the
 * artifact somewhere unrelated, cut it off from this repo's `node_modules`, and
 * make it parse real Solidity.
 *
 * Four things it proves, one per obstacle Phase 8a's notes named:
 *
 * 1. **Module format** — `require()` of `dist/extension.cjs` succeeds and yields
 *    an `activate`. An ESM entry, or a bundle with a stray top-level `import`,
 *    fails here rather than on install.
 * 2. **The grammar `.wasm`** — the packaged worker parses a contract and returns
 *    its declarations. Without the grammar it returns a file with nothing in it,
 *    which is exactly what "the graph is empty" looks like from the inside.
 * 3. **web-tree-sitter's own `.wasm`** — its glue finds it beside itself, or the
 *    parse above never starts.
 * 4. **The worker entry** — driven as a real `Worker`, which is the thing the
 *    parse pool does and the one that is *silently* slow when it is wrong.
 *
 * The fixture is copied to the temp directory too. Parsing `fixtures/minimal`
 * in place would let the packaged code reach this repo's tree by relative path,
 * which is the mistake being tested for.
 *
 * Usage: node scripts/verify-vsix.mjs [path/to.vsix]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { EXTENSION_NAME, VERSION } from './package-vsix.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** One contract with a bit of everything the parse has to see. */
const PROBE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IToken { function transfer(address to, uint256 amount) external returns (bool); }

contract Probe {
    IToken public token;
    uint256 private total;

    event Moved(address indexed to, uint256 amount);

    function move(address to, uint256 amount) external returns (bool) {
        total += amount;
        emit Moved(to, amount);
        return token.transfer(to, amount);
    }
}
`;

function fail(message) {
  console.error(`\nverify-vsix: ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`  ok  ${message}`);
}

const vsixArg = process.argv[2];
const vsix = vsixArg === undefined
  ? join(REPO_ROOT, 'dist', `${EXTENSION_NAME}-${VERSION}.vsix`)
  : resolve(vsixArg);

const work = mkdtempSync(join(tmpdir(), 'axiomap-vsix-'));
const extension = join(work, 'extension');

try {
  console.log(`Verifying ${vsix}\n  unpacked into ${work}\n`);
  execFileSync('unzip', ['-q', vsix, '-d', work], { stdio: 'inherit' });

  // ------------------------------------------------- 1. the entry is loadable
  //
  // `vscode` is injected by the extension host and is on no disk anywhere, so
  // the host's half is stubbed exactly as far as module load needs it. Placed
  // outside `extension/` so nothing else about the package's own resolution
  // changes.
  mkdirSync(join(work, 'node_modules/vscode'), { recursive: true });
  writeFileSync(
    join(work, 'node_modules/vscode/package.json'),
    JSON.stringify({ name: 'vscode', version: '0.0.0', main: 'index.js' }),
  );
  writeFileSync(
    join(work, 'node_modules/vscode/index.js'),
    // Shapes only, and only the ones touched at import time.
    'const noop = () => ({ dispose() {} });\n' +
      'class Emitter { get event() { return noop; } fire() {} dispose() {} }\n' +
      'module.exports = new Proxy({ EventEmitter: Emitter }, {\n' +
      '  get: (target, key) => key in target ? target[key] : new Proxy(function () {}, { get: () => noop, apply: () => noop }),\n' +
      '});\n',
  );

  const loaded = execFileSync(
    process.execPath,
    [
      '-e',
      'const m = require(process.argv[1]);' +
        'if (typeof m.activate !== "function") { console.error("no activate export"); process.exit(1); }' +
        'if (typeof m.deactivate !== "function") { console.error("no deactivate export"); process.exit(1); }' +
        'console.log("loaded");',
      join(extension, 'dist/extension.cjs'),
    ],
    { encoding: 'utf8', cwd: work },
  );
  if (loaded.trim() !== 'loaded') fail(`extension.cjs did not load: ${loaded}`);
  ok('dist/extension.cjs loads under require() and exports activate/deactivate');

  // ----------------------------------------- 2–4. the packaged engine parses
  const project = join(work, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src/Probe.sol'), PROBE);

  const parsed = await runPackagedWorker({
    entry: join(extension, 'dist/worker-entry.cjs'),
    root: project,
    files: ['src/Probe.sol'],
    grammarWasm: join(extension, 'wasm/tree-sitter-solidity.wasm'),
  });

  const unit = parsed.get('src/Probe.sol')?.unit;
  if (unit === undefined) fail('the packaged worker returned no result for src/Probe.sol');

  const contracts = unit.contracts.map((c) => c.name).sort();
  if (contracts.join(',') !== 'IToken,Probe') {
    fail(`the packaged worker parsed contracts [${contracts.join(', ')}], expected [IToken, Probe]`);
  }
  const probe = unit.contracts.find((c) => c.name === 'Probe');
  if (probe.functions.length !== 1 || probe.functions[0].name !== 'move') {
    fail('the packaged worker found no `move` function — the grammar loaded but the tree is wrong');
  }
  if (probe.stateVariables.length !== 2) {
    fail(`the packaged worker found ${String(probe.stateVariables.length)} state variables, expected 2`);
  }
  ok('the packaged worker parsed a real contract, in a Worker, outside this repo');
  ok('  → the grammar .wasm, web-tree-sitter’s .wasm and the worker entry all resolved');

  // -------------------------------------------- the webview, and the notices
  const manifest = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8'));
  if (manifest.main !== './dist/extension.cjs') fail(`manifest main is ${String(manifest.main)}`);
  if (manifest.type !== undefined) fail('manifest still declares "type" — the host requires CJS');
  ok(`manifest: ${manifest.publisher}.${manifest.name}@${manifest.version}, main ${manifest.main}`);

  const notices = readFileSync(join(extension, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  if (!notices.includes('elkjs')) fail('THIRD-PARTY-NOTICES.md does not mention elkjs (EPL-2.0)');
  ok('THIRD-PARTY-NOTICES.md ships with the package and covers elkjs');

  console.log('\nThe packaged extension works from inside the package.');
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** Drive `dist/worker-entry.cjs` the way `parse/workers.ts` does. */
function runPackagedWorker({ entry, root, files, grammarWasm }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(pathToFileURL(entry), {
      workerData: { root, parserId: 'treesitter', cacheDir: null, assets: { grammarWasm } },
    });
    let ready = false;
    const timer = setTimeout(() => {
      void worker.terminate();
      rejectPromise(new Error('the packaged worker did not answer within 30s'));
    }, 30_000);

    worker.on('message', (message) => {
      if (!ready) {
        ready = true;
        worker.postMessage({ files });
        return;
      }
      clearTimeout(timer);
      const decoded = new Map(JSON.parse(message.payload));
      void worker.terminate().then(() => {
        resolvePromise(decoded);
      });
    });
    worker.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}
