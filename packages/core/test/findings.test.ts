/**
 * `slither --json` import (§12's `axiomap import-findings`, decision #4).
 *
 * The offsets in these fixtures are computed from the real fixture source, not
 * hard-coded, because the whole mechanism is a byte-offset join and a
 * hand-written offset would test the arithmetic in the test rather than the
 * arithmetic in the code.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FindingsError,
  findingStaleness,
  importSlitherFindings,
  parseFindings,
  serializeFindings,
  type AxiomapGraph,
  type FindingsFile,
} from '../src/index.js';
import { fixture } from './fixtures.js';
import { graphOf } from './graphs.js';

/** The byte offset of `text` in a fixture file, which is what Slither reports. */
function offsetOf(file: string, text: string): number {
  const buffer = fs.readFileSync(path.join(fixture('defi'), file));
  const index = buffer.indexOf(text);
  if (index === -1) throw new Error(`"${text}" is not in ${file}`);
  return index;
}

function detector(
  check: string,
  file: string,
  start: number,
  length: number,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    check,
    impact: 'High',
    confidence: 'Medium',
    description: `${check} in ${file}`,
    elements: [
      {
        type: 'function',
        name: check,
        source_mapping: { start, length, filename_relative: file, lines: [1] },
      },
    ],
    ...extra,
  };
}

function slither(detectors: unknown[]): unknown {
  return { success: true, error: null, results: { detectors } };
}

describe('mapping findings onto nodes', () => {
  it('lands a finding on the function whose bytes contain it', async () => {
    const { graph } = await graphOf('defi');
    const start = offsetOf('src/Pair.sol', 'function mint(');
    const imported = importSlitherFindings(
      graph,
      slither([detector('reentrancy-eth', 'src/Pair.sol', start, 20)]),
    );

    expect(imported.findings).toHaveLength(1);
    expect(imported.findings[0]?.nodes.map((n) => n.id)).toEqual(['src/Pair.sol:Pair.mint(address)']);
    expect(imported.unmapped).toEqual([]);
  });

  it('picks the smallest containing node, not the first', async () => {
    const { graph } = await graphOf('defi');
    // A function's range sits inside its contract's, which sits inside the
    // source unit's. A reentrancy finding belongs on the function.
    const start = offsetOf('src/Pair.sol', 'function swap(');
    const imported = importSlitherFindings(
      graph,
      slither([detector('reentrancy-eth', 'src/Pair.sol', start, 10)]),
    );
    expect(imported.findings[0]?.nodes.map((n) => n.id)).toEqual([
      'src/Pair.sol:Pair.swap(uint256,uint256,address)',
    ]);
  });

  it('matches a path Slither wrote relative to somewhere else', async () => {
    const { graph } = await graphOf('defi');
    const start = offsetOf('src/Pair.sol', 'function mint(');
    const imported = importSlitherFindings(
      graph,
      slither([
        {
          check: 'x',
          impact: 'Low',
          confidence: 'High',
          description: 'x',
          elements: [
            {
              type: 'function',
              name: 'mint',
              source_mapping: {
                start,
                length: 20,
                filename_relative: 'fixtures/defi/src/Pair.sol',
                lines: [69],
              },
            },
          ],
        },
      ]),
    );
    expect(imported.findings[0]?.nodes.map((n) => n.id)).toEqual(['src/Pair.sol:Pair.mint(address)']);
  });

  it('reports an unmappable finding rather than dropping or guessing it', async () => {
    const { graph } = await graphOf('defi');
    const imported = importSlitherFindings(
      graph,
      slither([
        { check: 'solc-version', impact: 'Informational', confidence: 'High', description: 'loose pragma', elements: [] },
        detector('ghost', 'src/NotHere.sol', 10, 5),
      ]),
    );

    expect(imported.findings).toEqual([]);
    expect(imported.total).toBe(2);
    expect(imported.unmapped).toHaveLength(2);
    const reasons = Object.fromEntries(imported.unmapped.map((row) => [row.check, row.reason]));
    expect(reasons['solc-version']).toContain('no source element');
    expect(reasons['ghost']).toContain('no node in the graph');
  });

  it('gives two results of one check at one place distinct ids', async () => {
    const { graph } = await graphOf('defi');
    const start = offsetOf('src/Pair.sol', 'function mint(');
    const imported = importSlitherFindings(
      graph,
      slither([
        detector('reentrancy-eth', 'src/Pair.sol', start, 20),
        detector('reentrancy-eth', 'src/Pair.sol', start, 20),
      ]),
    );
    expect(new Set(imported.findings.map((f) => f.id)).size).toBe(2);
  });

  it('is deterministic: findings come back sorted', async () => {
    const { graph } = await graphOf('defi');
    const mint = offsetOf('src/Pair.sol', 'function mint(');
    const burn = offsetOf('src/Pair.sol', 'function burn(');
    const a = importSlitherFindings(
      graph,
      slither([detector('zzz', 'src/Pair.sol', mint, 10), detector('aaa', 'src/Pair.sol', burn, 10)]),
    );
    expect(a.findings.map((f) => f.check)).toEqual(['aaa', 'zzz']);
  });
});

describe('reading what Slither actually writes', () => {
  it('accepts a bare detector array', async () => {
    const { graph } = await graphOf('defi');
    const start = offsetOf('src/Pair.sol', 'function mint(');
    const imported = importSlitherFindings(graph, [detector('x', 'src/Pair.sol', start, 10)]);
    expect(imported.findings).toHaveLength(1);
  });

  it('says so when the file is a Slither run that failed', async () => {
    const { graph } = await graphOf('defi');
    expect(() =>
      importSlitherFindings(graph, { success: false, error: 'compilation failed', results: {} }),
    ).toThrow(/failed: compilation failed/);
  });

  it('refuses something that is not Slither output at all', async () => {
    const { graph } = await graphOf('defi');
    expect(() => importSlitherFindings(graph, { hello: 'world' })).toThrow(FindingsError);
  });
});

describe('findings.json', () => {
  it('round-trips and refuses a schema mismatch', () => {
    const file = {
      schemaVersion: 1 as const,
      source: { tool: 'slither', file: '/tmp/slither.json', at: '2026-08-04T00:00:00.000Z' },
      findings: [
        {
          id: 'reentrancy-eth@src/Pair.sol:100',
          check: 'reentrancy-eth',
          impact: 'High',
          confidence: 'Medium',
          description: 'x',
          nodes: [{ id: 'src/Pair.sol:Pair.swap(uint256,uint256,address)', bodyHash: 'a3f2' }],
          locations: [{ file: 'src/Pair.sol', offset: 100, length: 10, line: 5, column: 0 }],
        },
      ],
    };
    expect(parseFindings(serializeFindings(file))).toEqual(file);
    expect(() => parseFindings(JSON.stringify({ ...file, schemaVersion: 99 }))).toThrow(
      /schemaVersion 99/,
    );
  });
});

describe('a stored finding is a claim about a body, and can go stale', () => {
  /**
   * The gap this closes: without a recorded `bodyHash`, a host reports a
   * High-severity finding against a function rewritten after Slither ran.
   * `review.json` has solved this since Phase 5 and findings had not.
   */
  async function imported(): Promise<{ file: FindingsFile; graph: AxiomapGraph }> {
    const { graph } = await graphOf('defi');
    const start = offsetOf('src/Pair.sol', 'function swap(');
    const result = importSlitherFindings(
      graph,
      slither([detector('reentrancy-eth', 'src/Pair.sol', start, 20)]),
    );
    return {
      file: {
        schemaVersion: 1,
        source: { tool: 'slither', file: 'x.json', at: '2026-08-04T00:00:00.000Z' },
        findings: result.findings,
      },
      graph,
    };
  }

  it('records the body hash it landed on', async () => {
    const { file } = await imported();
    expect(file.findings[0]?.nodes[0]?.bodyHash).toMatch(/^\w+$/);
  });

  it('is current against the graph it was imported from', async () => {
    const { file, graph } = await imported();
    const reports = findingStaleness(file, graph);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.staleness).toBe('current');
    expect(reports[0]?.changed).toEqual([]);
  });

  it('goes stale when the body it named changes', async () => {
    const { file, graph } = await imported();
    const target = file.findings[0]?.nodes[0]?.id ?? '';
    const stale: typeof file = {
      ...file,
      findings: [
        {
          ...(file.findings[0] as (typeof file.findings)[number]),
          nodes: [{ id: target, bodyHash: 'something-else' }],
        },
      ],
    };
    const reports = findingStaleness(stale, graph);
    expect(reports[0]?.staleness).toBe('stale');
    expect(reports[0]?.changed).toEqual([target]);
  });

  it('is orphaned only when nothing it named survives', async () => {
    const { file, graph } = await imported();
    const gone: typeof file = {
      ...file,
      findings: [
        {
          ...(file.findings[0] as (typeof file.findings)[number]),
          nodes: [{ id: 'src/Gone.sol:Gone.vanished()', bodyHash: 'x' }],
        },
      ],
    };
    expect(findingStaleness(gone, graph)[0]?.staleness).toBe('orphaned');

    // A finding spanning a caller and a deleted callee is still about live
    // code; reporting it as gone would lose it.
    const partial: typeof file = {
      ...file,
      findings: [
        {
          ...(file.findings[0] as (typeof file.findings)[number]),
          nodes: [
            ...(file.findings[0]?.nodes ?? []),
            { id: 'src/Gone.sol:Gone.vanished()', bodyHash: 'x' },
          ],
        },
      ],
    };
    expect(findingStaleness(partial, graph)[0]?.staleness).toBe('stale');
  });
});
