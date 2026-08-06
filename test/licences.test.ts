/**
 * The licence gate, and whether it bites (§7's Phase 9, built in Phase 7e).
 *
 * §7: "Add a `license-checker` CI job as the sibling of the network-dependency
 * check from §3 — same pattern, same enforcement. … Fail CI on any new
 * dependency under a strong-copyleft or unlicensed term."
 *
 * The reason this suite exists rather than "the script exits 0, ship it": a gate
 * nobody has seen *fail* is a gate nobody knows works, which is the whole
 * lesson of Phase 7d adding `elkjs` and nothing noticing. So this drives the
 * classifier with packages that are not installed here — a GPL one, an
 * unlicensed one, a dual licence with one acceptable arm — the way
 * `dependency-direction.test.ts` deliberately writes a forbidden import.
 *
 * It lives at the repo root because the thing under test is a repo-level
 * invariant and belongs to no package, which is what this directory is for.
 */

import { describe, expect, it } from 'vitest';

// @ts-expect-error — a repo script, checked by this test rather than by tsc.
import { classify, evaluate, declaredLicence } from '../scripts/check-licences.mjs';

interface Verdict {
  ok: boolean;
  refused: string[];
  unknown: string[];
}

interface Entry {
  name: string;
  version: string;
  licence: string;
  requiredBy?: Set<string>;
}

const verdict = (expression: string): Verdict => evaluate(expression) as Verdict;

const sorted = (packages: Entry[]): { refused: Entry[]; unreviewed: Entry[]; notable: Entry[] } =>
  classify(packages) as { refused: Entry[]; unreviewed: Entry[]; notable: Entry[] };

describe('the SPDX expression', () => {
  it('accepts the permissive terms this repo is built on', () => {
    for (const id of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', '0BSD']) {
      expect(verdict(id).ok, id).toBe(true);
    }
  });

  /**
   * The case that motivated evaluating the expression rather than matching the
   * string. `elkjs` is dual-licensed and only one arm is acceptable; §7's note
   * says consuming it is fine "under MIT (EPL-2.0 is file-level copyleft and
   * permits linking from differently-licensed code)".
   */
  it('takes the acceptable arm of a dual licence', () => {
    expect(verdict('EPL-2.0 OR GPL-3.0-or-later').ok).toBe(true);
    expect(verdict('GPL-3.0-or-later OR EPL-2.0').ok).toBe(true);
    expect(verdict('(MIT OR Apache-2.0)').ok).toBe(true);
  });

  it('refuses a conjunction where either half is refused', () => {
    expect(verdict('MIT AND GPL-3.0-only').ok).toBe(false);
    expect(verdict('MIT AND Apache-2.0').ok).toBe(true);
  });

  it('refuses strong copyleft, and says which kind', () => {
    for (const [id, reason] of [
      ['GPL-3.0-only', 'strong copyleft'],
      ['AGPL-3.0-or-later', 'network'],
      ['LGPL-3.0-only', 'linked'],
      ['BUSL-1.1', 'source-available'],
      ['SSPL-1.0', 'source-available'],
    ] as const) {
      const result = verdict(id);
      expect(result.ok, id).toBe(false);
      expect(result.refused.join(' '), id).toContain(reason);
    }
  });

  /**
   * §7 says "strong-copyleft **or unlicensed**", and the unlicensed half is the
   * one that has to fail closed: a term nobody recognises is a decision nobody
   * has made, and treating it as fine would make the gate decorative.
   */
  it('refuses a term it does not recognise rather than assuming it is fine', () => {
    const result = verdict('WeirdCorp-Proprietary-1.0');
    expect(result.ok).toBe(false);
    expect(result.refused).toEqual([]);
    expect(result.unknown).toEqual(['WeirdCorp-Proprietary-1.0']);
    expect(verdict('UNLICENSED').ok).toBe(false);
  });

  it('decides a licence with an exception by the licence', () => {
    expect(verdict('Apache-2.0 WITH LLVM-exception').ok).toBe(true);
    expect(verdict('GPL-2.0-only WITH Classpath-exception-2.0').ok).toBe(false);
  });
});

describe('what a package declares', () => {
  it('reads the modern field, the old object, and the older array', () => {
    expect(declaredLicence({ license: 'MIT' })).toBe('MIT');
    expect(declaredLicence({ license: { type: 'ISC' } })).toBe('ISC');
    expect(declaredLicence({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      'MIT OR Apache-2.0',
    );
  });

  it('is empty when there is nothing to read', () => {
    expect(declaredLicence({})).toBe('');
    expect(declaredLicence({ license: '   ' })).toBe('');
  });
});

describe('the gate', () => {
  const entry = (name: string, licence: string): Entry => ({
    name,
    version: '1.0.0',
    licence,
    requiredBy: new Set(['@axiomap/cli']),
  });

  it('passes a tree of permissive dependencies', () => {
    const { refused, unreviewed } = sorted([entry('commander', 'MIT'), entry('ora', 'MIT')]);
    expect(refused).toEqual([]);
    expect(unreviewed).toEqual([]);
  });

  it('fails on a strong-copyleft dependency, naming it and why', () => {
    const { refused } = sorted([entry('commander', 'MIT'), entry('some-gpl-thing', 'GPL-3.0-only')]);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.name).toBe('some-gpl-thing');
    expect(refused[0]).toHaveProperty('detail', expect.stringContaining('strong copyleft'));
  });

  it('fails on a dependency that declares nothing', () => {
    const { unreviewed } = sorted([entry('mystery', '')]);
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toHaveProperty('detail', 'declares no licence');
  });

  /**
   * The green-run half. `elkjs` passes, and it is reported anyway — because
   * §7's Phase 9 wants a `THIRD-PARTY-NOTICES.md` and the export's footer
   * already carries the attribution, so what needs attributing is worth naming
   * when the gate is *not* failing.
   */
  it('reports what needs attribution even when nothing fails', () => {
    const { refused, notable } = sorted([
      entry('commander', 'MIT'),
      entry('elkjs', 'EPL-2.0 OR GPL-3.0-or-later'),
    ]);
    expect(refused).toEqual([]);
    expect(notable.map((item) => item.name)).toEqual(['elkjs']);
  });
});
