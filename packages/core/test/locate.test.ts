/**
 * Phase 8's two new queries — the graph indexed by source position, and §11's
 * CodeLens counts — plus the byte↔UTF-16 conversion the editor needs.
 *
 * Every expectation is derived by reading `fixtures/minimal/src/`, which is
 * fifteen functions of hand-written Solidity written to contain one of
 * everything (§14). §10's warning about byte offsets is the reason the last
 * describe block exists: an editor is where a character-offset implementation
 * shows up, as navigation that lands one character off in files with a `π` in
 * them and nowhere else.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fileLenses, nodeAtOffset, nodesInFile, overlayData, PositionIndex } from '../src/index.js';
import { fixture } from './fixtures.js';
import { graphOf, graphWithoutModeGating } from './graphs.js';

const VAULT = 'src/Vault.sol';

describe('nodesInFile', () => {
  it('returns one file’s declarations, containers before their members', async () => {
    const { graph } = await graphOf('minimal');
    const found = nodesInFile(graph, VAULT).map((node) => `${node.kind}:${node.name}`);

    // Declaration order, read off the file: the SourceUnit, the contract, then
    // its error, event, five state variables and seven functions.
    expect(found).toEqual([
      'SourceUnit:src/Vault.sol',
      'Contract:Vault',
      'Error:DepositTooLarge',
      'Event:Swept',
      'StateVariable:token',
      'StateVariable:assets',
      'StateVariable:status',
      'StateVariable:deposits',
      'StateVariable:implementation',
      'Function:constructor',
      'Function:deposit',
      'Function:totalAssets',
      'Function:tag',
      'Function:upgrade',
      'Function:sweep',
      'Function:_record',
    ]);
  });

  it('says nothing about a file the graph does not have', async () => {
    const { graph } = await graphOf('minimal');
    expect(nodesInFile(graph, 'src/NotHere.sol')).toEqual([]);
  });

  it('excludes the synthetic Unresolved placeholders (§10)', async () => {
    // `pathological/` has several — a function pointer, a low-level call. They
    // carry their *caller's* file, so a query that included them would answer
    // for a byte range they do not occupy. Ungated, because that fixture builds
    // in structural mode, where the orphaned placeholders are dropped (§10).
    const { graph } = await graphWithoutModeGating('pathological');
    const synthetic: string[] = [];
    graph.forEachNode((_id, node) => {
      if (node.kind === 'Unresolved') synthetic.push(node.file);
    });
    expect(synthetic.length).toBeGreaterThan(0);

    for (const file of new Set(synthetic)) {
      expect(nodesInFile(graph, file).every((node) => node.kind !== 'Unresolved')).toBe(true);
    }
  });
});

describe('nodeAtOffset', () => {
  it('finds the innermost declaration containing a byte offset', async () => {
    const { graph } = await graphOf('minimal');
    const source = fs.readFileSync(path.join(fixture('minimal'), VAULT), 'utf8');

    // A byte inside `_record`'s body. ASCII file, so the string index is the
    // byte offset; `PositionIndex` is exercised on a multi-byte file below.
    const inside = source.indexOf('status = amount == 0');
    expect(nodeAtOffset(graph, VAULT, inside)?.id).toBe('src/Vault.sol:Vault._record(uint256)');

    // A byte inside the contract but outside every member: the `using` line.
    const usingLine = source.indexOf('using MathLib for uint256');
    expect(nodeAtOffset(graph, VAULT, usingLine)?.id).toBe('src/Vault.sol:Vault');

    // A byte outside the contract: the import block. The SourceUnit's `src` is
    // a zero-length marker at offset 0 (§10), so nothing contains this.
    const importLine = source.indexOf('import {Base}');
    expect(nodeAtOffset(graph, VAULT, importLine)).toBeNull();
  });

  it('is half-open at the end of a declaration', async () => {
    const { graph } = await graphOf('minimal');
    const record = nodesInFile(graph, VAULT).find((node) => node.name === '_record');
    expect(record).toBeDefined();
    const { offset, length } = (record as NonNullable<typeof record>).src;

    expect(nodeAtOffset(graph, VAULT, offset)?.name).toBe('_record');
    expect(nodeAtOffset(graph, VAULT, offset + length - 1)?.name).toBe('_record');
    // One past the closing brace is the contract, not the function.
    expect(nodeAtOffset(graph, VAULT, offset + length)?.kind).toBe('Contract');
  });

  it('answers for the file it was asked about, not for the offset alone', async () => {
    const { graph } = await graphOf('minimal');
    const mint = nodesInFile(graph, 'src/Token.sol').find((node) => node.name === 'mint');
    expect(mint).toBeDefined();
    const inside = (mint as NonNullable<typeof mint>).src.offset + 1;

    expect(nodeAtOffset(graph, 'src/Token.sol', inside)?.name).toBe('mint');
    // The same offset in another file is a different question, and in a file
    // the graph does not have it has no answer at all.
    expect(nodeAtOffset(graph, VAULT, inside)?.name).not.toBe('mint');
    expect(nodeAtOffset(graph, 'src/NotHere.sol', inside)).toBeNull();
  });
});

describe('fileLenses', () => {
  /**
   * The counts, read off `Vault.sol`:
   *
   * - `constructor` writes `token`, `implementation` and `status` — three.
   * - `deposit` calls `token.mint` (one external call), writes `assets` and
   *   `deposits`, and is nobody's callee.
   * - `upgrade` and `sweep` are the two `onlyOwner` functions, and each makes
   *   one call that leaves the contract: a `delegatecall` and a `.call`.
   * - `_record` is called once, by `deposit`, and writes `status`.
   */
  it('counts callers, external calls and writes per function', async () => {
    const { graph } = await graphOf('minimal');
    const byName = new Map(fileLenses(graph, VAULT).map((lens) => [lens.name, lens]));

    expect(byName.get('constructor')?.writes).toBe(3);
    expect(byName.get('deposit')).toMatchObject({ callers: 0, externalCalls: 1, writes: 2 });
    expect(byName.get('upgrade')).toMatchObject({ externalCalls: 1, writes: 0 });
    expect(byName.get('upgrade')?.accessControl).toEqual({
      modifiers: ['onlyOwner'],
      confidence: 'high',
    });
    expect(byName.get('sweep')?.externalCalls).toBe(1);
    expect(byName.get('_record')).toMatchObject({ callers: 1, writes: 1, externalCalls: 0 });
  });

  it('counts a caller that reaches a function through `super` and through `using`', async () => {
    const { graph } = await graphOf('minimal');
    // `Vault.tag` calls `super.tag()`, which is `Base.tag`.
    const base = fileLenses(graph, 'src/Base.sol').find((lens) => lens.name === 'tag');
    expect(base?.callers).toBe(1);

    // `assets.half()` is the attached-library call; `scale(assets, 2)` is the
    // free function. Both are called exactly once, by `totalAssets`.
    const types = new Map(fileLenses(graph, 'src/Types.sol').map((lens) => [lens.name, lens]));
    expect(types.get('half')?.callers).toBe(1);
    expect(types.get('scale')?.callers).toBe(1);
  });

  it('returns functions in declaration order, and nothing for a file with none', async () => {
    const { graph } = await graphOf('minimal');
    expect(fileLenses(graph, VAULT).map((lens) => lens.name)).toEqual([
      'constructor',
      'deposit',
      'totalAssets',
      'tag',
      'upgrade',
      'sweep',
      '_record',
    ]);
    expect(fileLenses(graph, 'src/IVault.sol').map((lens) => lens.name)).toEqual([
      'deposit',
      'totalAssets',
    ]);
    expect(fileLenses(graph, 'src/NotHere.sol')).toEqual([]);
  });

  it('carries the review verdict and its staleness, separately (§8)', async () => {
    const { graph } = await graphOf('minimal');
    const id = 'src/Vault.sol:Vault.deposit(uint256)';
    const node = graph.getNodeAttributes(id);
    expect(node.kind).toBe('Function');

    const overlays = overlayData(graph, {
      review: {
        [id]: {
          status: 'reviewed',
          // Not the current body hash: §8's flagship feature is that a review
          // of a body that has since changed is *stale*, not reviewed.
          bodyHash: 'not-the-current-hash',
          reviewer: 'alice',
          at: '2026-08-06T00:00:00Z',
        },
      },
      findings: null,
    });

    const lens = fileLenses(graph, VAULT, { overlays }).find((entry) => entry.id === id);
    expect(lens?.review).toMatchObject({ status: 'reviewed', staleness: 'stale' });

    // Without the overlay the same function says nothing about review state,
    // which is not the same as saying it is unreviewed.
    expect(fileLenses(graph, VAULT).find((entry) => entry.id === id)?.review).toBeNull();
  });
});

describe('byte offsets survive the round trip (§10)', () => {
  const CRLF = path.join(fixture('pathological'), 'src/Crlf.sol');

  it('converts a byte offset back to the UTF-16 index it came from', () => {
    const text = fs.readFileSync(CRLF, 'utf8');
    const index = new PositionIndex('src/Crlf.sol', text);
    // This fixture is CRLF-terminated *and* multi-byte, which is what makes it
    // the file where an implementation that counted characters would be wrong.
    expect(text).toMatch(/\r\n/);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(text.length);

    for (let at = 0; at <= text.length; at += 1) {
      // Except the second half of a surrogate pair, which is not a position: it
      // is the middle of one character, and both directions agree the position
      // there is the start of that character. This fixture contains astral
      // characters, so the case is exercised rather than assumed.
      const unit = text.charCodeAt(at);
      if (unit >= 0xdc00 && unit <= 0xdfff) continue;
      expect(index.utf16IndexAt(index.byteOffsetAt(at))).toBe(at);
    }
  });

  it('clamps rather than throwing, and lands on a character boundary', () => {
    const index = new PositionIndex('x.sol', 'aéb');
    expect(index.utf16IndexAt(-5)).toBe(0);
    expect(index.utf16IndexAt(9_999)).toBe(3);
    // Offset 2 is the second byte of `é`; the position is the start of it.
    expect(index.utf16IndexAt(2)).toBe(1);
  });

  it('handles a surrogate pair, which is two units and four bytes', () => {
    const text = 'a\u{1F600}b';
    const index = new PositionIndex('x.sol', text);
    expect(index.byteOffsetAt(3)).toBe(5);
    expect(index.utf16IndexAt(5)).toBe(3);
    expect(index.utf16IndexAt(1)).toBe(1);
  });
});
