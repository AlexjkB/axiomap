/**
 * Where the cursor lands.
 *
 * §10: "Getting this wrong makes navigation land in the wrong place in any file
 * containing non-ASCII characters, and it will look like a random intermittent
 * bug." This is the file that would have that bug, so the cases are a
 * multi-byte, CRLF-terminated source (`pathological/src/Crlf.sol`, which exists
 * for exactly this) and an ordinary one.
 */

import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildProjectGraph, nodesInFile, type AxiomapGraph } from '@axiomap/core';

import { rangeOfRef, rangeOfSite } from '../src/navigation.js';
import { fixture } from './fixtures.js';

const MINIMAL = fixture('minimal');
const VAULT = 'src/Vault.sol';

let graph: AxiomapGraph;

beforeAll(async () => {
  graph = (
    await buildProjectGraph(MINIMAL, { cacheDir: null, workers: 1, enrich: false })
  ).graph;
});

/** The text a range covers, which is the only thing that proves it is right. */
function slice(text: string, range: ReturnType<typeof rangeOfRef>): string {
  const lines = text.split(/\r?\n/);
  if (range.start.line === range.end.line) {
    return (lines[range.start.line] ?? '').slice(range.start.character, range.end.character);
  }
  return [
    (lines[range.start.line] ?? '').slice(range.start.character),
    ...lines.slice(range.start.line + 1, range.end.line),
    (lines[range.end.line] ?? '').slice(0, range.end.character),
  ].join('\n');
}

describe('rangeOfRef', () => {
  it('covers exactly the declaration the graph recorded', () => {
    const text = fs.readFileSync(path.join(MINIMAL, VAULT), 'utf8');
    const record = nodesInFile(graph, VAULT).find((node) => node.name === '_record');
    expect(record).toBeDefined();

    const covered = slice(text, rangeOfRef(VAULT, text, (record as NonNullable<typeof record>).src));
    expect(covered.startsWith('function _record(uint256 amount) internal {')).toBe(true);
    expect(covered.trimEnd().endsWith('}')).toBe(true);
  });

  it('lands on the right characters in a multi-byte, CRLF file (§10)', async () => {
    const root = fixture('pathological');
    const built = await buildProjectGraph(root, { cacheDir: null, workers: 1, enrich: false });
    const file = 'src/Crlf.sol';
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(text.length);

    // Every declaration in the file, checked by reading back what the range
    // covers: a byte-offset implementation that counted characters instead
    // would be off by the number of multi-byte characters above it.
    const declarations = nodesInFile(built.graph, file).filter(
      (node) => node.kind === 'Function' || node.kind === 'Contract',
    );
    expect(declarations.length).toBeGreaterThan(0);

    for (const node of declarations) {
      const covered = slice(text, rangeOfRef(file, text, node.src));
      expect(covered).toContain(node.name);
      expect(covered.startsWith(node.kind === 'Contract' ? 'contract' : 'function')).toBe(true);
    }
  });

  it('clamps a range the file can no longer hold, rather than refusing to move', () => {
    const range = rangeOfRef('x.sol', 'contract A {}\n', { file: 'x.sol', offset: 9_000, length: 50, line: 1, column: 0 });
    expect(range.start).toEqual({ line: 1, character: 0 });
    expect(range.end).toEqual({ line: 1, character: 0 });
  });
});

describe('rangeOfSite', () => {
  it('is a caret at the call, in the editor’s 0-based convention', () => {
    // §10 records 1-based line and 0-based UTF-16 column, which is what the
    // editor wants — so the only conversion is the line.
    expect(rangeOfSite({ line: 37, column: 8 })).toEqual({
      start: { line: 36, character: 8 },
      end: { line: 36, character: 8 },
    });
  });

  it('does not go negative on a hand-edited graph', () => {
    expect(rangeOfSite({ line: 0, column: -3 }).start).toEqual({ line: 0, character: 0 });
  });
});
