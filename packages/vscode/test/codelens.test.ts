/**
 * §11's CodeLens line: `▸ 3 callers · 2 external calls · writes 4 vars ·
 * reviewed`.
 *
 * The counts are core's and tested there (`fileLenses`). What is decided here is
 * the sentence — including the two things it deliberately does not say: a zero,
 * and any claim stronger than what the analysis found.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Uri, state, workspace } from 'vscode';

import type { FileLens } from '@axiomap/core';

import { AxiomapLensProvider, FOCUS_COMMAND, lensTitle } from '../src/codelens.js';
import { AxiomapSession } from '../src/session.js';
import { CODE_LENS_ENABLED } from '../src/settings.js';
import { fixture } from './fixtures.js';

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

/**
 * The provider itself, which was the uncovered half of this file at the Phase 8b
 * boundary audit.
 *
 * Three decisions live here and nowhere else, and none of them is the sentence
 * above: that a lens is *not* drawn before a command has loaded the graph, that
 * a lens sits on the line its declaration starts on, and that the setting turns
 * it off. `pnpm test:host` checks the same three against a real editor; this
 * checks them in CI, on a machine with none.
 */
describe('AxiomapLensProvider', () => {
  const MINIMAL = fixture('minimal');
  const file = path.join(MINIMAL, 'src/Vault.sol');

  /** Only what the provider touches. The stub's rule is shapes, never behaviour. */
  function document(): { uri: Uri; getText: () => string } {
    const text = fs.readFileSync(file, 'utf8');
    return { uri: Uri.file(file), getText: () => text };
  }

  afterEach(() => {
    workspace.settings = {};
    state.root = '';
  });

  it('draws nothing until something has loaded the graph', async () => {
    state.root = MINIMAL;
    const session = AxiomapSession.open(MINIMAL);
    const provider = new AxiomapLensProvider(() => session);

    // Opening a `.sol` file in a 200k-SLOC repo must not start an ingest nobody
    // asked for; lenses appear once a command has built the graph.
    expect(await provider.provideCodeLenses(document() as never)).toEqual([]);
    expect(session.state).toBeNull();

    await session.ready();
    expect((await provider.provideCodeLenses(document() as never)).length).toBeGreaterThan(0);
  });

  it('draws nothing for a folder with no session', async () => {
    const provider = new AxiomapLensProvider(() => undefined);
    expect(await provider.provideCodeLenses(document() as never)).toEqual([]);
  });

  it('puts each lens on its declaration’s own line, carrying its node id', async () => {
    state.root = MINIMAL;
    const session = AxiomapSession.open(MINIMAL);
    await session.ready();
    const provider = new AxiomapLensProvider(() => session);

    const lenses = await provider.provideCodeLenses(document() as never);
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    for (const drawn of lenses) {
      const id = drawn.command?.arguments?.[0] as string;
      expect(drawn.command?.command).toBe(FOCUS_COMMAND);
      expect(id.startsWith('src/Vault.sol')).toBe(true);
      expect(drawn.command?.title.startsWith('▸')).toBe(true);
      // A zero-width range on the declaration's first line (§10's byte offsets
      // converted once, in `navigation.ts`), so the editor draws the lens above
      // the declaration rather than in the middle of the file.
      expect(drawn.range.start.line).toBe(drawn.range.end.line);
      const name = id.split(/[.:(]/).at(-2) ?? id;
      expect(lines[drawn.range.start.line] ?? '', id).toContain(name);
    }
  });

  it('draws nothing when the setting is off', async () => {
    state.root = MINIMAL;
    const session = AxiomapSession.open(MINIMAL);
    await session.ready();
    const provider = new AxiomapLensProvider(() => session);

    workspace.settings = { [CODE_LENS_ENABLED]: false };
    expect(await provider.provideCodeLenses(document() as never)).toEqual([]);
  });

  it('fires onDidChangeCodeLenses when the graph moves', () => {
    const provider = new AxiomapLensProvider(() => undefined);
    let fired = 0;
    provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });

    // What the artifact watch and the rebuild command both call; without it the
    // editor keeps drawing the previous graph's counts.
    provider.refresh();
    expect(fired).toBe(1);
    provider.dispose();
  });
});
