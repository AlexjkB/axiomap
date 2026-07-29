/**
 * Per-file Solidity version policy (§4).
 *
 * Supported and tested: 0.8.x. Best-effort with no guarantees: 0.5–0.7 — these
 * are parsed and graphed but excluded from the resolution score, because
 * Uniswap V2 and Compound V2 forks are 0.5/0.6 and in a fork *that is the code
 * under audit*. Hard floor at 0.5; below it the legacy grammar (`var`,
 * implicit visibility, function-named constructors) would produce a subtly
 * wrong graph, which is worse than refusing.
 *
 * **Classification uses the highest version the pragma admits, not the
 * lowest.** A pragma is a constraint on which compiler may be used, and solc
 * picks the newest version satisfying it, so that is the version the file
 * effectively is. The lowest-version reading gets this backwards in a way that
 * shows up immediately on real code: OpenZeppelin's interfaces say
 * `pragma solidity >=0.4.16;`, which under a lowest-version rule lands below
 * the 0.5 hard floor and reports most of a healthy dependency tree as
 * unsupported. Under this rule they are unbounded above, therefore 0.8,
 * therefore supported — which is what they actually compile as.
 *
 * A pinned or bounded old version still downgrades, which is the case §4 cares
 * about: `pragma solidity =0.5.16;` is best-effort no matter what else is in
 * the project.
 */

import type { VersionSupport } from './table.js';

export interface PragmaVersion {
  raw: string;
  /**
   * Highest `[major, minor]` the pragma admits, or null when unbounded above
   * (which means "whatever the newest compiler is").
   */
  effective: [number, number] | null;
  support: VersionSupport;
}

interface Comparator {
  operator: string;
  major: number;
  minor: number;
  patch: number;
}

const COMPARATOR = /(\^|~|>=|<=|>|<|=)?\s*(\d+)\.(\d+)(?:\.(\d+))?/g;

function parseComparators(raw: string): Comparator[] {
  const out: Comparator[] = [];
  for (const match of raw.matchAll(COMPARATOR)) {
    const major = Number(match[2]);
    const minor = Number(match[3]);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) continue;
    out.push({
      operator: match[1] ?? '=',
      major,
      minor,
      patch: match[4] === undefined ? 0 : Number(match[4]),
    });
  }
  return out;
}

/**
 * Upper bound contributed by one comparator, as an inclusive `[major, minor]`,
 * or null when the comparator places no ceiling on the version.
 *
 * `^0.8.20` is the case worth stating: on a `0.x` version, caret pins the
 * minor, so it means `>=0.8.20 <0.9.0` and the ceiling is 0.8 — not 0.x for
 * any x, which is what caret means at 1.0 and above.
 */
function ceilingOf(comparator: Comparator): [number, number] | null {
  const { operator, major, minor, patch } = comparator;
  switch (operator) {
    case '>':
    case '>=':
      return null;
    case '<':
      // Exclusive: `<0.8.0` admits up to 0.7.x, `<0.8.5` still admits 0.8.
      return patch === 0 ? [major, minor - 1] : [major, minor];
    case '<=':
      return [major, minor];
    case '^':
      return major === 0 ? [major, minor] : null;
    case '~':
      return [major, minor];
    default:
      return [major, minor];
  }
}

function lower(a: [number, number], b: [number, number]): [number, number] {
  if (a[0] !== b[0]) return a[0] < b[0] ? a : b;
  return a[1] <= b[1] ? a : b;
}

export function classifyPragma(raw: string | null): PragmaVersion {
  if (raw === null) return { raw: '', effective: null, support: 'unknown' };

  const comparators = parseComparators(raw);
  if (comparators.length === 0) return { raw, effective: null, support: 'unknown' };

  let ceiling: [number, number] | null = null;
  for (const comparator of comparators) {
    const bound = ceilingOf(comparator);
    if (bound === null) continue;
    ceiling = ceiling === null ? bound : lower(ceiling, bound);
  }

  // Unbounded above means the newest compiler, which is inside the tested band.
  if (ceiling === null) return { raw, effective: null, support: 'supported' };

  const [major, minor] = ceiling;
  let support: VersionSupport;
  if (major > 0 || minor >= 8) support = 'supported';
  else if (minor >= 5) support = 'best-effort';
  else support = 'unsupported';

  return { raw, effective: ceiling, support };
}

/** The first `pragma solidity` directive in a file, if any. */
export function findSolidityPragma(pragmas: readonly { raw: string }[]): string | null {
  for (const pragma of pragmas) {
    if (/pragma\s+solidity/.test(pragma.raw)) return pragma.raw;
  }
  return null;
}
