/**
 * Phase 4's analysis passes, against hand-verified fixture output.
 *
 * Every expectation below was derived by **reading the fixture sources** and
 * working out what the answer has to be, then written down here — not by
 * running the pass and recording what it said. A test written the other way
 * round pins the bug along with the behaviour, and these three passes are the
 * ones §12's `query` surface and §15's definition of done are built on.
 *
 * `pathological/` is asserted twice, because it is the one fixture that falls
 * below §4's mode threshold: once ungated, where the call edges exist, and once
 * as it really builds, in structural mode with no call graph at all.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  analyseGraph,
  classifyExternalCalls,
  computeAccessControl,
  computeReachability,
  graphFromFile,
  parseGraph,
  serializeGraph,
  type AccessControl,
} from '../src/index.js';
import { graphOf, graphWithoutModeGating } from './graphs.js';
import { buildTempProject, cleanUpTempProjects } from './temp-project.js';

afterAll(cleanUpTempProjects);

/** Ids of the functions whose `accessControl` is anything but `none`. */
function guardedFunctions(map: ReadonlyMap<string, AccessControl>): Record<string, AccessControl> {
  const out: Record<string, AccessControl> = {};
  for (const [id, access] of map) {
    if (access.confidence !== 'none' || access.modifiers.length > 0) out[id] = access;
  }
  return out;
}

// ---------------------------------------------------------------------------
// pathological/ — the fixture §7 names in Phase 4's exit criteria
// ---------------------------------------------------------------------------

/**
 * Every `public`/`external` function, fallback and receive with a body, on a
 * deployable contract. Read off the ten source files in `fixtures/pathological/src`.
 *
 * Excluded, each for a stated reason:
 * - `DoesNotCompile.identity`, `Indirect.double`, `Indirect.triple` — internal.
 * - `IThing.work` — an interface declaration, no body, and `IThing` is nobody's base.
 * - `Legacy.constructor`, `Proxy.constructor` — constructors run at deployment.
 * - `Legacy#onlyOwner` — a modifier.
 * - `Broken.truncated` — the recovered parse could not read a visibility.
 */
const PATHOLOGICAL_ENTRYPOINTS = [
  'src/Assembly.sol:Assembly.codeSize(address)',
  'src/Assembly.sol:Assembly.counted(uint256)',
  'src/Assembly.sol:Assembly.destroy(address payable)',
  'src/Assembly.sol:Assembly.readSlot(uint256)',
  'src/Assembly.sol:Assembly.writeRaw(uint256,bytes32)',
  'src/BadImport.sol:BadImport.poke()',
  'src/Crlf.sol:Crlf.get()',
  'src/Crlf.sol:Crlf.set(uint256)',
  'src/DoesNotCompile.sol:DoesNotCompile.alsoBroken()',
  'src/DoesNotCompile.sol:DoesNotCompile.broken()',
  'src/DoesNotCompile.sol:DoesNotCompile.increment()',
  'src/DoesNotCompile.sol:DoesNotCompile.noReturn()',
  'src/Indirect.sol:Indirect.apply_(uint256)',
  'src/Indirect.sol:Indirect.choose(bool)',
  'src/Indirect.sol:Indirect.guarded(uint256)',
  'src/Indirect.sol:Indirect.pick(address)',
  'src/Indirect.sol:Indirect.pick(uint256)',
  'src/Indirect.sol:Indirect.raw(bytes4,uint256)',
  'src/Legacy.sol:Legacy.add(uint256)',
  'src/Proxy.sol:Implementation.mint(uint256)',
  'src/Proxy.sol:Proxy.fallback()',
  'src/Proxy.sol:Proxy.receive()',
  'src/Proxy.sol:Proxy.upgradeTo(address)',
  'src/SyntaxError.sol:AfterTheError.stillHere()',
  'src/SyntaxError.sol:BeforeTheError.fine()',
  'src/SyntaxError.sol:Broken.afterTheError()',
  'src/dup-a/Duplicate.sol:Duplicate.whoAmI()',
  'src/dup-b/Duplicate.sol:Duplicate.claim()',
  'src/dup-b/Duplicate.sol:Duplicate.whoAmI()',
];

describe('pathological/ — reachability', () => {
  it('finds every entrypoint and no others', async () => {
    const { graph } = await graphWithoutModeGating('pathological');
    expect(computeReachability(graph).entrypoints).toEqual(PATHOLOGICAL_ENTRYPOINTS);
  });

  it('reaches the four non-entrypoints that a caller reaches, and no more', async () => {
    const { graph } = await graphWithoutModeGating('pathological');
    const { byFunction } = computeReachability(graph);

    const reached = [...byFunction]
      .filter(([id, r]) => r.externallyReachable && !PATHOLOGICAL_ENTRYPOINTS.includes(id))
      .map(([id, r]) => [id, r.entrypoints]);

    // `identity` is called by `alsoBroken`; `IThing.work` by `Indirect.guarded`
    // through `IThing(target).work(x)`; `onlyOwner` runs because `add` is
    // modified by it. Nothing else in this fixture is called by anything.
    expect(reached).toEqual([
      [
        'src/DoesNotCompile.sol:DoesNotCompile.identity(uint256)',
        ['src/DoesNotCompile.sol:DoesNotCompile.alsoBroken()'],
      ],
      ['src/Indirect.sol:IThing.work(uint256)', ['src/Indirect.sol:Indirect.guarded(uint256)']],
      ['src/Legacy.sol:Legacy#onlyOwner', ['src/Legacy.sol:Legacy.add(uint256)']],
    ]);
  });

  it('leaves the unreachable unreachable', async () => {
    const { graph } = await graphWithoutModeGating('pathological');
    const { byFunction } = computeReachability(graph);

    // `choose` assigns `double`/`triple` to a function pointer — that is an
    // identifier use, not a call, and there is no edge to follow. The two
    // constructors are reachable only through a `creates` edge, and nothing in
    // this fixture deploys anything. `truncated` is not callable as parsed.
    for (const id of [
      'src/Indirect.sol:Indirect.double(uint256)',
      'src/Indirect.sol:Indirect.triple(uint256)',
      'src/Legacy.sol:Legacy.constructor()',
      'src/Proxy.sol:Proxy.constructor(address)',
      'src/SyntaxError.sol:Broken.truncated(uint256)',
    ]) {
      expect(byFunction.get(id), id).toEqual({ externallyReachable: false, entrypoints: [] });
    }
  });

  it('in structural mode, reaches the entrypoints and whatever modifies them', async () => {
    // The real build of this fixture: 50% of call edges resolve, under §4's
    // 70% threshold, so `calls` and `creates` are dropped entirely. Nothing
    // propagates. `modifiedBy` survives, so `onlyOwner` still runs.
    const { graph, file } = await graphOf('pathological');
    expect(file.mode).toBe('structural');

    const { entrypoints, byFunction } = computeReachability(graph);
    expect(entrypoints).toEqual(PATHOLOGICAL_ENTRYPOINTS);

    const reachable = [...byFunction]
      .filter(([, r]) => r.externallyReachable)
      .map(([id]) => id)
      .sort();
    expect(reachable).toEqual([...PATHOLOGICAL_ENTRYPOINTS, 'src/Legacy.sol:Legacy#onlyOwner'].sort());
  });
});

describe('pathological/ — access control', () => {
  it('finds one recognised modifier and two inline sender checks', async () => {
    const { graph } = await graphWithoutModeGating('pathological');

    // `Legacy.add` carries `onlyOwner`, which is in §13's default list.
    // `Legacy#onlyOwner` and `Proxy.upgradeTo` each `require(msg.sender == ...)`
    // inline — evidence, not a recognised guard, so `low`.
    //
    // Everything else is `none`, including three functions that *mention*
    // `msg.sender` without comparing it: `Legacy.constructor` and
    // `Proxy.constructor` assign it, `Implementation.mint` indexes with it, and
    // `Duplicate.claim` assigns it — that last one is genuinely unprotected.
    expect(guardedFunctions(computeAccessControl(graph))).toEqual({
      'src/Legacy.sol:Legacy.add(uint256)': { modifiers: ['onlyOwner'], confidence: 'high' },
      'src/Legacy.sol:Legacy#onlyOwner': { modifiers: [], confidence: 'low' },
      'src/Proxy.sol:Proxy.upgradeTo(address)': { modifiers: [], confidence: 'low' },
    });
  });

  it('drops to low when the configured list no longer recognises onlyOwner', async () => {
    const { graph } = await graphWithoutModeGating('pathological');
    const map = computeAccessControl(graph, { accessControlModifiers: ['auth'] });

    // The modifier is still there and still checks the sender — the tool just
    // no longer recognises its name, which is exactly what `low` means.
    expect(map.get('src/Legacy.sol:Legacy.add(uint256)')).toEqual({
      modifiers: ['onlyOwner'],
      confidence: 'low',
    });
  });
});

describe('pathological/ — external calls', () => {
  it('classifies each call edge by whether control leaves the contract', async () => {
    const { graph } = await graphWithoutModeGating('pathological');
    const { byEdge } = classifyExternalCalls(graph);

    const external = [...byEdge]
      .filter(([, klass]) => klass !== 'internal')
      .map(([id, klass]) => `${klass} ${id}`)
      .sort();

    // `poke` reads a public getter on another contract; `guarded` calls through
    // `IThing`; `raw` is a `.call`. The function-pointer and not-found edges
    // are internal calls whose target happens to be unknown, which is not the
    // same thing as leaving the contract.
    expect(external).toEqual([
      'external src/BadImport.sol:BadImport.poke()|src/Assembly.sol:Assembly.slot0|calls|external',
      'external src/Indirect.sol:Indirect.guarded(uint256)|src/Indirect.sol:IThing.work(uint256)|calls|external',
      'external src/Indirect.sol:Indirect.raw(bytes4,uint256)|?low-level:call|calls|lowlevel',
    ]);
  });

  it('finds no reentrancy shape, because no external call here is followed by a write', async () => {
    const { graph } = await graphWithoutModeGating('pathological');
    const { byFunction } = classifyExternalCalls(graph);

    // The three external callers write nothing after the call: `poke` and
    // `guarded` write nothing at all, and `raw` only reads `target`.
    // `Proxy.fallback` delegatecalls, but from inside `assembly` — a flag with
    // no call site, so there is no offset to order a write against.
    const flagged = [...byFunction].filter(([, f]) => f.reentrancy.externalCallThenWrite);
    expect(flagged).toEqual([]);
    expect([...byFunction].filter(([, f]) => f.reentrancy.guarded)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// defi/ — the fixture with real cross-contract structure
// ---------------------------------------------------------------------------

const DEFI_ENTRYPOINTS = [
  'src/Factory.sol:Factory.allPairsLength()',
  'src/Factory.sol:Factory.createPair(address,address)',
  'src/Factory.sol:Factory.getPair(address,address)',
  'src/Factory.sol:Factory.setFeeSetter(address)',
  'src/Pair.sol:Pair.burn(address)',
  'src/Pair.sol:Pair.getReserves()',
  'src/Pair.sol:Pair.initialize(address,address)',
  'src/Pair.sol:Pair.mint(address)',
  'src/Pair.sol:Pair.swap(uint256,uint256,address)',
  'src/Router.sol:Router.addLiquidity(address,address,uint256,uint256,address,uint256)',
  'src/Router.sol:Router.getAmountOut(address,address,uint256)',
  'src/Router.sol:Router.quote(uint256,uint256,uint256)',
  'src/Router.sol:Router.removeLiquidity(address,address,address,uint256)',
  'src/Router.sol:Router.swapExactTokensForTokens(address,address,uint256,uint256,address,uint256)',
];

describe('defi/ — reachability', () => {
  it('finds every entrypoint and no others', async () => {
    const { graph } = await graphOf('defi');
    // The interfaces declare no bodies, `Shares` is abstract with two internal
    // members, and both libraries are internal throughout.
    expect(computeReachability(graph).entrypoints).toEqual(DEFI_ENTRYPOINTS);
  });

  it('reaches a constructor through the `creates` edge that deploys it', async () => {
    const { graph } = await graphOf('defi');
    const { byFunction } = computeReachability(graph);

    // `Factory.createPair` does `new Pair{salt: salt}()`. The edge lands on the
    // Pair *contract*; what actually runs is `Pair.constructor`.
    expect(byFunction.get('src/Pair.sol:Pair.constructor()')).toEqual({
      externallyReachable: true,
      entrypoints: ['src/Factory.sol:Factory.createPair(address,address)'],
    });
    // Nothing deploys a Factory or a Router.
    expect(
      byFunction.get('src/Factory.sol:Factory.constructor(address)')?.externallyReachable,
    ).toBe(false);
    expect(byFunction.get('src/Router.sol:Router.constructor(address)')?.externallyReachable).toBe(
      false,
    );
  });

  it('reaches an implementation through the interface a caller uses', async () => {
    const { graph } = await graphOf('defi');
    const { byFunction } = computeReachability(graph);

    // `Router.addLiquidity` calls `IPair(pair).mint(to)`. The static target is
    // the interface function; `possibleTargets` carries `Pair.mint`, and
    // dropping that would report a live implementation as unreachable.
    expect(byFunction.get('src/Pair.sol:Pair.mint(address)')?.entrypoints).toEqual([
      'src/Pair.sol:Pair.mint(address)',
      'src/Router.sol:Router.addLiquidity(address,address,uint256,uint256,address,uint256)',
    ]);
  });

  it('reaches a private helper from every entrypoint that calls it', async () => {
    const { graph } = await graphOf('defi');
    const { byFunction } = computeReachability(graph);

    // `_update` is private and called by all three of `mint`, `burn`, `swap` —
    // each of which is also reachable from the Router through `IPair`.
    expect(byFunction.get('src/Pair.sol:Pair._update(uint256,uint256)')?.entrypoints).toEqual([
      'src/Pair.sol:Pair.burn(address)',
      'src/Pair.sol:Pair.mint(address)',
      'src/Pair.sol:Pair.swap(uint256,uint256,address)',
      'src/Router.sol:Router.addLiquidity(address,address,uint256,uint256,address,uint256)',
      'src/Router.sol:Router.removeLiquidity(address,address,address,uint256)',
      'src/Router.sol:Router.swapExactTokensForTokens(address,address,uint256,uint256,address,uint256)',
    ]);
  });
});

describe('defi/ — access control and reentrancy', () => {
  it('finds the two functions that check msg.sender and nothing else', async () => {
    const { graph } = await graphOf('defi');

    // `Factory.setFeeSetter` and `Pair.initialize` both open with
    // `if (msg.sender != x) revert Forbidden();`. Neither uses a modifier, and
    // nothing in this fixture uses a name from §13's default list — `lock` and
    // `ensure` are modifiers but not access control, and must not raise the
    // confidence of the functions carrying them.
    expect(guardedFunctions(computeAccessControl(graph))).toEqual({
      'src/Factory.sol:Factory.setFeeSetter(address)': { modifiers: [], confidence: 'low' },
      'src/Pair.sol:Pair.initialize(address,address)': { modifiers: [], confidence: 'low' },
    });
  });

  it('finds the four external-call-then-write shapes', async () => {
    const { graph } = await graphOf('defi');
    const { byFunction } = classifyExternalCalls(graph);

    // - `Factory.createPair` calls `IPair(pair).initialize(...)` and then
    //   writes `pairs[token0][token1]`.
    // - `Pair.mint` reads balances over `IERC20Minimal`, then `_mintShares`.
    // - `Pair.burn` the same, then `_burnShares` and `_update`.
    // - `Pair.swap` transfers out through `SafeTransfer` — which bottoms out in
    //   `token.call(...)` — and then `_update` writes the reserves.
    //
    // In three of the four the write is a helper's, not this body's, which is
    // why the pass closes over calls in both directions.
    const flagged = [...byFunction]
      .filter(([, f]) => f.reentrancy.externalCallThenWrite)
      .map(([id]) => id)
      .sort();
    expect(flagged).toEqual([
      'src/Factory.sol:Factory.createPair(address,address)',
      'src/Pair.sol:Pair.burn(address)',
      'src/Pair.sol:Pair.mint(address)',
      'src/Pair.sol:Pair.swap(uint256,uint256,address)',
    ]);
  });

  it('reports the three guarded ones as unguarded until `lock` is configured', async () => {
    const { graph } = await graphOf('defi');

    // §13's default `reentrancyGuards` is `["nonReentrant"]`, and this fixture
    // spells its mutex `lock`. Reporting `guarded: false` is the honest answer
    // for a name the tool was not told about — and this is what §13's knob is
    // for. `Factory.createPair` has no guard under either configuration.
    const defaults = classifyExternalCalls(graph).byFunction;
    expect([...defaults].filter(([, f]) => f.reentrancy.guarded)).toEqual([]);

    const configured = classifyExternalCalls(graph, { reentrancyGuards: ['lock'] }).byFunction;
    const guarded = [...configured]
      .filter(([, f]) => f.reentrancy.guarded)
      .map(([id]) => id)
      .sort();
    expect(guarded).toEqual([
      'src/Pair.sol:Pair.burn(address)',
      'src/Pair.sol:Pair.mint(address)',
      'src/Pair.sol:Pair.swap(uint256,uint256,address)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The rules themselves, on inputs small enough to check by eye
// ---------------------------------------------------------------------------

describe('the ordering rule', () => {
  it('is an ordering rule, not a co-occurrence one', async () => {
    const { graph } = await buildTempProject({
      'src/Order.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IToken { function transfer(address to, uint256 v) external returns (bool); }

contract Order {
    uint256 public balance;
    IToken public token;

    function effectsFirst(address to, uint256 v) external {
        balance = 0;
        token.transfer(to, v);
    }

    function interactionsFirst(address to, uint256 v) external {
        token.transfer(to, v);
        balance = 0;
    }
}
`,
    });
    const { byFunction } = classifyExternalCalls(graph);

    expect(
      byFunction.get('src/Order.sol:Order.effectsFirst(address,uint256)')?.reentrancy,
    ).toEqual({ externalCallThenWrite: false, guarded: false });
    expect(
      byFunction.get('src/Order.sol:Order.interactionsFirst(address,uint256)')?.reentrancy,
    ).toEqual({ externalCallThenWrite: true, guarded: false });
  });
});

describe('the sender check', () => {
  it('reads equality against msg.sender and tx.origin, and nothing else', async () => {
    const { graph } = await buildTempProject({
      'src/Checks.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Checks {
    address public owner;
    mapping(address => uint256) public balances;
    uint256 public deadline;

    function required() external view { require(msg.sender == owner, "no"); }
    function reversed() external view { require(owner != msg.sender, "no"); }
    function branched() external view { if (tx.origin == owner) { revert(); } }
    function indexes() external { balances[msg.sender] += 1; }
    function assigns() external { owner = msg.sender; }
    function compares() external view { require(block.timestamp < deadline, "no"); }
}
`,
    });
    const low = [...computeAccessControl(graph)]
      .filter(([, a]) => a.confidence === 'low')
      .map(([id]) => id)
      .sort();

    expect(low).toEqual([
      'src/Checks.sol:Checks.branched()',
      'src/Checks.sol:Checks.required()',
      'src/Checks.sol:Checks.reversed()',
    ]);
  });

  it('propagates through an unrecognised modifier that makes the check', async () => {
    const { graph } = await buildTempProject({
      'src/Guarded.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Guarded {
    address public governor;
    bool public paused;

    modifier onlyGovernor() { require(msg.sender == governor, "no"); _; }
    modifier whenNotPaused() { require(!paused, "paused"); _; }

    function governed() external onlyGovernor {}
    function pausable() external whenNotPaused {}
    function both() external onlyGovernor whenNotPaused {}
}
`,
    });
    const map = computeAccessControl(graph);

    // The modifier is not in the list, but it does check the sender: `low`,
    // and the name is reported so the user knows what to add to §13's config.
    expect(map.get('src/Guarded.sol:Guarded.governed()')).toEqual({
      modifiers: ['onlyGovernor'],
      confidence: 'low',
    });
    // `whenNotPaused` is a modifier and is not access control. It must not
    // raise the confidence of anything.
    expect(map.get('src/Guarded.sol:Guarded.pausable()')).toEqual({
      modifiers: [],
      confidence: 'none',
    });
    expect(map.get('src/Guarded.sol:Guarded.both()')).toEqual({
      modifiers: ['onlyGovernor'],
      confidence: 'low',
    });
    // And with the name configured, the same function reads `high`.
    expect(
      computeAccessControl(graph, { accessControlModifiers: ['onlyGovernor'] }).get(
        'src/Guarded.sol:Guarded.governed()',
      ),
    ).toEqual({ modifiers: ['onlyGovernor'], confidence: 'high' });
  });
});

describe('§13 entrypoints', () => {
  it('narrows the surface to the named contracts, without inventing one', async () => {
    const { graph } = await buildTempProject({
      'src/Two.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract A {
    function open() external { helper(); }
    function helper() internal {}
}

contract B {
    function alsoOpen() external {}
}
`,
    });

    // Naming a contract adds nothing here — both are already deployable — but
    // it must not promote `helper`, which is internal and not callable from
    // outside whatever the config says.
    const named = computeReachability(graph, { entrypoints: ['src/Two.sol:A'] });
    expect(named.entrypoints).toEqual(['src/Two.sol:A.open()', 'src/Two.sol:B.alsoOpen()']);

    // Naming the internal function itself is a deliberate override, and is
    // taken at its word.
    const overridden = computeReachability(graph, { entrypoints: ['src/Two.sol:A.helper()'] });
    expect(overridden.entrypoints).toContain('src/Two.sol:A.helper()');
  });
});

describe('the analysis on the graph', () => {
  it('writes §10s four fields onto the Function nodes', async () => {
    const { graph, file } = await graphOf('defi');

    // `applyAnalysis` ran during the build, and the objects it mutated are the
    // ones the graph holds and the ones `graph.json` serializes.
    const node = file.nodes.find((n) => n.id === 'src/Pair.sol:Pair.swap(uint256,uint256,address)');
    expect(node?.kind).toBe('Function');
    if (node?.kind !== 'Function') return;
    expect(node.externallyReachable).toBe(true);
    expect(node.entrypoints).toContain('src/Pair.sol:Pair.swap(uint256,uint256,address)');
    expect(node.reentrancy).toEqual({ externalCallThenWrite: true, guarded: false });
    expect(graph.getNodeAttributes(node.id)).toBe(node);

    // And running the passes again over the built graph gives the same answers,
    // which is what lets Phase 6 run them on a graph read back from disk.
    const again = analyseGraph(graph);
    expect(again.reachability.byFunction.get(node.id)).toEqual({
      externallyReachable: node.externallyReachable,
      entrypoints: node.entrypoints,
    });
  });
});

// ---------------------------------------------------------------------------
// The graph, read back
// ---------------------------------------------------------------------------

describe('graphFromFile', () => {
  it('gives the analysis passes the same answers as the graph they were built on', async () => {
    const { graph, file } = await graphOf('defi');
    const loaded = graphFromFile(parseGraph(serializeGraph(file), 'defi.graph.json'));

    expect(loaded.order).toBe(graph.order);
    expect(loaded.size).toBe(graph.size);

    // This is the property the loader exists for: everything after Phase 4
    // consumes the artifact rather than the sources, so a pass must not be able
    // to tell which side of a serialize/parse round trip it is running on.
    const before = analyseGraph(graph);
    const after = analyseGraph(loaded);

    const sorted = <T>(map: ReadonlyMap<string, T>): [string, T][] =>
      [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    expect(before.reachability.entrypoints).toEqual(after.reachability.entrypoints);
    expect(sorted(before.reachability.byFunction)).toEqual(sorted(after.reachability.byFunction));
    expect(sorted(before.accessControl)).toEqual(sorted(after.accessControl));
    expect(sorted(before.externalCalls.byEdge)).toEqual(sorted(after.externalCalls.byEdge));
    expect(sorted(before.externalCalls.byFunction)).toEqual(sorted(after.externalCalls.byFunction));
  });

  it('refuses an artifact whose edges have lost an endpoint', async () => {
    const { file } = await graphOf('minimal');
    const edge = file.edges.find((e) => e.kind === 'calls');
    expect(edge).toBeDefined();
    if (edge === undefined) return;

    // What a hand-filtered artifact produces. graphology's own error for this
    // names neither the edge nor the file it came from.
    const broken = { ...file, nodes: file.nodes.filter((n) => n.id !== edge.to) };
    expect(() => graphFromFile(broken, 'broken.json')).toThrowError(
      /broken\.json has edge .* pointing at "/,
    );
  });
});
