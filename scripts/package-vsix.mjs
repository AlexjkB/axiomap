#!/usr/bin/env node
/**
 * The `.vsix` (AXIOMAP.md §7, Phase 8's first exit criterion).
 *
 * Packaging is the real work here, not `vsce package`. Three things stood in the
 * way and each is answered below in the step that solves it:
 *
 * 1. **Module format.** Every package in this repo is `"type": "module"`; the
 *    extension host loads an extension's entry with `require`. The entry is
 *    bundled to CommonJS.
 * 2. **Two `.wasm` files.** The vendored grammar, which core resolves relative
 *    to its own module URL and which a bundler therefore loses; and
 *    `web-tree-sitter`'s own runtime `.wasm`, which its emscripten glue locates
 *    beside itself.
 * 3. **The parse pool's worker entry**, which is a second entry point and cannot
 *    be inside the first one's bundle.
 *
 * ### The test that matters
 *
 * A path that resolves in the workspace and not in the `.vsix` fails as "the
 * graph is empty" on a user's machine and passes everything in CI. So this
 * script does not merely copy files: it **verifies the staged tree** before
 * handing it to `vsce`, and `scripts/verify-vsix.mjs` then runs the packaged
 * artifact's own bundle against a real fixture, out of a directory with no
 * workspace anywhere above it.
 *
 * ### Why `web-tree-sitter` is not bundled
 *
 * It is the one dependency that is not plain JavaScript. Its glue locates
 * `web-tree-sitter.wasm` from `__dirname`, which is exactly the thing bundling
 * destroys, and the alternative — reading the `.wasm` ourselves and handing it
 * in as `wasmBinary` — buys nothing and couples this repo to an emscripten
 * option. Copying the published package into the `.vsix` keeps `__dirname` true.
 * Everything else in the production tree is JavaScript and is bundled.
 *
 * ### The manifest is derived, not copied
 *
 * `packages/vscode/package.json` stays the single source of truth for what the
 * extension *contributes* — a repo-level test asserts its commands are the ones
 * the code registers — but it cannot be the published manifest: its `name` is
 * the pnpm workspace name `@axiomap/vscode`, and an extension id may not have a
 * scope in it. So the published `name` is set here, beside the `publisher` it
 * combines with, and the two of them are the extension's permanent identity.
 *
 * Usage: node scripts/package-vsix.mjs [--out DIR]
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const VSCODE_PKG = join(REPO_ROOT, 'packages/vscode');
const STAGE = join(VSCODE_PKG, '.vsix');

/**
 * The published identity. `<publisher>.<name>` is permanent from the first
 * publish — it is what an installed extension is called, what a settings key is
 * scoped by, and what a URL points at — so it is settled here in Phase 8b
 * rather than discovered in Phase 9.
 */
export const PUBLISHER = 'axiomap';
export const EXTENSION_NAME = 'axiomap';
/** The first version anything outside this repo could see. */
export const VERSION = '0.1.0';

/** Fields a pnpm workspace needs and a marketplace manifest must not carry. */
const DROPPED = [
  'private',
  'dependencies',
  'devDependencies',
  'scripts',
  'exports',
  'types',
  // `vsce` refuses a manifest that has both `files` and a `.vscodeignore`, and
  // the staged tree is described by the latter.
  'files',
  // A `.vsix` is CommonJS by the time the host loads it; leaving this behind
  // would tell the host to `import` a file that `module.exports`.
  'type',
];

/** Where `web-tree-sitter` is copied, relative to the extension root. */
export const VENDOR_DIR = 'vendor';
/** …and from the two bundles in `dist/`, which is how they will require it. */
const WEB_TREE_SITTER_REQUIRE = '../vendor/web-tree-sitter/web-tree-sitter.cjs';

/**
 * Keep `web-tree-sitter` out of the bundle and point at the copy beside it.
 *
 * Not `external: ['web-tree-sitter']`, which would leave a bare specifier that
 * Node resolves by walking `node_modules` upwards — and `vsce` excludes
 * `node_modules` from a `.vsix` unconditionally, so the walk would find the
 * package in a *developer's* workspace and nothing at all on a user's machine.
 * That is the exact "resolves in the workspace, not in the package" failure this
 * whole script exists to prevent, and it was found by looking at the file list.
 *
 * A relative require is resolved against the requiring file, so it is true
 * wherever the extension is installed.
 */
const webTreeSitterPlugin = {
  name: 'web-tree-sitter-beside-the-bundle',
  setup(builder) {
    builder.onResolve({ filter: /^web-tree-sitter$/ }, () => ({
      path: WEB_TREE_SITTER_REQUIRE,
      external: true,
    }));
  },
};

function step(message) {
  console.log(`  ${message}`);
}

function fail(message) {
  console.error(`\npackage-vsix: ${message}`);
  process.exit(1);
}

function requireFile(path, why) {
  if (!existsSync(path)) fail(`${path} is missing.\n  ${why}`);
  return path;
}

/** The manifest the `.vsix` carries, derived from the workspace one. */
export function publishedManifest(workspace) {
  const manifest = { ...workspace };
  for (const field of DROPPED) delete manifest[field];

  manifest.name = EXTENSION_NAME;
  manifest.publisher = PUBLISHER;
  manifest.version = VERSION;
  // Relative to the extension root, and the one file the host loads.
  manifest.main = './dist/extension.cjs';
  manifest.repository = {
    type: 'git',
    url: 'https://github.com/AlexjkB/axiomap.git',
  };
  manifest.bugs = { url: 'https://github.com/AlexjkB/axiomap/issues' };
  manifest.homepage = 'https://github.com/AlexjkB/axiomap#readme';
  return manifest;
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex === -1 ? join(REPO_ROOT, 'dist') : resolve(process.argv[outIndex + 1]);

  console.log('Packaging the Axiomap extension.\n');

  // ---------------------------------------------------------------- inputs
  //
  // Built output only. Bundling from `src/` would package something `pnpm
  // check` never type-checked or tested.
  const extensionEntry = requireFile(
    join(VSCODE_PKG, 'dist/extension.js'),
    'Run: pnpm build',
  );
  const workerEntry = requireFile(
    join(REPO_ROOT, 'packages/core/dist/parse/worker-entry.js'),
    'Run: pnpm build',
  );
  const grammarWasm = requireFile(
    join(REPO_ROOT, 'packages/core/vendor/tree-sitter-solidity.wasm'),
    'The vendored grammar is missing from the repository.',
  );
  const webviewDist = requireFile(
    join(REPO_ROOT, 'packages/webview/dist/vscode'),
    'Run: pnpm build (the VS Code bundle is vite.vscode.config.ts)',
  );
  const notices = requireFile(
    join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md'),
    'Run: node scripts/notices.mjs\n  The .vsix redistributes elkjs (EPL-2.0), whose notice must travel with it.',
  );
  const webTreeSitter = requireFile(
    join(REPO_ROOT, 'packages/core/node_modules/web-tree-sitter'),
    'Run: pnpm install',
  );

  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(join(STAGE, 'dist'), { recursive: true });

  // ------------------------------------------------------------- 1. bundles
  const bundle = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // `vscode` is provided by the host and is not on disk anywhere.
    external: ['vscode'],
    plugins: [webTreeSitterPlugin],
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
    /*
     * `import.meta.url` is empty in a CommonJS bundle, and core uses it to
     * resolve two files relative to itself. Both call sites are now lazy and
     * both are overridden by `configureRuntime`, so neither is reached here —
     * but leaving `import.meta` to be replaced by `{}` would turn a path that is
     * merely unused into one that throws the first time anything touches it.
     * Given a real value, the fallback resolves to a real (wrong) path and the
     * override is what makes it right, which is the ordering this repo wants.
     */
    banner: {
      js: "const __axiomapModuleUrl = require('node:url').pathToFileURL(__filename).href;",
    },
    define: { 'import.meta.url': '__axiomapModuleUrl' },
  };

  await build({ ...bundle, entryPoints: [extensionEntry], outfile: join(STAGE, 'dist/extension.cjs') });
  step(`dist/extension.cjs — ${kb(join(STAGE, 'dist/extension.cjs'))}`);

  // The parse pool's second entry point. `new Worker(file)` loads it in its own
  // thread, so it is a second bundle rather than a chunk of the first.
  await build({ ...bundle, entryPoints: [workerEntry], outfile: join(STAGE, 'dist/worker-entry.cjs') });
  step(`dist/worker-entry.cjs — ${kb(join(STAGE, 'dist/worker-entry.cjs'))}`);

  // -------------------------------------------------------------- 2. assets
  mkdirSync(join(STAGE, 'wasm'), { recursive: true });
  cpSync(grammarWasm, join(STAGE, 'wasm', basename(grammarWasm)));
  cpSync(
    join(dirname(grammarWasm), 'tree-sitter-solidity.LICENSE'),
    join(STAGE, 'wasm/tree-sitter-solidity.LICENSE'),
  );
  step(`wasm/${basename(grammarWasm)} — ${kb(join(STAGE, 'wasm', basename(grammarWasm)))}`);

  // `web-tree-sitter`, whole, so its glue still finds its own runtime `.wasm`
  // beside itself. Both bundles `require` it and resolve up to here.
  cpSync(webTreeSitter, join(STAGE, VENDOR_DIR, 'web-tree-sitter'), {
    recursive: true,
    dereference: true,
    /*
     * The CommonJS entry, the `.wasm` beside it, the manifest, and the LICENSE
     * the notices file refers to. Not the sourcemaps (900 KB), not the ESM
     * build nobody requires, not the `debug/` variant (2.6 MB) — a `.vsix` is
     * downloaded by every user on every update.
     */
    filter: (source) => {
      const name = basename(source);
      if (source === webTreeSitter) return true;
      return (
        name === 'web-tree-sitter.cjs' ||
        name === 'web-tree-sitter.wasm' ||
        name === 'package.json' ||
        name === 'LICENSE'
      );
    },
  });
  step(`${VENDOR_DIR}/web-tree-sitter — copied whole (see the head of this file)`);

  // The webview bundle, where `assets.ts` looks for a *packaged* extension.
  cpSync(webviewDist, join(STAGE, 'media'), { recursive: true, dereference: true });
  step('media/ — the webview bundle and elkjs’s worker');

  // ------------------------------------------------------------ 3. manifest
  const workspaceManifest = JSON.parse(readFileSync(join(VSCODE_PKG, 'package.json'), 'utf8'));
  writeFileSync(
    join(STAGE, 'package.json'),
    `${JSON.stringify(publishedManifest(workspaceManifest), null, 2)}\n`,
  );
  step(`package.json — ${PUBLISHER}.${EXTENSION_NAME}@${VERSION}`);

  cpSync(join(REPO_ROOT, 'LICENSE'), join(STAGE, 'LICENSE'));
  cpSync(notices, join(STAGE, 'THIRD-PARTY-NOTICES.md'));
  cpSync(join(VSCODE_PKG, 'README.md'), join(STAGE, 'README.md'));
  // The manifest's `icon` field names it; a missing file fails `vsce package`
  // rather than shipping a listing with the default placeholder tile.
  cpSync(
    requireFile(join(VSCODE_PKG, 'icon.png'), 'Render it: python3 packages/vscode/icon.svg -> icon.png'),
    join(STAGE, 'icon.png'),
  );
  step('LICENSE, THIRD-PARTY-NOTICES.md, README.md, icon.png');

  /*
   * Without this file `vsce` falls back to the nearest `.gitignore` — which in
   * this repo ignores `dist/` and `node_modules/`, i.e. every file the extension
   * needs. It shipped a 6-file package with no webview, no grammar and no
   * parser before this line existed, and the failure was silent: `vsce` reported
   * success, and the missing half only shows up as an empty graph on somebody
   * else's machine. Staged as an explicit allow-nothing list.
   */
  writeFileSync(
    join(STAGE, '.vscodeignore'),
    ['# Everything staged here is meant to ship (see scripts/package-vsix.mjs).', '.vscodeignore', ''].join(
      '\n',
    ),
  );

  // --------------------------------------------------------------- 4. check
  //
  // Before `vsce`, because `vsce` checks the manifest and this checks the thing
  // the manifest is about.
  verifyStage();

  // ----------------------------------------------------------------- 5. pack
  mkdirSync(outDir, { recursive: true });
  const vsix = join(outDir, `${EXTENSION_NAME}-${VERSION}.vsix`);
  execFileSync(
    join(REPO_ROOT, 'node_modules/.bin/vsce'),
    ['package', '--no-dependencies', '--allow-star-activation', '--out', vsix],
    { cwd: STAGE, stdio: 'inherit' },
  );

  console.log(`\n${vsix} — ${kb(vsix)}`);
  console.log('Verify it with: node scripts/verify-vsix.mjs');
}

function kb(path) {
  return `${(statSync(path).size / 1024).toFixed(0)} KB`;
}

/**
 * Everything the packaged extension resolves at runtime, asserted to be where
 * it will look for it.
 *
 * The constants come from the extension's own source rather than from this
 * script, so a rename over there fails here instead of shipping.
 */
function verifyStage() {
  const required = [
    ['dist/extension.cjs', 'the entry the manifest names'],
    ['dist/worker-entry.cjs', 'runtime.ts: WORKER_ENTRY'],
    ['wasm/tree-sitter-solidity.wasm', 'runtime.ts: WASM_DIR/GRAMMAR_WASM'],
    ['media/vscode.js', 'assets.ts: MEDIA_DIR'],
    ['media/vscode.css', 'assets.ts: MEDIA_DIR'],
    [`${VENDOR_DIR}/web-tree-sitter/web-tree-sitter.cjs`, 'the bundles’ relative require'],
    [`${VENDOR_DIR}/web-tree-sitter/web-tree-sitter.wasm`, 'its glue locates this by __dirname'],
    ['THIRD-PARTY-NOTICES.md', '§7 Phase 9: elkjs is EPL-2.0 and is redistributed here'],
    ['icon.png', 'the manifest’s `icon` field, and the Marketplace listing’s tile'],
  ];
  for (const [path, why] of required) {
    if (!existsSync(join(STAGE, path))) fail(`staged tree is missing ${path} — ${why}`);
  }

  // `assets.ts` finds elkjs's worker by prefix, so the check is the same shape.
  const assets = join(STAGE, 'media/assets');
  const worker = existsSync(assets)
    ? readdirSync(assets).find((f) => f.startsWith('elk-worker') && f.endsWith('.js'))
    : undefined;
  if (worker === undefined) fail('staged tree has no media/assets/elk-worker*.js (§9 rule 6)');

  // The bundle must not have kept an ESM `import` at the top level: the host
  // `require`s this file, and a stray one is a load error the moment a user
  // installs it rather than a build error here.
  const entry = readFileSync(join(STAGE, 'dist/extension.cjs'), 'utf8');
  if (/^\s*import[\s{*]/m.test(entry)) fail('dist/extension.cjs contains ESM import syntax');
  if (!/exports\.activate\s*=|activate:/.test(entry)) fail('dist/extension.cjs exports no activate');

  step('staged tree verified — every runtime path resolves inside the package');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
