#!/usr/bin/env node
/**
 * Enforced invariant (AXIOMAP.md §3): `@axiomap/core` must have zero
 * network-capable dependencies.
 *
 * Walks core's production dependency tree plus its own sources and fails on any
 * import of `http`, `https`, `net`, `dns`, or `undici`. This is a security
 * property auditors will check before running the tool on client code, so it is
 * a CI gate rather than a convention.
 *
 * Usage: node scripts/check-no-network-deps.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FORBIDDEN = ['http', 'https', 'net', 'dns', 'undici'];

const SPECIFIER = new RegExp(
  String.raw`(?:require\s*\(\s*|import\s*\(\s*|from\s+|import\s+)['"](?:node:)?(` +
    FORBIDDEN.join('|') +
    String.raw`)(?:/[^'"]*)?['"]`,
  'g',
);

const SCANNABLE = /\.(m|c)?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'test', '__tests__']);

/** Every directory holding code that ships as part of `@axiomap/core`. */
function productionRoots() {
  const roots = [join(REPO_ROOT, 'packages/core/src')];

  const raw = execFileSync(
    'pnpm',
    ['list', '--filter', '@axiomap/core', '--prod', '--depth', 'Infinity', '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  const seen = new Set();
  const visit = (deps) => {
    for (const dep of Object.values(deps ?? {})) {
      if (!dep?.path || seen.has(dep.path)) continue;
      seen.add(dep.path);
      // Workspace siblings are checked by their own source roots, not as blobs.
      if (!dep.path.startsWith(join(REPO_ROOT, 'packages'))) roots.push(dep.path);
      visit(dep.dependencies);
    }
  };

  for (const project of JSON.parse(raw)) visit(project.dependencies);
  return roots;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && SCANNABLE.test(entry.name)) {
      yield full;
    }
  }
}

const violations = [];

for (const root of productionRoots()) {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;

  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push({ file: relative(REPO_ROOT, file), line, module: match[1] });
    }
  }
}

if (violations.length > 0) {
  console.error('Network-capable dependency found in @axiomap/core (AXIOMAP.md §3):\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} imports "${v.module}"`);
  }
  console.error('\n@axiomap/core must have zero network-capable dependencies.');
  process.exit(1);
}

console.log(`@axiomap/core: no imports of ${FORBIDDEN.join(', ')} in the production tree.`);
