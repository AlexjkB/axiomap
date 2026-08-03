/**
 * The graph artifact itself: schema, determinism, hashes, and the three
 * degradation modes.
 *
 * `graph.json` is a public artifact (§3) and the input to diff (§8), so the
 * properties asserted here are contract, not implementation detail: a stable
 * byte-for-byte serialization, a refusal to load a mismatched version, and
 * hashes that change when behaviour changes and only then.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildProjectGraph,
  describeScore,
  getHasher,
  GRAPH_SCHEMA_VERSION,
  GraphSchemaError,
  hashBody,
  hashInterface,
  parseGraph,
  readGraph,
  scoreEdges,
  selectMode,
  serializeGraph,
  writeGraph,
  type GraphFile,
  type ResolutionScore,
} from '../src/index.js';
import { fixture } from './fixtures.js';
import { graphOf, graphWithoutModeGating } from './graphs.js';

const temporaryDirs: string[] = [];

function temporaryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-graph-'));
  temporaryDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('serialization', () => {
  it('round-trips through parseGraph', async () => {
    const { file } = await graphOf('minimal');
    const parsed = parseGraph(serializeGraph(file));
    expect(parsed.nodes).toHaveLength(file.nodes.length);
    expect(parsed.edges).toHaveLength(file.edges.length);
    expect(parsed.mode).toBe(file.mode);
  });

  it('is byte-identical across two independent builds', async () => {
    const first = await buildProjectGraph(fixture('minimal'), { cacheDir: null, workers: 1 });
    const second = await buildProjectGraph(fixture('minimal'), { cacheDir: null, workers: 1 });
    expect(serializeGraph(second.file)).toBe(serializeGraph(first.file));
  });

  it('ends with a trailing newline and uses two-space indent', async () => {
    const { file } = await graphOf('minimal');
    const text = serializeGraph(file);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "schemaVersion": 1,');
  });

  it('refuses a graph written by a different schema version', () => {
    const stale = JSON.stringify({ schemaVersion: GRAPH_SCHEMA_VERSION + 1, nodes: [], edges: [] });
    expect(() => parseGraph(stale, 'stale.json')).toThrow(GraphSchemaError);
    expect(() => parseGraph(stale, 'stale.json')).toThrow(/schemaVersion/);
  });

  it('refuses a graph whose shape does not match the schema', async () => {
    const { file } = await graphOf('minimal');
    const broken = JSON.parse(serializeGraph(file)) as { nodes: { kind: string }[] };
    broken.nodes[0] = { kind: 'NotAKind' };
    expect(() => parseGraph(JSON.stringify(broken), 'broken.json')).toThrow(GraphSchemaError);
  });

  it('writes and reads a file', async () => {
    const { file } = await graphOf('minimal');
    const target = path.join(temporaryDir(), '.axiomap', 'graph.json');
    writeGraph(target, file);
    expect(readGraph(target).nodes).toHaveLength(file.nodes.length);
  });

  it('prints §4\'s one-line resolution score', async () => {
    const { file } = await graphOf('defi');
    expect(describeScore(file)).toMatch(
      /^\d+ edges — \d+% semantic, \d+% heuristic, \d+% ambiguous, \d+% unresolved$/,
    );
  });
});

describe('body and interface hashes', () => {
  const source = (body: string): string => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract H {
    uint256 public total;

    function f(uint256 a) public ${body}
}
`;

  async function functionNode(body: string, id = 'src/H.sol:H.f(uint256)'): Promise<{
    bodyHash: string;
    interfaceHash: string;
  }> {
    const root = temporaryDir();
    fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\nsrc = "src"\n');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'H.sol'), source(body), 'utf8');
    const { file } = await buildProjectGraph(root, { cacheDir: null, workers: 1 });
    const node = file.nodes.find((n) => n.id === id);
    if (node?.kind !== 'Function') throw new Error(`no function node ${id}`);
    return { bodyHash: node.bodyHash, interfaceHash: node.interfaceHash };
  }

  it('ignores reformatting and comments', async () => {
    const plain = await functionNode('{ total += a; }');
    const reformatted = await functionNode(`{
        // a comment that changes nothing
        total   +=    a;
    }`);
    expect(reformatted.bodyHash).toBe(plain.bodyHash);
  });

  it('changes when a statement changes', async () => {
    const plain = await functionNode('{ total += a; }');
    const changed = await functionNode('{ total -= a; }');
    expect(changed.bodyHash).not.toBe(plain.bodyHash);
  });

  it('changes when a local is renamed, because behaviour might follow', async () => {
    const plain = await functionNode('{ uint256 b = a; total += b; }');
    const renamed = await functionNode('{ uint256 c = a; total += c; }');
    expect(renamed.bodyHash).not.toBe(plain.bodyHash);
  });

  it('separates an interface change from a body change', async () => {
    const plain = await functionNode('{ total += a; }');
    const bodyChanged = await functionNode('{ total -= a; }');
    // Body differs, interface does not — a re-review trigger, not a break.
    expect(bodyChanged.interfaceHash).toBe(plain.interfaceHash);
  });

  it('changes the interface hash when modifier order changes', async () => {
    const hasher = await getHasher();
    const base = {
      name: 'f',
      subkind: 'function',
      visibility: 'external',
      stateMutability: 'nonpayable',
      params: ['uint256'],
      returns: [],
    };
    const one = hashInterface(hasher, { ...base, modifiers: ['nonReentrant', 'onlyOwner'] });
    const two = hashInterface(hasher, { ...base, modifiers: ['onlyOwner', 'nonReentrant'] });
    expect(one).not.toBe(two);
  });

  it('normalises declared parameter types before hashing', async () => {
    const hasher = await getHasher();
    const base = {
      name: 'f',
      subkind: 'function',
      visibility: 'external',
      stateMutability: 'nonpayable',
      returns: [],
      modifiers: [],
    };
    expect(hashInterface(hasher, { ...base, params: ['uint256[ ]'] })).toBe(
      hashInterface(hasher, { ...base, params: ['uint256[]'] }),
    );
  });

  it('hashes an empty body deterministically', async () => {
    const hasher = await getHasher();
    expect(hashBody(hasher, [])).toBe(hashBody(hasher, []));
    expect(hashBody(hasher, [])).not.toBe(hashBody(hasher, ['{', '}']));
  });
});

describe('degradation modes', () => {
  function score(partial: Partial<ResolutionScore['calls']>): ResolutionScore {
    const calls = {
      semantic: 0,
      heuristic: 0,
      ambiguous: 0,
      unresolved: 0,
      total: 0,
      confident: 1,
      ...partial,
    };
    return { overall: calls, calls, excludedFiles: 0 };
  }

  it('selects heuristic mode at or above the threshold', () => {
    expect(selectMode(score({ total: 10, heuristic: 7, confident: 0.7 }), 0.7).mode).toBe(
      'heuristic',
    );
  });

  it('selects structural mode below the threshold, and says why', () => {
    const decision = selectMode(score({ total: 10, heuristic: 6, confident: 0.6 }), 0.7);
    expect(decision.mode).toBe('structural');
    expect(decision.reason).toMatch(/withheld rather than drawn sparse/);
  });

  it('selects full mode as soon as any edge is compiler-certain', () => {
    const withSemantic = score({ total: 10, semantic: 10, confident: 1 });
    expect(selectMode(withSemantic).mode).toBe('full');
  });

  it('drops call edges in structural mode but keeps the other four views', async () => {
    const { file } = await graphOf('pathological');
    expect(file.mode).toBe('structural');
    expect(file.edges.some((e) => e.kind === 'calls' || e.kind === 'creates')).toBe(false);
    // §4: contracts, members and state access all survive. (`pathological/`
    // declares no inheritance at all, so `inherits` is checked on `minimal/`.)
    for (const kind of ['declares', 'reads', 'writes', 'emits', 'modifiedBy']) {
      expect(file.edges.some((e) => e.kind === kind)).toBe(true);
    }
  });

  it('keeps the score honest about the call edges it withheld', async () => {
    const { file } = await graphOf('pathological');
    expect(file.score.calls.total).toBeGreaterThan(0);
    expect(file.score.calls.confident).toBeLessThan(0.7);
  });

  it('drops synthetic unresolved nodes left orphaned by structural mode', async () => {
    const { file } = await graphOf('pathological');
    const synthetic = file.nodes.filter((n) => n.kind === 'Unresolved');
    const referenced = new Set(file.edges.flatMap((e) => [e.from, e.to]));
    for (const node of synthetic) expect(referenced.has(node.id)).toBe(true);
  });
});

describe('graphology model', () => {
  it('exposes every node and edge, keyed by id', async () => {
    const { graph, file } = await graphOf('defi');
    expect(graph.order).toBe(file.nodes.length);
    expect(graph.size).toBe(file.edges.length);
    expect(graph.hasNode('src/Pair.sol:Pair')).toBe(true);
    for (const edge of file.edges) expect(graph.hasEdge(edge.id)).toBe(true);
  });

  it('supports parallel edges of different kinds between the same pair', async () => {
    const { graph } = await graphOf('minimal');
    const from = 'src/Token.sol:Token.mint(address,uint256)';
    const to = 'src/Token.sol:Token.balanceOf';
    const kinds = graph
      .edges(from, to)
      .map((key) => graph.getEdgeAttributes(key).kind)
      .sort();
    expect(kinds).toEqual(['reads', 'writes']);
  });
});

describe('scoring', () => {
  it('excludes containment edges from the score', async () => {
    const { file } = await graphOf('minimal');
    const declares = file.edges.filter((e) => e.kind === 'declares');
    expect(declares.length).toBeGreaterThan(0);
    expect(scoreEdges({ edges: declares, excludedFiles: new Set() }).overall.total).toBe(0);
  });

  it('weights a collapsed edge by its call-site count', async () => {
    const { file } = await graphWithoutModeGating('minimal');
    const weighted = file.edges
      .filter((e) => e.kind !== 'declares')
      .reduce((sum, e) => sum + e.count, 0);
    expect(file.score.overall.total).toBe(weighted);
  });

  it('never reports semantic edges before the enrichment tier exists', async () => {
    for (const name of ['minimal', 'inheritance', 'defi', 'pathological'] as const) {
      const { file } = await graphOf(name);
      expect(file.score.overall.semantic).toBe(0);
      expect(file.mode).not.toBe('full');
    }
  });
});

describe('the artifact is portable', () => {
  it('contains no absolute paths', async () => {
    for (const name of ['minimal', 'defi', 'pathological'] as const) {
      const { file } = await graphOf(name);
      const text: string = serializeGraph(file);
      expect(text).not.toContain(process.cwd());
      expect(text).not.toMatch(/"[^"]*\/home\//);
    }
  });

  it('records the hash version, so a review-invalidating change is visible', async () => {
    const { file } = await graphOf('minimal');
    expect(file.generator.hashVersion).toBeGreaterThan(0);
    expect(file.generator.parser).toBe('treesitter');
  });
});

/** Guards the assumption the golden suite rests on. */
function assertSorted(values: readonly string[]): void {
  const sorted = [...values].sort();
  expect(values).toEqual(sorted);
}

describe('ordering', () => {
  it('sorts nodes and edges by id', async () => {
    const { file }: { file: GraphFile } = await graphOf('defi');
    assertSorted(file.nodes.map((n) => n.id));
    assertSorted(file.edges.map((e) => e.id));
  });
});
