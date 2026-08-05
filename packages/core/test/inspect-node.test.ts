/**
 * §11's inspector, as a query (Phase 7c).
 *
 * Hand-derived from `defi/`'s five files, the way Phases 4, 6 and 7a
 * established: every expectation below was read out of the sources before it
 * was run against them.
 *
 * The property that matters most here is not any single field — it is that this
 * answers about *the graph*, not about whatever subgraph a view happened to
 * draw. §9 rule 1 means the webview cannot answer that question itself, and an
 * inspector built from the drawn view would silently report "the callers I am
 * showing you", which is a different and more dangerous claim.
 */

import { describe, expect, it } from 'vitest';

import {
  inspectNode,
  NodeNotFoundError,
  overlayData,
  selectAggregatedView,
  type FindingsFile,
  type ReviewState,
} from '../src/index.js';
import { graphOf } from './graphs.js';

const PAIR = 'src/Pair.sol:Pair';
const SWAP = 'src/Pair.sol:Pair.swap(uint256,uint256,address)';
const TOKEN0 = 'src/Pair.sol:Pair.token0';
const ROUTER_SWAP =
  'src/Router.sol:Router.swapExactTokensForTokens(address,address,uint256,uint256,address,uint256)';
const IPAIR_SWAP = 'src/interfaces/IAmm.sol:IPair.swap(uint256,uint256,address)';

describe('inspectNode', () => {
  it('reports a contract’s members as containment, not as edges', async () => {
    const { graph } = await graphOf('defi');
    const pair = inspectNode(graph, PAIR);

    expect(pair.node.kind).toBe('Contract');
    // `declares` is containment; a contract with twenty members would bury its
    // own call graph in an outgoing list.
    expect(pair.outgoing.every((relation) => relation.edgeKind !== 'declares')).toBe(true);
    expect(pair.members.map((member) => member.name)).toContain('swap');
    expect(pair.members.map((member) => member.name)).toContain('reserve0');
    // `inherits` is a real relation and stays one.
    expect(pair.outgoing.filter((relation) => relation.edgeKind === 'inherits').map((r) => r.name))
      .toEqual(['IPair', 'Shares']);
  });

  it('answers about the whole graph, not about a drawn view', async () => {
    const { graph } = await graphOf('defi');

    // The protocol map draws contracts and rolls members up, so `Pair.swap` is
    // not in it at all — and the inspector still answers about it in full.
    const drawn = selectAggregatedView(graph, { view: 'protocol' });
    expect(drawn.nodes.some((node) => node.type === 'node' && node.id === SWAP)).toBe(false);

    const swap = inspectNode(graph, SWAP);
    expect(swap.scope?.id).toBe(PAIR);
    expect(swap.outgoing.some((relation) => relation.id === TOKEN0)).toBe(true);
    expect(swap.incoming.length).toBeGreaterThan(0);
  });

  it('carries the call site, the resolution and the virtual arms (§10)', async () => {
    const { graph } = await graphOf('defi');
    const swap = inspectNode(graph, SWAP);

    // `swap` reads `token0` at the safeTransfer on line 117 — the site is the
    // place in *this* body where the relation is written, which is what §11's
    // "click edge → reveal the call site" navigates to.
    const read = swap.outgoing.find(
      (relation) => relation.id === TOKEN0 && relation.edgeKind === 'reads',
    );
    expect(read?.src.file).toBe('src/Pair.sol');
    expect(read?.src.line).toBeGreaterThan(0);
    expect(read?.resolution).toBe('heuristic');

    /*
     * Nothing calls `Pair.swap` directly: the Router calls `IPair.swap`, and
     * this implementation is reached as one of that edge's `possibleTargets`.
     * Reporting it as an ordinary caller would claim more than the graph knows,
     * so the arm is marked virtual and its confidence is `ambiguous` whatever
     * the static edge says about itself.
     */
    const virtual = swap.incoming.filter((relation) => relation.virtual);
    expect(virtual.map((relation) => relation.id)).toEqual([ROUTER_SWAP]);
    expect(virtual[0]?.resolution).toBe('ambiguous');

    // The static edge is still there, on the interface function, and is not
    // marked virtual.
    const iface = inspectNode(graph, IPAIR_SWAP);
    const direct = iface.incoming.find((relation) => relation.id === ROUTER_SWAP);
    expect(direct?.virtual).toBe(false);
  });

  it('refuses an id it does not have rather than answering about nothing', async () => {
    const { graph } = await graphOf('defi');
    expect(() => inspectNode(graph, 'src/Nope.sol:Nope')).toThrow(NodeNotFoundError);
  });
});

describe('overlayData', () => {
  const reviewOf = (bodyHash: string): ReviewState => ({
    [SWAP]: { status: 'reviewed', bodyHash, reviewer: 'alice', at: '2026-08-05T00:00:00Z' },
    'src/Gone.sol:Gone.f()': {
      status: 'flagged',
      bodyHash: 'b1:whatever',
      at: '2026-08-05T00:00:00Z',
    },
  });

  it('marks a review stale when the body has changed, and counts the orphan', async () => {
    const { graph } = await graphOf('defi');
    const data = overlayData(graph, { review: reviewOf('b1:not-the-current-body') });

    // §8's flagship feature, projected onto a node id for §11's fill channel.
    expect(data.review[SWAP]?.staleness).toBe('stale');
    expect(data.summary.stale).toBe(1);
    // An entry naming a node this graph does not have is counted and not
    // painted: there is nothing on screen to paint it on.
    expect(data.summary.orphaned).toBe(1);
    expect(data.review['src/Gone.sol:Gone.f()']).toBeUndefined();
    expect(data.sources).toEqual({ review: true, findings: false });
  });

  it('is current when the body still hashes the same', async () => {
    const { graph } = await graphOf('defi');
    const attributes = graph.getNodeAttributes(SWAP);
    const bodyHash = attributes.kind === 'Function' ? attributes.bodyHash : '';
    const data = overlayData(graph, { review: reviewOf(bodyHash) });
    expect(data.review[SWAP]?.staleness).toBe('current');
    expect(data.summary.stale).toBe(0);
  });

  it('goes stale per node, not per finding', async () => {
    const { graph } = await graphOf('defi');
    const swapHash = (() => {
      const node = graph.getNodeAttributes(SWAP);
      return node.kind === 'Function' ? node.bodyHash : '';
    })();

    const findings: FindingsFile = {
      schemaVersion: 1,
      source: { tool: 'slither', file: 'slither.json', at: '2026-08-05T00:00:00Z' },
      findings: [
        {
          id: 'reentrancy-eth:1',
          check: 'reentrancy-eth',
          impact: 'High',
          confidence: 'Medium',
          description: 'Reentrancy in Pair.swap',
          // One node is current, the other was rewritten after the scan.
          nodes: [
            { id: SWAP, bodyHash: swapHash },
            { id: 'src/Pair.sol:Pair.mint(address)', bodyHash: 'b1:stale' },
          ],
          locations: [],
        },
      ],
    };

    const data = overlayData(graph, { findings });
    // A finding spanning a caller and a callee is stale *on the body that
    // changed*; painting the other one stale would send an auditor to re-read
    // code nobody touched.
    expect(data.findings[SWAP]?.[0]?.staleness).toBe('current');
    expect(data.findings['src/Pair.sol:Pair.mint(address)']?.[0]?.staleness).toBe('stale');
    expect(data.summary.findings).toBe(1);
    expect(data.summary.findingsStale).toBe(1);
  });

  it('is two empty maps when neither file exists', async () => {
    const { graph } = await graphOf('defi');
    const data = overlayData(graph);
    expect(data.review).toEqual({});
    expect(data.findings).toEqual({});
    expect(data.sources).toEqual({ review: false, findings: false });
  });
});
