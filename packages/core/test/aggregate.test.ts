/**
 * Phase 7's aggregation layer and render cap (§9 rules 2–4).
 *
 * Two kinds of test here, on purpose. The `defi/` cases are hand-derived from
 * the fixture's five files, the way Phase 4's and Phase 6's suites established
 * — a test written from whatever the code printed pins the bug as well as the
 * behaviour. The scale case is a synthesised 300-contract graph, because §7's
 * Phase 7 exit criterion is "usable on a 300-contract project" and the only
 * fixture that size is `large/`, which is generated rather than committed and
 * so is not there in CI.
 */

import { describe, expect, it } from 'vitest';

import {
  aggregate,
  graphFromFile,
  selectAggregatedView,
  selectView,
  DEFAULT_RENDER_CAP,
  RenderCapError,
  ViewError,
  type AggregatedView,
  type GraphEdge,
  type GraphFile,
  type GraphNode,
} from '../src/index.js';
import { graphOf } from './graphs.js';

const FACTORY = 'src/Factory.sol:Factory';
const PAIR = 'src/Pair.sol:Pair';
const ROUTER = 'src/Router.sol:Router';

function clusters(view: AggregatedView): Map<string, Extract<AggregatedView['nodes'][number], { type: 'cluster' }>> {
  const found = new Map<string, Extract<AggregatedView['nodes'][number], { type: 'cluster' }>>();
  for (const node of view.nodes) if (node.type === 'cluster') found.set(node.path, node);
  return found;
}

function drawnNodeIds(view: AggregatedView): string[] {
  return view.nodes.filter((node) => node.type === 'node').map((node) => node.id);
}

/**
 * Every call site in the selection is drawn, folded, or hidden inside exactly
 * one cluster — never dropped and never counted twice.
 *
 * This is the invariant the whole layer rests on: §9 rule 3 aggregates edges
 * "weighted by call count", and a weight that quietly loses a call site is a
 * number an auditor would read as evidence.
 */
function expectNoCallSiteLost(view: AggregatedView, selection: { edges: readonly GraphEdge[] }): void {
  const expected = selection.edges.reduce((sum, edge) => sum + edge.count, 0);
  let seen = 0;
  for (const edge of view.edges) seen += edge.type === 'edge' ? edge.edge.count : edge.count;
  for (const node of view.nodes) if (node.type === 'cluster') seen += node.internalEdges;
  expect(seen).toBe(expected);
}

describe('directory clustering (§9 rule 3)', () => {
  it('mirrors the fixture directory tree, with the repo-relative path as identity', async () => {
    const { graph } = await graphOf('defi');
    const view = aggregate(selectView(graph, { view: 'protocol' }));

    // `defi/` is src/*.sol plus src/interfaces/ and src/libraries/.
    expect([...clusters(view).keys()].sort()).toEqual(['src', 'src/interfaces', 'src/libraries']);
    const src = clusters(view).get('src');
    expect(src?.id).toBe('dir:src');
    expect(src?.parent).toBeNull();
    expect(clusters(view).get('src/libraries')?.parent).toBe('dir:src');
    // Nine contracts: Factory, Pair, Shares, Router, AmmMath, SafeTransfer and
    // three interfaces. `members` counts the whole subtree, so `src` has all of
    // them and `src/libraries` has AmmMath and SafeTransfer.
    expect(src?.members).toBe(9);
    expect(clusters(view).get('src/libraries')?.members).toBe(2);
  });

  it('draws a small project completely, and parents each contract by its directory', async () => {
    const { graph } = await graphOf('defi');
    const selection = selectView(graph, { view: 'protocol' });
    const view = aggregate(selection);

    expect(drawnNodeIds(view)).toHaveLength(selection.nodes.length);
    expect(view.collapsed).toEqual([]);
    expect(view.edges.every((edge) => edge.type === 'edge')).toBe(true);
    const pair = view.nodes.find((node) => node.id === PAIR);
    expect(pair?.type === 'node' && pair.parent).toBe('dir:src');
    const math = view.nodes.find((node) => node.id === 'src/libraries/AmmMath.sol:AmmMath');
    expect(math?.type === 'node' && math.parent).toBe('dir:src/libraries');
    expectNoCallSiteLost(view, selection);
  });

  it('collapses to one box when nothing is expanded, and counts what it hid', async () => {
    const { graph } = await graphOf('defi');
    const selection = selectView(graph, { view: 'protocol' });
    const view = aggregate(selection, { autoExpand: false });

    expect(view.nodes).toHaveLength(1);
    expect(view.edges).toEqual([]);
    // Every relation in `defi/` is inside src/, so all of them are internal and
    // the cluster is the only thing left to click.
    const src = clusters(view).get('src');
    expect(src?.expanded).toBe(false);
    expect(src?.internalEdges).toBe(
      selection.edges.reduce((sum, edge) => sum + edge.count, 0),
    );
    expect(view.note).toContain('expand one to drill in');
    expectNoCallSiteLost(view, selection);
  });

  it('drills down one level, lifting the rest to the clusters they are in', async () => {
    const { graph } = await graphOf('defi');
    const selection = selectView(graph, { view: 'protocol' });
    const view = aggregate(selection, { expand: ['src'], autoExpand: false });

    // src/ itself opens; its two subdirectories are drawn but still shut.
    expect(drawnNodeIds(view).sort()).toEqual([FACTORY, PAIR, 'src/Pair.sol:Shares', ROUTER]);
    expect(view.collapsed).toEqual(['src/interfaces', 'src/libraries']);

    // Pair calls AmmMath twice and SafeTransfer four times; both are in
    // src/libraries, so one lifted edge carries all six call sites and both
    // contributing edges.
    const lifted = view.edges.find((edge) => edge.id === `agg:calls:${PAIR}->dir:src/libraries`);
    expect(lifted?.type).toBe('aggregate');
    if (lifted?.type === 'aggregate') {
      expect(lifted.count).toBe(6);
      expect(lifted.pairs).toBe(2);
      expect(lifted.members).toHaveLength(2);
    }
    // Kinds do not merge: an inheritance relation into src/interfaces is a
    // separate element from the calls into it (§11's channel budget gives edge
    // colour to edge kind).
    expect(view.edges.some((edge) => edge.id === `agg:inherits:${PAIR}->dir:src/interfaces`)).toBe(true);
    expectNoCallSiteLost(view, selection);
  });

  it('implies the ancestors of an expanded directory', async () => {
    const { graph } = await graphOf('defi');
    const view = aggregate(selectView(graph, { view: 'protocol' }), {
      expand: ['src/libraries'],
      autoExpand: false,
    });
    expect(view.expanded).toEqual(['src', 'src/libraries']);
    expect(view.collapsed).toEqual(['src/interfaces']);
    expect(drawnNodeIds(view)).toContain('src/libraries/AmmMath.sol:SafeTransfer');
  });

  it('refuses a directory that is not in the view rather than silently ignoring it', async () => {
    const { graph } = await graphOf('defi');
    expect(() => aggregate(selectView(graph, { view: 'protocol' }), { expand: ['contracts'] }))
      .toThrow(ViewError);
    try {
      aggregate(selectView(graph, { view: 'protocol' }), { expand: ['contracts'] });
    } catch (error) {
      expect((error as Error).message).toContain('src/interfaces');
    }
  });

  it('folds the worst contributing resolution up, never the best', () => {
    // §4: an aggregate is only as certain as its least certain member, and
    // rounding that up is the flattery the confidence labels exist to refuse.
    // Two calls into one collapsed directory, one confident and one not.
    const file = syntheticProtocol(2, 1, 0);
    file.nodes.push(contractNode('lib/L.sol:L', 'lib/L.sol'));
    const [a, b] = [file.nodes[0]!.id, file.nodes[1]!.id];
    file.edges.push(
      { ...callEdge(a, 'lib/L.sol:L', 'src/m0/C0.sol'), resolution: 'semantic' },
      { ...callEdge(b, 'lib/L.sol:L', 'src/m0/C1.sol'), resolution: 'ambiguous' },
    );

    const selection = selectView(graphFromFile(file), { view: 'protocol' });
    const view = aggregate(selection, { expand: ['src'], autoExpand: false });
    const lifted = view.edges.filter((edge) => edge.type === 'aggregate');
    expect(lifted).toHaveLength(1);
    if (lifted[0]?.type === 'aggregate') {
      expect(lifted[0].to).toBe('dir:lib');
      expect(lifted[0].pairs).toBe(2);
      expect(lifted[0].resolution).toBe('ambiguous');
    }
    expectNoCallSiteLost(view, selection);
  });
});

describe('the render cap (§9 rule 2)', () => {
  it('defaults to 1,500', () => {
    expect(DEFAULT_RENDER_CAP).toBe(1500);
  });

  it('expands as far as the budget allows and stops, rather than erroring', async () => {
    const { graph } = await graphOf('defi');
    const selection = selectView(graph, { view: 'protocol' });

    // 18 elements is what opening src/ alone costs; opening src/interfaces on
    // top of it costs more than 20, so the cap stops there.
    const view = aggregate(selection, { renderCap: 20 });
    expect(view.elements).toBeLessThanOrEqual(20);
    expect(view.expanded).toEqual(['src']);
    expect(view.collapsed).toEqual(['src/interfaces', 'src/libraries']);
    expectNoCallSiteLost(view, selection);
  });

  it('errors on an explicit expansion that cannot be drawn, and says what to do', async () => {
    const { graph } = await graphOf('defi');
    const selection = selectView(graph, { view: 'protocol' });

    expect(() => aggregate(selection, { renderCap: 5, expand: ['src'] })).toThrow(RenderCapError);
    try {
      aggregate(selection, { renderCap: 5, expand: ['src'] });
    } catch (error) {
      const capped = error as RenderCapError;
      expect(capped.elements).toBe(18);
      expect(capped.cap).toBe(5);
      expect(capped.view).toBe('protocol');
      expect(capped.message).toContain('collapse a directory');
    }
  });

  it('phrases the way out in the vocabulary of the view being looked at', async () => {
    const { graph } = await graphOf('defi');
    try {
      selectAggregatedView(graph, {
        view: 'call',
        focus: ROUTER + '.addLiquidity(address,address,uint256,uint256,address,uint256)',
        renderCap: 1,
      });
      expect.unreachable('the call view should have hit the cap');
    } catch (error) {
      expect(error).toBeInstanceOf(RenderCapError);
      expect((error as Error).message).toContain('--up/--down');
    }

    try {
      selectAggregatedView(graph, { view: 'state-access', renderCap: 4 });
      expect.unreachable('the state-access view should have hit the cap');
    } catch (error) {
      expect((error as Error).message).toContain('focus a contract');
    }
  });

  it('names the view when an inheritance tree is too big to draw', async () => {
    const { graph } = await graphOf('inheritance');
    try {
      selectAggregatedView(graph, { view: 'inheritance', renderCap: 10 });
      expect.unreachable('the inheritance view should have hit the cap');
    } catch (error) {
      expect((error as Error).message).toContain('focus a single contract');
    }
  });

  it('refuses a selection whose edge has no node, rather than dropping the edge', async () => {
    // A "do not guess" guard (§6). `selectView` cannot produce this, but a
    // caller filtering a selection by hand can, and an edge silently vanishing
    // is the failure mode that looks like a resolver bug three phases later.
    const { graph } = await graphOf('defi');
    const selection = selectView(graph, { view: 'protocol' });
    const holed = {
      ...selection,
      nodes: selection.nodes.filter((node) => node.id !== PAIR),
    };
    expect(() => aggregate(holed, { autoExpand: false })).toThrow(ViewError);
    try {
      aggregate(holed, { autoExpand: false });
    } catch (error) {
      expect((error as Error).message).toContain(PAIR);
    }
  });

  it('leaves the four scoped views unclustered by directory, because a focus already scoped them', async () => {
    const { graph } = await graphOf('defi');
    const view = selectAggregatedView(graph, { view: 'contract', focus: PAIR });
    // No *directory* clusters: nothing of type `cluster`, and no `dir:` parent.
    expect(view.nodes.every((node) => node.type === 'node')).toBe(true);
    expect(
      view.nodes.every((node) => node.type === 'node' && !(node.parent ?? '').startsWith('dir:')),
    ).toBe(true);
    expect(view.edges.every((edge) => edge.type === 'edge')).toBe(true);
    expect(view.note).toBe(selectView(graph, { view: 'contract', focus: PAIR }).note);
  });

  /**
   * Containment is nesting, not an edge. A contract's members are compound
   * children of it, and the `declares` edge that said the same thing is gone —
   * on a real contract that was seven of nine edges, drawn as a star that ELK
   * lays out as one unreadable row.
   */
  it('nests a contract’s members inside it and drops the declares edges', async () => {
    const { graph } = await graphOf('defi');
    const view = selectAggregatedView(graph, { view: 'contract', focus: PAIR });

    const members = view.nodes.filter((node) => node.type === 'node' && node.parent === PAIR);
    expect(members.length).toBeGreaterThan(3);

    // Every drawn `declares` edge out of the focus is now expressed by nesting.
    const declares = view.edges.filter(
      (edge) => edge.type === 'edge' && edge.edge.kind === 'declares' && edge.from === PAIR,
    );
    expect(declares).toEqual([]);

    // The relations that are *not* containment survive untouched.
    const kinds = new Set(
      view.edges.flatMap((edge) => (edge.type === 'edge' ? [edge.edge.kind] : [])),
    );
    expect(kinds.has('declares')).toBe(false);
    expect(kinds.size).toBeGreaterThan(0);

    // `elements` counts what is drawn, so it fell with the edges.
    expect(view.elements).toBe(view.nodes.length + view.edges.length);
  });

  /**
   * Self-gating: `parent` is only set when the container is itself drawn, so a
   * view that never draws the contract is untouched. The state-access map is
   * the one that would break — ELK partitions it, and a nested node cannot be
   * in a partition of its own.
   */
  it('does not nest where the container is not drawn', async () => {
    const { graph } = await graphOf('defi');
    const view = selectAggregatedView(graph, { view: 'state-access', focus: PAIR });
    expect(view.nodes.every((node) => node.type === 'node' && node.parent === null)).toBe(true);
  });
});

// --- scale (§7's Phase 7 exit, decision #6) -----------------------------

const SITE = { file: 'src/a/A0.sol', offset: 0, length: 1, line: 1, column: 0 };

function contractNode(id: string, file: string): GraphNode {
  return {
    id,
    kind: 'Contract',
    name: id.slice(id.indexOf(':') + 1),
    file,
    scope: null,
    src: { ...SITE, file },
    contractKind: 'contract',
    baseNames: [],
    linearizedBases: [id],
    linearizationCertainty: 'certain',
    isFullyImplemented: true,
    isTest: false,
    isMock: false,
  };
}

function callEdge(from: string, to: string, file: string): GraphEdge {
  const src = { ...SITE, file };
  return {
    id: `${from}|${to}|calls|external`,
    kind: 'calls',
    subkind: 'external',
    from,
    to,
    resolution: 'heuristic',
    src,
    sites: [src],
    count: 1,
    possibleTargets: [],
  };
}

/**
 * 300 contracts over 12 directories, each calling six others — 2,100 elements
 * unaggregated, which is what decision #6 says nobody can read.
 *
 * Contract-level call edges rather than function-level ones: the protocol view
 * rolls calls up to their container either way, and a synthetic function per
 * contract would test the rollup `views.ts` already has a test for rather than
 * the clustering this file is about.
 */
/**
 * A project whose sources sit at its own root, which is what you get pointing
 * the tool at one directory rather than at a repo. Every file's directory is
 * `ROOT_DIR`, so there is exactly one cluster and its path is `.`.
 */
function rootLevelProject(): GraphFile {
  const nodes: GraphNode[] = [];
  const files: string[] = [];
  for (const name of ['Vault', 'Timelock', 'Base']) {
    const file = `${name}.sol`;
    files.push(file);
    nodes.push(contractNode(`${file}:${name}`, file));
  }
  const edges: GraphEdge[] = [callEdge(nodes[0]!.id, nodes[1]!.id, files[0]!)];

  return {
    schemaVersion: 4,
    generator: { name: 'axiomap', parser: 'synthetic', hashVersion: 1, compilers: [] },
    project: { kind: 'bare', sources: ['.'], files: nodes.length },
    mode: 'heuristic',
    modeReason: 'synthesised',
    score: {
      overall: { semantic: 0, heuristic: 1, ambiguous: 0, unresolved: 0, total: 1, confident: 1 },
      calls: { semantic: 0, heuristic: 1, ambiguous: 0, unresolved: 0, total: 1, confident: 1 },
      excludedFiles: 0,
    },
    diagnostics: [],
    nodes,
    edges,
  };
}

function syntheticProtocol(contracts = 300, dirs = 12, fanOut = 6): GraphFile {
  const nodes: GraphNode[] = [];
  const files: string[] = [];
  for (let i = 0; i < contracts; i += 1) {
    const file = `src/m${String(i % dirs)}/C${String(i)}.sol`;
    files.push(file);
    nodes.push(contractNode(`${file}:C${String(i)}`, file));
  }

  const edges: GraphEdge[] = [];
  for (let i = 0; i < contracts; i += 1) {
    for (let hop = 1; hop <= fanOut; hop += 1) {
      const target = (i + hop * 7) % contracts;
      if (target === i) continue;
      edges.push(callEdge(nodes[i]!.id, nodes[target]!.id, files[i]!));
    }
  }

  return {
    schemaVersion: 4,
    generator: { name: 'axiomap', parser: 'synthetic', hashVersion: 1, compilers: [] },
    project: { kind: 'foundry', sources: ['src'], files: contracts },
    mode: 'heuristic',
    modeReason: 'synthesised for a scale test',
    score: {
      overall: { semantic: 0, heuristic: edges.length, ambiguous: 0, unresolved: 0, total: edges.length, confident: 1 },
      calls: { semantic: 0, heuristic: edges.length, ambiguous: 0, unresolved: 0, total: edges.length, confident: 1 },
      excludedFiles: 0,
    },
    diagnostics: [],
    nodes,
    edges,
  };
}

describe('300 contracts (§7 Phase 7 exit, decision #6)', () => {
  const graph = graphFromFile(syntheticProtocol());

  it('does not fit unaggregated — which is the whole reason this layer exists', () => {
    const selection = selectView(graph, { view: 'protocol' });
    expect(selection.nodes).toHaveLength(300);
    expect(selection.nodes.length + selection.edges.length).toBeGreaterThan(DEFAULT_RENDER_CAP);
    expect(() => aggregate(selection, { cluster: false })).toThrow(RenderCapError);
  });

  it('fits under the cap once clustered, with every contract still reachable', () => {
    const selection = selectView(graph, { view: 'protocol' });
    const view = aggregate(selection);

    expect(view.elements).toBeLessThanOrEqual(DEFAULT_RENDER_CAP);
    expect(view.collapsed.length).toBeGreaterThan(0);

    // Nothing vanished: a contract is either drawn or inside a cluster that
    // says how many it holds, and the two sets partition the 300.
    const drawn = new Set(drawnNodeIds(view));
    const hidden = view.nodes
      .filter((node) => node.type === 'cluster' && !node.expanded)
      .reduce((sum, node) => sum + (node.type === 'cluster' ? node.members : 0), 0);
    expect(drawn.size + hidden).toBe(300);
    expectNoCallSiteLost(view, selection);
  });

  it('drills into one directory without redrawing the other eleven', () => {
    const selection = selectView(graph, { view: 'protocol' });
    const view = aggregate(selection, { expand: ['src/m3'], autoExpand: false });

    expect(view.expanded).toEqual(['src', 'src/m3']);
    // 25 contracts per directory, and only those.
    expect(drawnNodeIds(view)).toHaveLength(25);
    expect(drawnNodeIds(view).every((id) => id.startsWith('src/m3/'))).toBe(true);
    expect(view.elements).toBeLessThanOrEqual(DEFAULT_RENDER_CAP);
    expectNoCallSiteLost(view, selection);
  });
});

/**
 * Found by looking at a screenshot, which is the only way this kind of defect
 * is ever found: the box was drawn correctly and labelled with a full stop.
 */
describe('a project whose sources are at its root', () => {
  it('names the one cluster something a human can read, not "."', () => {
    const view = selectAggregatedView(graphFromFile(rootLevelProject()), { view: 'protocol' });
    const boxes = clusters(view);

    // One directory, so one cluster, and its path is still the honest `.`.
    expect([...boxes.keys()]).toEqual(['.']);
    const root = boxes.get('.')!;
    expect(root.path).toBe('.');
    // The label is what a renderer draws on the box. A bare `.` is one pixel
    // and reads as a rendering artifact rather than as a name.
    expect(root.label).not.toBe('.');
    expect(root.label).toBe('(project root)');
  });
});
