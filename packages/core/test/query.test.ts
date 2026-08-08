/**
 * Phase 6's query API (§5's `query/`, §12's `axiomap query`).
 *
 * Expectations are derived by reading the fixture sources, as Phase 4's suite
 * established: `defi/` is five files and every count below was worked out from
 * them before the query was run. A test written the other way round pins
 * whatever the code currently does, and this module is the one both the CLI and
 * Phase 7's inspector will read through.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  callPath,
  externals,
  graphStats,
  reachableFrom,
  readersOf,
  requireNode,
  resolveNodeRef,
  selectView,
  traverse,
  unresolvedEdges,
  writersOf,
  NodeRefError,
  ViewError,
} from '../src/index.js';
import { graphOf, graphWithoutModeGating } from './graphs.js';
import { buildTempProject, cleanUpTempProjects } from './temp-project.js';

afterAll(cleanUpTempProjects);

const PAIR = 'src/Pair.sol:Pair';
const PAIR_MINT = 'src/Pair.sol:Pair.mint(address)';
const IPAIR_MINT = 'src/interfaces/IAmm.sol:IPair.mint(address)';
const ROUTER_ADD = 'src/Router.sol:Router.addLiquidity(address,address,uint256,uint256,address,uint256)';

describe('node references (§8 ids, typed by a human)', () => {
  it('resolves an exact id', async () => {
    const { graph } = await graphOf('defi');
    const result = resolveNodeRef(graph, PAIR_MINT);
    expect(result.found).toBe(true);
    if (result.found) expect(result.id).toBe(PAIR_MINT);
  });

  it('resolves a contract-qualified name without the parameter list', async () => {
    const { graph } = await graphOf('defi');
    const result = resolveNodeRef(graph, 'Pair.mint');
    expect(result.found).toBe(true);
    if (result.found) expect(result.id).toBe(PAIR_MINT);
  });

  it('refuses a bare name that several nodes answer to, and lists them', async () => {
    const { graph } = await graphOf('defi');
    // `mint` is declared on both `Pair` and `IPair`. Picking either would be
    // the "confidently wrong" answer §6 rules out — an auditor asking about
    // `mint` and silently being shown the interface has been misled.
    const result = resolveNodeRef(graph, 'mint');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe('ambiguous');
      expect(result.candidates).toContain(PAIR_MINT);
      expect(result.candidates).toContain(IPAIR_MINT);
    }
  });

  it('narrows by kind, which is what makes `writers-of reserve0` work', async () => {
    const { graph } = await graphOf('defi');
    const node = requireNode(graph, 'reserve0', { kinds: ['StateVariable'] });
    expect(node.kind).toBe('StateVariable');
    expect(node.id).toBe('src/Pair.sol:Pair.reserve0');
  });

  it('requireNode throws on an ambiguous reference rather than picking one', async () => {
    // A "do not guess" guard (§6). Phase 2's audit found these are where a bug
    // is worst, because the wrong answer arrives wearing confidence.
    const { graph } = await graphOf('defi');
    expect(() => requireNode(graph, 'mint')).toThrow(NodeRefError);
    try {
      requireNode(graph, 'mint');
    } catch (error) {
      expect((error as NodeRefError).candidates).toContain(PAIR_MINT);
      expect((error as Error).message).toContain('Name one of them exactly');
    }
  });

  it('suggests rather than guessing when nothing matches', async () => {
    const { graph } = await graphOf('defi');
    expect(() => requireNode(graph, 'depos1t')).toThrow(NodeRefError);
    try {
      requireNode(graph, 'Pair.mnt');
    } catch (error) {
      expect((error as Error).message).toContain('No node matches');
    }
  });
});

describe('traversal (§12 callers-of / callees-of / reachable-from / path)', () => {
  it('finds the direct caller of Pair.mint through the interface fan-out', async () => {
    const { graph } = await graphOf('defi');
    const callers = traverse(graph, PAIR_MINT, 'callers', { depth: 1 });

    // `Router.addLiquidity` calls `IPair(pair).mint(to)`. §10 gives that edge
    // the interface as its static target and every implementation in
    // `possibleTargets`, so following only the static edge would report
    // `Pair.mint` as having no callers at all — the same error
    // `analysis/reachability.ts` refuses to make.
    expect(callers.map((hit) => hit.id)).toEqual([ROUTER_ADD]);
    expect(callers[0]?.via.at(-1)?.virtual).toBe(true);
  });

  it('marks a static hop as not virtual', async () => {
    const { graph } = await graphOf('defi');
    const callees = traverse(graph, PAIR_MINT, 'callees', { depth: 1 });
    const update = callees.find((hit) => hit.id.endsWith('Pair._update(uint256,uint256)'));
    expect(update?.via.at(-1)?.virtual).toBe(false);
  });

  it('depth bounds the walk, and reachable-from does not', async () => {
    const { graph } = await graphOf('defi');
    const one = traverse(graph, ROUTER_ADD, 'callees', { depth: 1 });
    const all = traverse(graph, ROUTER_ADD, 'callees');
    expect(one.length).toBeLessThan(all.length);
    expect(one.every((hit) => hit.depth === 1)).toBe(true);
    expect(Math.max(...all.map((hit) => hit.depth))).toBeGreaterThan(1);
  });

  it('reports a shortest path, with the call site of every hop', async () => {
    const { graph } = await graphOf('defi');
    const path = callPath(graph, ROUTER_ADD, 'src/Pair.sol:Pair._update(uint256,uint256)');
    expect(path).not.toBeNull();
    expect(path?.length).toBe(2);
    // §10: an edge's `src` is the call site, not the callee's definition.
    for (const step of path ?? []) {
      expect(step.src.file).not.toBe('');
      expect(step.src.line).toBeGreaterThan(0);
    }
  });

  it('returns null rather than inventing a path that is not there', async () => {
    const { graph } = await graphOf('defi');
    expect(callPath(graph, 'src/Pair.sol:Pair._update(uint256,uint256)', ROUTER_ADD)).toBeNull();
  });

  it('reachable-from is the unbounded downstream closure', async () => {
    const { graph } = await graphOf('defi');
    expect(reachableFrom(graph, ROUTER_ADD)).toEqual(traverse(graph, ROUTER_ADD, 'callees'));
  });

  it('terminates on a recursive cycle', async () => {
    const built = await buildTempProject({
      'src/Loop.sol': `pragma solidity ^0.8.20;
contract Loop {
    function a() public { b(); }
    function b() public { a(); }
}
`,
    });
    const hits = traverse(built.graph, 'src/Loop.sol:Loop.a()', 'callees');
    expect(hits.map((hit) => hit.id)).toEqual(['src/Loop.sol:Loop.b()']);
  });
});

describe('state access (§11 "who can touch this")', () => {
  it('lists every writer of reserve0 with the guard the analysis found', async () => {
    const { graph } = await graphOf('defi');
    const writers = writersOf(graph, 'src/Pair.sol:Pair.reserve0');
    // Read from `src/Pair.sol`: `_update` is the only function that assigns to
    // `reserve0`; everything else reads it through `getReserves`.
    expect(writers.map((row) => row.function)).toEqual([
      'src/Pair.sol:Pair._update(uint256,uint256)',
    ]);
    expect(writers[0]?.count).toBe(1);

    const readers = readersOf(graph, 'src/Pair.sol:Pair.reserve0');
    expect(readers.length).toBeGreaterThan(1);
    expect(readers.map((row) => row.function)).toContain('src/Pair.sol:Pair.getReserves()');
  });
});

describe('externals (§15\'s third definition-of-done item)', () => {
  it('lists declared external surface, not everything reachable', async () => {
    const { graph } = await graphOf('defi');
    const all = externals(graph);
    // Declared `public`/`external`, excluding modifiers and constructors. An
    // internal helper reached from outside is `externallyReachable` but is not
    // callable directly, which is a different question.
    expect(all.every((row) => row.visibility === 'public' || row.visibility === 'external')).toBe(true);
    expect(all.some((row) => row.subkind === 'constructor')).toBe(false);
    expect(all.map((row) => row.id)).toContain(PAIR_MINT);
  });

  it('--unprotected keeps only state-mutating functions with no recognised guard', async () => {
    const { graph } = await graphOf('defi');
    const unguarded = externals(graph, { unprotected: true });
    expect(unguarded.every((row) => row.mutatesState)).toBe(true);
    expect(unguarded.every((row) => row.accessControl.confidence === 'none')).toBe(true);
    // A `view` getter with no guard is a getter, not a hole.
    expect(unguarded.some((row) => row.id.endsWith('getReserves()'))).toBe(false);
  });

  it("§13's accessControlModifiers is what makes a protocol's spelling recognisable", async () => {
    // `gated` is not in §13's default list, and `allowed[msg.sender]` mentions
    // the sender without comparing it, so
    // `checksSender` is false (Phase 4 restricted it to `==`/`!=` operands on
    // purpose) and this modifier is invisible to the analysis by default. That
    // is exactly the case §13's name list exists for: without the config the
    // function reports as unguarded, with it the guard is recognised.
    const source = `pragma solidity ^0.8.20;
contract Vault {
    mapping(address => bool) allowed;
    uint256 total;
    modifier gated() { require(allowed[msg.sender]); _; }
    function withdraw(uint256 amount) external gated { total -= amount; }
}
`;
    const built = await buildTempProject({ 'src/Vault.sol': source });
    expect(externals(built.graph, { unprotected: true }).map((row) => row.name)).toEqual([
      'withdraw',
    ]);

    const { applyAnalysis, analyseGraph } = await import('../src/index.js');
    applyAnalysis(
      built.file.nodes,
      analyseGraph(built.graph, { accessControlModifiers: ['gated'] }),
    );
    expect(externals(built.graph, { unprotected: true })).toEqual([]);
    expect(
      externals(built.graph).find((row) => row.name === 'withdraw')?.accessControl,
    ).toEqual({ modifiers: ['gated'], confidence: 'high' });
  });

  it('an unrecognised modifier that checks the sender is `low`, not `none`', async () => {
    // §11: "`low` confidence when the guard is an inline `require` rather than
    // a modifier". The middle value is evidence, not proof, and a function
    // carrying it is not on the unguarded list.
    const built = await buildTempProject({
      'src/Owned.sol': `pragma solidity ^0.8.20;
contract Owned {
    address owner;
    uint256 total;
    modifier mine() { require(msg.sender == owner); _; }
    function set(uint256 v) external mine { total = v; }
}
`,
    });
    const surface = externals(built.graph);
    expect(surface.find((row) => row.name === 'set')?.accessControl.confidence).toBe('low');
    expect(externals(built.graph, { unprotected: true })).toEqual([]);
  });
});

describe('unresolved (§4: a first-class answer, and §15\'s CI query)', () => {
  it('reports the low-level call in SafeTransfer with its category', async () => {
    const { graph } = await graphOf('defi');
    const rows = unresolvedEdges(graph);
    expect(rows.length).toBe(1);
    expect(rows[0]?.category).toBe('low-level');
    expect(rows[0]?.callee).toBe('call');
    expect(rows[0]?.from).toBe('src/libraries/AmmMath.sol:SafeTransfer.safeTransfer(address,address,uint256)');
  });

  it('groups pathological/ by category, which is what a CI gate watches', async () => {
    const { graph } = await graphWithoutModeGating('pathological');
    const categories = new Set(unresolvedEdges(graph).map((row) => row.category));
    // Phase 2 enumerated these: a function pointer, an encodeWithSelector
    // target, and a low-level call.
    expect(categories.has('low-level')).toBe(true);
    expect(categories.has('function-pointer')).toBe(true);
  });
});

describe('stats (§15\'s first two items)', () => {
  it('separates real contracts from scaffolding', async () => {
    const { graph, file } = await graphOf('defi');
    const stats = graphStats(graph, file);
    expect(stats.contracts.total).toBe(9);
    expect(stats.contracts.real + stats.contracts.test + stats.contracts.mock).toBeGreaterThanOrEqual(
      stats.contracts.total,
    );
    expect(stats.contracts.byKind['interface']).toBe(3);
    expect(stats.contracts.byKind['library']).toBe(2);
  });

  it('carries the mode and the score verbatim, since §4 makes them the headline', async () => {
    const { graph, file } = await graphOf('defi');
    const stats = graphStats(graph, file);
    expect(stats.mode).toBe(file.mode);
    expect(stats.score).toEqual(file.score);
    expect(stats.modeReason).toBe(file.modeReason);
  });
});

describe('views (§11, as selection only)', () => {
  it('protocol map is contracts, inheritance and rolled-up calls', async () => {
    const { graph } = await graphOf('defi');
    const view = selectView(graph, { view: 'protocol' });
    expect(view.nodes.every((node) => node.kind === 'Contract')).toBe(true);

    const rollups = view.edges.filter((edge) => edge.id.startsWith('rollup:'));
    expect(rollups.length).toBeGreaterThan(0);
    // A projection, so its ids cannot collide with real edge ids.
    expect(view.edges.filter((edge) => edge.kind === 'inherits').length).toBe(3);
    // Weighted by call-site count (§9 rule 3), and only as certain as its least
    // certain member.
    expect(rollups.every((edge) => edge.count >= 1)).toBe(true);
  });

  it('the call view refuses to draw without a focus (§9 rule 4)', async () => {
    const { graph } = await graphOf('defi');
    expect(() => selectView(graph, { view: 'call' })).toThrow(ViewError);
  });

  it('the call view honours §9\'s hop limits', async () => {
    const { graph } = await graphOf('defi');
    const near = selectView(graph, { view: 'call', focus: ROUTER_ADD, up: 0, down: 1 });
    const far = selectView(graph, { view: 'call', focus: ROUTER_ADD, up: 2, down: 3 });
    expect(near.nodes.length).toBeLessThan(far.nodes.length);
    expect(near.edges.every((edge) => edge.kind === 'calls' || edge.kind === 'creates')).toBe(true);
  });

  it('the state-access view is bipartite', async () => {
    const { graph } = await graphOf('defi');
    const view = selectView(graph, { view: 'state-access' });
    expect(view.edges.every((edge) => edge.kind === 'reads' || edge.kind === 'writes')).toBe(true);
    const kinds = new Set(view.nodes.map((node) => node.kind));
    expect([...kinds].sort()).toEqual(['Function', 'StateVariable']);
  });

  it('the contract view carries inherited members in the same selection', async () => {
    const { graph } = await graphOf('defi');
    const view = selectView(graph, { view: 'contract', focus: 'src/Pair.sol:Pair' });
    const ids = view.nodes.map((node) => node.id);
    expect(ids).toContain('src/Pair.sol:Pair');
    // `Pair is IPair, Shares` — §11 wants inherited members in a distinct tier,
    // which is the renderer's job; the selection has to contain them first.
    expect(ids).toContain('src/Pair.sol:Shares');
  });

  it('the inheritance tree carries member-level overrides, not just contracts', async () => {
    // §11: "C3 order, shadowed and overridden members flagged". The members are
    // the half this view got wrong once already: `overrides` and `implements`
    // are Function→Function (Phase 2), so a selection of Contract nodes alone
    // admits neither, and all seven of `defi/`'s `implements` edges silently
    // vanished. Silent is why this is pinned rather than trusted.
    const { graph } = await graphOf('defi');
    const view = selectView(graph, { view: 'inheritance' });

    const kinds = new Set(view.edges.map((edge) => edge.kind));
    expect(kinds.has('inherits')).toBe(true);
    expect(kinds.has('implements')).toBe(true);

    const members = view.edges.filter((edge) => edge.kind === 'implements');
    expect(members).toHaveLength(7);
    // Both endpoints of a member relation are in the selection, or a renderer
    // has an edge it cannot draw.
    const ids = new Set(view.nodes.map((node) => node.id));
    for (const edge of members) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
    // …and every member carries the contract it belongs to, which is how the
    // tree nests them without a `declares` edge in an inheritance view.
    for (const node of view.nodes) {
      if (node.kind === 'Function') expect(node.scope).not.toBeNull();
    }
  });

  it('the inheritance tree shows real `overrides` where a fixture has them', async () => {
    const { graph } = await graphOf('inheritance');
    const view = selectView(graph, { view: 'inheritance' });
    expect(view.edges.some((edge) => edge.kind === 'overrides')).toBe(true);
  });

  /**
   * This asserted the opposite until the contract view was asked for with a
   * function selected and answered with an error naming the contract it was
   * declining to open. Containment is exact, so resolving it is not a guess.
   */
  it('opens a member’s own contract rather than refusing the focus', async () => {
    const { graph } = await graphOf('defi');
    const view = selectView(graph, { view: 'contract', focus: PAIR_MINT });
    expect(view.nodes.some((node) => node.id === PAIR)).toBe(true);
    expect(view.note).toMatch(/opened from/);
  });

  it('rejects a focus that is inside no contract, with a usable message', async () => {
    const { graph } = await graphOf('defi');
    const unit = String(graph.findNode((_id, node) => node.kind === 'SourceUnit'));
    expect(() => selectView(graph, { view: 'contract', focus: unit })).toThrow(
      /needs a Contract or one of its members/,
    );
  });

  it('excludes test and mock scaffolding unless asked (§15\'s first item)', async () => {
    const built = await buildTempProject({
      'src/Real.sol': 'pragma solidity ^0.8.20;\ncontract Real { uint256 x; function f() public { x = 1; } }\n',
      'src/MockThing.sol': 'pragma solidity ^0.8.20;\ncontract MockThing { uint256 y; function g() public { y = 2; } }\n',
    });
    const without = selectView(built.graph, { view: 'protocol' });
    const with_ = selectView(built.graph, { view: 'protocol', includeTests: true });
    expect(with_.nodes.length).toBeGreaterThan(without.nodes.length);
    expect(without.nodes.map((node) => node.name)).not.toContain('MockThing');
  });
});

describe('structural mode gives an honest answer, not a blank one', () => {
  it('a call query over a structural graph reports nothing rather than failing', async () => {
    // `pathological/` builds in structural mode (§4), so there are no call
    // edges at all. The right answer to "who calls this" is then "nothing in
    // this graph", and `mode` is how a consumer knows why.
    const { graph, file } = await graphOf('pathological');
    expect(file.mode).toBe('structural');
    const anyFunction = graph.filterNodes((_id, node) => node.kind === 'Function')[0];
    expect(anyFunction).toBeDefined();
    expect(traverse(graph, anyFunction ?? '', 'callees')).toEqual([]);
  });

  /**
   * §4: the call graph "does not survive; disable the view with an explanation
   * and a prompt to build the project."
   *
   * It used to answer instead — the focus node, no edges, and a note reading
   * "1 functions within 2 up and 3 down of X". That is a confident wrong
   * answer about a graph that deliberately withheld the edges, and it is the
   * one place this tool drew a picture it could not stand behind.
   */
  it('refuses the call view outright rather than drawing one node and no edges', async () => {
    const { graph, file } = await graphOf('pathological');
    expect(file.mode).toBe('structural');
    const anyFunction = String(graph.filterNodes((_id, node) => node.kind === 'Function')[0]);

    let thrown: unknown;
    try {
      selectView(graph, { view: 'call', focus: anyFunction });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ViewError);
    // The explanation §4 asks for: what happened, why, and the way out.
    expect(String((thrown as Error).message)).toMatch(/no call edges/);
    expect(String((thrown as Error).message)).toMatch(/build-info|building the project/);
  });

  it('still draws the four views that do survive (§4)', async () => {
    const { graph } = await graphOf('pathological');
    for (const view of ['protocol', 'inheritance', 'state-access'] as const) {
      expect(() => selectView(graph, { view })).not.toThrow();
    }
    const contract = String(graph.filterNodes((_id, node) => node.kind === 'Contract')[0]);
    expect(() => selectView(graph, { view: 'contract', focus: contract })).not.toThrow();
  });

  it('the call view is unaffected on a graph that has call edges', async () => {
    const { graph } = await graphOf('defi');
    const view = selectView(graph, { view: 'call', focus: PAIR_MINT });
    expect(view.nodes.length).toBeGreaterThan(1);
  });
});
