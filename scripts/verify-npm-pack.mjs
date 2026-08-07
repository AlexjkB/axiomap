#!/usr/bin/env node
/**
 * Run the **packed npm tarballs**, installed into a directory with no
 * workspace above it — the npm-publish sibling of `verify-vsix.mjs`.
 *
 * §7 Phase 9's exit criterion is "a stranger can `npm i -g @axiomap/cli`, run
 * it on their protocol, and understand what they are looking at without
 * asking you." Nothing in this repo has actually published anything, so the
 * closest honest check is the one `verify-vsix.mjs` already established for
 * the extension: pack the real artifact, install it somewhere this repo's own
 * `node_modules` and `workspace:*` protocol cannot reach, and run it.
 *
 * `@axiomap/cli` depends on `@axiomap/core` and `@axiomap/webview` by name and
 * version (`pnpm pack` rewrites `workspace:*` to the current version, not to a
 * path), so a plain `npm install` of the CLI tarball alone would try to fetch
 * those two from the real npm registry — wrong today (unpublished) and still
 * the wrong thing to depend on once they are (this check should prove *this
 * build* works, not whatever happens to be live on npm). `overrides` pins the
 * transitive resolution of both to their own freshly-packed tarballs, at every
 * depth, so the three packages under test are exactly the three that were just
 * built.
 *
 * Usage: node scripts/verify-npm-pack.mjs   (after `pnpm build`)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = ['core', 'webview', 'cli'];

function fail(message) {
  console.error(`\nverify-npm-pack: ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`  ok  ${message}`);
}

function step(message) {
  console.log(`\n${message}`);
}

const work = mkdtempSync(join(tmpdir(), 'axiomap-npm-pack-'));
const tarDir = join(work, 'tarballs');
const project = join(work, 'consumer');
mkdirSync(tarDir, { recursive: true });
mkdirSync(project, { recursive: true });

try {
  step(`Packing core, webview, cli → ${tarDir}`);
  const tarballs = {};
  for (const name of PACKAGES) {
    const pkgDir = join(REPO_ROOT, 'packages', name);
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (manifest.private === true) fail(`packages/${name} is still "private": true — it can't be packed for publish`);

    const output = execFileSync(
      'pnpm',
      ['pack', '--pack-destination', tarDir],
      { cwd: pkgDir, encoding: 'utf8' },
    );
    const tgzLine = output.trim().split('\n').at(-1);
    tarballs[manifest.name] = resolve(tgzLine.startsWith('/') ? tgzLine : join(tarDir, tgzLine));
    ok(`${manifest.name}@${manifest.version} → ${tarballs[manifest.name]}`);
  }

  // ---------------------------------------------- a consumer with no workspace above it
  step('Installing the tarballs into a project outside this repo');
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify(
      {
        name: 'axiomap-npm-pack-consumer',
        private: true,
        version: '0.0.0',
        dependencies: {
          '@axiomap/cli': `file:${tarballs['@axiomap/cli']}`,
        },
        // Forces every transitive reference to `@axiomap/core` and
        // `@axiomap/webview` — including the one inside the cli tarball's own
        // `package.json`, which names a bare version npm would otherwise try
        // to fetch from the real registry — onto the tarballs just built.
        overrides: {
          '@axiomap/core': `file:${tarballs['@axiomap/core']}`,
          '@axiomap/webview': `file:${tarballs['@axiomap/webview']}`,
        },
      },
      null,
      2,
    ),
  );

  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: project,
    stdio: 'inherit',
  });
  ok('npm install succeeded, resolving @axiomap/* to the freshly packed tarballs');

  // ------------------------------------------------------------- run it for real
  const bin = join(project, 'node_modules/.bin/axiomap');
  const version = execFileSync(bin, ['--version'], { cwd: project, encoding: 'utf8' }).trim();
  if (version.length === 0) fail('axiomap --version produced no output');
  ok(`axiomap --version → ${version}`);

  const target = join(project, 'protocol');
  cpSync(join(REPO_ROOT, 'fixtures/minimal'), target, { recursive: true });
  rmSync(join(target, '.axiomap'), { recursive: true, force: true });

  const buildOut = execFileSync(bin, ['build', target, '--json'], { cwd: project, encoding: 'utf8' });
  const result = JSON.parse(buildOut);
  if (typeof result.score?.overall?.total !== 'number' || result.score.overall.total === 0) {
    fail(`axiomap build reported no edges: ${buildOut}`);
  }
  if (!['full', 'heuristic', 'structural'].includes(result.mode)) {
    fail(`axiomap build reported an unrecognised mode: ${String(result.mode)}`);
  }
  ok(`axiomap build → mode ${result.mode}, ${String(result.score.overall.total)} edges scored`);

  const statsOut = execFileSync(bin, ['stats', target, '--json'], { cwd: project, encoding: 'utf8' });
  const stats = JSON.parse(statsOut);
  const contracts = stats.nodesByKind?.Contract ?? 0;
  if (!(contracts > 0)) fail(`axiomap stats reported ${String(contracts)} contracts`);
  ok(`axiomap stats → ${String(contracts)} contracts, reading the artifact just built`);

  const dot = execFileSync(bin, ['export', '--format', 'dot', '-v', 'protocol'], { cwd: target, encoding: 'utf8' });
  if (!dot.includes('digraph')) fail('axiomap export --format dot did not produce a dot file');
  ok('axiomap export --format dot produced a graph, with no server and no browser');

  console.log('\nThe packed npm tarballs work end to end from outside this repo.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
