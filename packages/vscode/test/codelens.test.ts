/**
 * §11's CodeLens line: `▸ 3 callers · 2 external calls · writes 4 vars ·
 * reviewed`.
 *
 * The counts are core's and tested there (`fileLenses`). What is decided here is
 * the sentence — including the two things it deliberately does not say: a zero,
 * and any claim stronger than what the analysis found.
 */

import { describe, expect, it } from 'vitest';

import type { FileLens } from '@axiomap/core';

import { lensTitle } from '../src/codelens.js';

function lens(over: Partial<FileLens> = {}): FileLens {
  return {
    id: 'src/Vault.sol:Vault.deposit(uint256)',
    name: 'deposit',
    scope: 'src/Vault.sol:Vault',
    src: { file: 'src/Vault.sol', offset: 0, length: 10, line: 1, column: 0 },
    subkind: 'function',
    visibility: 'internal',
    callers: 0,
    externalCalls: 0,
    writes: 0,
    reads: 0,
    externallyReachable: true,
    accessControl: { modifiers: [], confidence: 'none' },
    review: null,
    findings: 0,
    ...over,
  };
}

describe('lensTitle', () => {
  it('is §11’s line', () => {
    expect(
      lensTitle(lens({ callers: 3, externalCalls: 2, writes: 4, visibility: 'internal' })),
    ).toBe('▸ 3 callers · 2 external calls · writes 4 vars');
  });

  it('leaves out a zero rather than printing one', () => {
    // "0 callers · 0 external calls · writes 0 vars" above every pure helper in
    // a library is noise with a number in it, and this line is inserted into
    // somebody's source.
    expect(lensTitle(lens())).toBe('▸ no callers, no calls out');
    expect(lensTitle(lens({ callers: 1 }))).toBe('▸ 1 caller');
    expect(lensTitle(lens({ writes: 1 }))).toBe('▸ writes 1 var');
  });

  it('says what was *found* about access control, not what is true (§10)', () => {
    // `confidence: 'none'` means no recognised guard — §13's list is what makes
    // a protocol's own spelling recognisable — so the wording is about
    // recognition rather than about safety.
    expect(lensTitle(lens({ visibility: 'external' }))).toBe('▸ no recognised guard');
    expect(
      lensTitle(
        lens({
          visibility: 'external',
          accessControl: { modifiers: ['onlyOwner'], confidence: 'high' },
        }),
      ),
    ).toBe('▸ onlyOwner');
    // An inline `msg.sender` check is `low`, and naming no modifier is honest
    // about there being none to name.
    expect(
      lensTitle(lens({ visibility: 'public', accessControl: { modifiers: [], confidence: 'low' } })),
    ).toBe('▸ no callers, no calls out');
  });

  it('does not ask a constructor for a guard', () => {
    // No actor can call one on a live system (Phase 4), so "no recognised
    // guard" on every constructor in a protocol would be a column of noise.
    expect(lensTitle(lens({ visibility: 'public', subkind: 'constructor' }))).toBe(
      '▸ no callers, no calls out',
    );
  });

  it('mentions unreachability only where it is surprising', () => {
    expect(lensTitle(lens({ externallyReachable: false, callers: 0 }))).toBe('▸ unreachable');
    // An external entrypoint is reachable by definition; saying so adds nothing.
    expect(lensTitle(lens({ visibility: 'external', externallyReachable: false }))).toBe(
      '▸ no recognised guard',
    );
  });

  it('distinguishes a review from a review that no longer stands (§8)', () => {
    expect(
      lensTitle(lens({ review: { status: 'reviewed', staleness: 'current', at: 'now' } })),
    ).toBe('▸ reviewed');
    expect(lensTitle(lens({ review: { status: 'reviewed', staleness: 'stale', at: 'now' } }))).toBe(
      '▸ reviewed — body changed, needs re-review',
    );
    expect(
      lensTitle(lens({ review: { status: 'flagged', staleness: 'current', at: 'now' }, findings: 2 })),
    ).toBe('▸ flagged · 2 findings');
  });
});
