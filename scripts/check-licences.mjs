#!/usr/bin/env node
/**
 * Licence compliance (AXIOMAP.md §7, Phase 9): "Add a `license-checker` CI job
 * as the sibling of the network-dependency check from §3 — same pattern, same
 * enforcement. … Fail CI on any new dependency under a strong-copyleft or
 * unlicensed term."
 *
 * Sibling in the literal sense: this walks the same `pnpm list --prod` trees
 * that `check-no-network-deps.mjs` walks, reads one field out of each
 * `package.json`, and exits non-zero with the offending packages named. Both are
 * properties of the repo that are only real if they block a merge.
 *
 * ### Why it is here in Phase 7e rather than in Phase 9
 *
 * Phase 7d added `elkjs` (`EPL-2.0 OR GPL-3.0-or-later`) to `@axiomap/cli` and
 * nothing noticed. That one is fine — see the note below — but "nothing noticed"
 * is the part worth fixing, and Phase 8 is the phase that adds the VS Code
 * extension's dependencies. A gate written after them is a gate written around
 * whatever they turned out to be.
 *
 * ### The three answers
 *
 * - **Allowed.** Permissive, or file-level copyleft that permits linking from
 *   differently-licensed code. Consuming and redistributing these is settled;
 *   the notices file is what they cost.
 * - **Refused.** Strong copyleft, source-available and non-commercial terms.
 *   §2's decision #7 is MIT and §14 already refuses to vendor GPL Solidity for
 *   the same reason.
 * - **Unreviewed.** Anything else, including a missing or `UNLICENSED` field.
 *   This is the important case and it fails: a dependency whose terms nobody
 *   has read is exactly what §7 means by "unlicensed", and defaulting to "it is
 *   probably fine" would make the gate decorative.
 *
 * A dual licence is an SPDX expression, and `A OR B` needs only one acceptable
 * arm — which is precisely how `elkjs` is consumable in an MIT repo. So the
 * expression is evaluated rather than string-matched.
 *
 * Usage: node scripts/check-licences.mjs [--list]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * Permissive, plus the two file-level copyleft licences this repo knowingly
 * consumes. EPL-2.0 is the acceptable arm of `elkjs`'s dual licence and MPL-2.0
 * works the same way: copyleft attaches to the licensed files, not to the work
 * that links them.
 */
export const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'EPL-2.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/** Named so the failure says *why*, rather than "not on the allowlist". */
export const REFUSED = new Map([
  ['GPL', 'strong copyleft'],
  ['AGPL', 'strong network copyleft'],
  [
    'LGPL',
    'copyleft on a linked work when the linking is static, which a bundle is',
  ],
  ['SSPL', 'source-available, not open source'],
  ['BUSL', 'source-available, not open source'],
  ['BUSL-1.1', 'source-available, not open source'],
  ['CC-BY-NC', 'non-commercial'],
  ['UNLICENSED', 'no licence granted'],
  ['SEE LICENSE IN LICENSE', 'terms are in a file nobody has read'],
]);

/** Why a licence is refused, or null when it is not one of the named ones. */
export function refusalReason(id) {
  const upper = id.toUpperCase();
  for (const [prefix, reason] of REFUSED) {
    if (upper === prefix || upper.startsWith(`${prefix}-`)) return reason;
  }
  return null;
}

/**
 * Evaluate an SPDX expression: `A OR B` needs one acceptable arm, `A AND B`
 * needs both, and `A WITH exception` is decided by `A`.
 *
 * Deliberately small — a recursive descent over three operators and
 * parentheses. The alternative is a dependency, and a dependency inside the
 * dependency checker is the wrong shape.
 */
export function evaluate(expression) {
  const tokens = expression
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter((token) => token !== '');

  let at = 0;
  const peek = () => tokens[at];

  /** One licence id, a parenthesised expression, or `id WITH exception`. */
  const factor = () => {
    if (peek() === '(') {
      at += 1;
      const inner = or();
      if (peek() === ')') at += 1;
      return inner;
    }
    const id = tokens[at];
    at += 1;
    if (id === undefined)
      return { ok: false, refused: [], unknown: ['(empty)'] };
    // `WITH` narrows a licence with an exception; the base licence decides.
    if (peek()?.toUpperCase() === 'WITH') at += 2;

    const bare = id.replace(/\+$/, '');
    if (ALLOWED.has(bare)) return { ok: true, refused: [], unknown: [] };
    const reason = refusalReason(bare);
    if (reason !== null)
      return { ok: false, refused: [`${bare} (${reason})`], unknown: [] };
    return { ok: false, refused: [], unknown: [bare] };
  };

  const and = () => {
    let left = factor();
    while (peek()?.toUpperCase() === 'AND') {
      at += 1;
      const right = factor();
      left = {
        ok: left.ok && right.ok,
        refused: [...left.refused, ...right.refused],
        unknown: [...left.unknown, ...right.unknown],
      };
    }
    return left;
  };

  const or = () => {
    let left = and();
    while (peek()?.toUpperCase() === 'OR') {
      at += 1;
      const right = and();
      left = {
        ok: left.ok || right.ok,
        // An acceptable arm makes the other arm's terms irrelevant, which is
        // the whole reason `elkjs` is usable here.
        refused: left.ok || right.ok ? [] : [...left.refused, ...right.refused],
        unknown: left.ok || right.ok ? [] : [...left.unknown, ...right.unknown],
      };
    }
    return left;
  };

  return or();
}

/** The licence a package declares, in whatever shape its `package.json` uses. */
export function declaredLicence(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim() !== '') {
    return manifest.license.trim();
  }
  if (typeof manifest.license === 'object' && manifest.license !== null) {
    return String(manifest.license.type ?? '');
  }
  if (Array.isArray(manifest.licenses)) {
    // The pre-SPDX form. Several entries meant "any of these".
    const ids = manifest.licenses
      .map((entry) => String(entry?.type ?? ''))
      .filter(Boolean);
    if (ids.length > 0) return ids.join(' OR ');
  }
  return '';
}

/** Every production dependency of every workspace package, deduplicated. */
export function productionDependencies() {
  const raw = execFileSync(
    'pnpm',
    ['list', '--recursive', '--prod', '--depth', 'Infinity', '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const found = new Map();
  const visit = (deps, requiredBy) => {
    for (const [name, dep] of Object.entries(deps ?? {})) {
      if (!dep?.path) continue;
      // Workspace siblings are this repo's own, and MIT by §2's decision #7.
      if (dep.path.startsWith(join(REPO_ROOT, 'packages'))) {
        visit(dep.dependencies, name);
        continue;
      }
      const key = `${name}@${String(dep.version ?? '')}`;
      if (found.has(key)) {
        found.get(key).requiredBy.add(requiredBy);
        continue;
      }
      let manifest = {};
      try {
        manifest = JSON.parse(
          readFileSync(join(dep.path, 'package.json'), 'utf8'),
        );
      } catch {
        // An unreadable manifest is an unreviewed licence, not a skip.
      }
      found.set(key, {
        name,
        version: String(dep.version ?? ''),
        licence: declaredLicence(manifest),
        requiredBy: new Set([requiredBy]),
      });
      visit(dep.dependencies, name);
    }
  };

  for (const project of JSON.parse(raw)) {
    visit(project.dependencies, project.name ?? 'workspace');
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Sort a dependency list into the three answers.
 *
 * Separated from the walk so a test can drive it with a package that is not
 * installed here — which is the only way to prove the gate *bites*, the same
 * thing `dependency-direction.test.ts` does for the import rule. A gate nobody
 * has seen fail is a gate nobody knows works.
 */
export function classify(packages) {
  const refused = [];
  const unreviewed = [];
  const notable = [];

  for (const entry of packages) {
    if (entry.licence === '') {
      unreviewed.push({ ...entry, detail: 'declares no licence' });
      continue;
    }
    const verdict = evaluate(entry.licence);
    if (verdict.ok) {
      if (entry.licence !== 'MIT') notable.push(entry);
      continue;
    }
    if (verdict.refused.length > 0) {
      refused.push({ ...entry, detail: verdict.refused.join(', ') });
    } else {
      unreviewed.push({
        ...entry,
        detail: `unrecognised term '${entry.licence}'`,
      });
    }
  }

  return { refused, unreviewed, notable };
}

/** The command. Split from the parts above so a test may import them. */
function main() {
  const packages = productionDependencies();
  const { refused, unreviewed, notable } = classify(packages);

  if (process.argv.includes('--list')) {
    for (const entry of packages) {
      console.log(
        `${entry.name}@${entry.version}\t${entry.licence === '' ? '(none)' : entry.licence}`,
      );
    }
  }

  if (refused.length > 0 || unreviewed.length > 0) {
    console.error('Licence check failed (AXIOMAP.md §7, Phase 9):\n');
    for (const entry of refused) {
      console.error(
        `  REFUSED     ${entry.name}@${entry.version} — ${entry.licence}: ${entry.detail}`,
      );
      console.error(
        `              required by ${[...entry.requiredBy].join(', ')}`,
      );
    }
    for (const entry of unreviewed) {
      console.error(
        `  UNREVIEWED  ${entry.name}@${entry.version} — ${entry.detail}`,
      );
      console.error(
        `              required by ${[...entry.requiredBy].join(', ')}`,
      );
    }
    console.error(
      '\nThis repo is MIT (decision #7) and redistributes its production tree in the\n' +
        '.vsix and in `export --format html`. A strong-copyleft dependency is a licence\n' +
        'conflict; an unreviewed one is a decision nobody has made yet.\n\n' +
        'If the term is in fact acceptable, add it to ALLOWED in this script with the\n' +
        'reason — that edit is the review, and it belongs in the diff.',
    );
    process.exit(1);
  }

  console.log(
    `${String(packages.length)} production dependencies, all under terms this repo can ship.`,
  );
  if (notable.length > 0) {
    // Not a warning: these are the ones that need attribution where they are
    // redistributed (§7's Phase 9 and `export/html.ts`'s footer), so they are
    // worth naming on a green run rather than only on a red one.
    console.log('\nNeeding attribution where redistributed:');
    for (const entry of notable) {
      console.log(`  ${entry.name}@${entry.version} — ${entry.licence}`);
    }
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
