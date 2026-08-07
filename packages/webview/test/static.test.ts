/**
 * `StaticBridge` — the reader half of the client deliverable (Phase 7e).
 *
 * §12's html export is the artifact an auditor hands a client at the end of an
 * engagement (§15's ninth item), and this class is what the client is actually
 * using: the third `HostBridge`, answering from a payload inlined in the page
 * rather than from a process. It went into Phase 7d at **4.85% statement
 * coverage** — every path below was written, screenshotted once, and never
 * asserted.
 *
 * What that leaves untested is precisely the half a client hits and an auditor
 * does not. A live host answers everything; a file answers what was exported and
 * has to *state* the rest, and §4's whole position is that a tool which cannot
 * answer says so rather than showing a plausible blank. So the refusals are the
 * subject here, not the happy path:
 *
 * - "this export holds N views, not this one", and what it says it holds
 * - the payload-version check, which is what stops a v1 file half-rendering
 * - search, which runs over the embedded inspections and so cannot offer a node
 *   the panel would then refuse
 * - hydration, which is the v2 format's own failure mode
 *
 * Phase 8 adds a fourth implementation of `HostBridge` over `postMessage`. This
 * suite exists before that, so the shared contract is pinned on three
 * implementations rather than two.
 */

import type {
  AggregatedView,
  GraphNode,
  NodeInspection,
  AuditState,
  ProjectMeta,
  StaticInspection,
  StaticPayload,
} from '@axiomap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { BridgeError } from '../src/bridge.js';
import {
  hydrateInspection,
  hydrateView,
  PAYLOAD_GLOBAL,
  READS_PAYLOAD_VERSION,
  readEmbeddedPayload,
  StaticBridge,
} from '../src/static.js';
import { contract, fn, sliceOf, view } from './support.js';

const meta: ProjectMeta = {
  schemaVersion: 4,
  generator: { name: 'axiomap', parser: 'treesitter', hashVersion: 1, compilers: [] },
  project: { kind: 'foundry', sources: ['src'], files: 5 },
  mode: 'heuristic',
  modeReason: 'No build artifacts. 98% of call edges resolved confidently.',
  score: {
    overall: { semantic: 0, heuristic: 137, ambiguous: 1, unresolved: 1, total: 139, confident: 0.99 },
    calls: { semantic: 0, heuristic: 42, ambiguous: 0, unresolved: 1, total: 43, confident: 0.98 },
    excludedFiles: 0,
  },
  diagnostics: [],
  root: '/tmp/defi',
  renderCap: 1500,
  views: ['protocol', 'contract', 'call', 'state-access', 'inheritance'],
  callDefaults: { up: 2, down: 3 },
};

const auditState: AuditState = {
  review: {},
  findings: {},
  summary: {
    reviewed: 0,
    flagged: 0,
    followUp: 0,
    ignored: 0,
    stale: 0,
    orphaned: 0,
    findings: 0,
    findingsStale: 0,
  },
  sources: { review: false, findings: false },
};

const vault = contract('src/Vault.sol:Vault');
const deposit = fn('src/Vault.sol:Vault.deposit(uint256)');
const withdraw = fn('src/Vault.sol:Vault.withdraw(uint256)');

function inspection(node: GraphNode): StaticInspection {
  return { id: node.id, scope: null, members: [], incoming: [], outgoing: [] };
}

/** A payload shaped like the exporter's, with a mix of view kinds in it. */
function payloadOf(over: Partial<StaticPayload> = {}): StaticPayload {
  return {
    payloadVersion: READS_PAYLOAD_VERSION,
    generatedAt: '2026-08-05T00:00:00.000Z',
    meta,
    auditState,
    nodeTable: { [vault.id]: vault, [deposit.id]: deposit, [withdraw.id]: withdraw },
    views: [
      {
        request: { view: 'protocol' },
        view: {
          ...view(),
          nodes: [{ type: 'node', id: vault.id, parent: 'dir:src' }],
          elements: 1,
        },
      },
      {
        request: { view: 'contract', focus: vault.id },
        view: {
          ...view({ view: 'contract' }),
          nodes: [
            { type: 'node', id: vault.id, parent: null },
            { type: 'node', id: deposit.id, parent: vault.id },
          ],
          elements: 2,
        },
      },
      {
        request: { view: 'call', focus: deposit.id, up: 2, down: 3 },
        view: {
          ...view({ view: 'call' }),
          nodes: [{ type: 'node', id: deposit.id, parent: null }],
          elements: 1,
        },
      },
    ],
    inspections: {
      [vault.id]: inspection(vault),
      [deposit.id]: inspection(deposit),
      [withdraw.id]: inspection(withdraw),
    },
    sources: { [deposit.id]: sliceOf(deposit.id) },
    limits: { viewsOmitted: 12, sourceTruncated: false, bytes: 1000 },
    ...over,
  };
}

async function refusal(promise: Promise<unknown>): Promise<BridgeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BridgeError) return error;
    throw error;
  }
  throw new Error('Expected the bridge to refuse, and it answered.');
}

describe('StaticBridge: what an export can answer', () => {
  const bridge = new StaticBridge(payloadOf());

  it('opens on the view the export was asked for', () => {
    expect(bridge.initial).toEqual({ view: 'protocol' });
  });

  it('has no opening view when the file holds none', () => {
    expect(new StaticBridge(payloadOf({ views: [] })).initial).toBeNull();
  });

  it('answers meta and audit state from the payload', async () => {
    expect(await bridge.meta()).toBe(meta);
    expect(await bridge.auditState()).toBe(auditState);
  });

  /**
   * The whole point of the node table: the UI gets a real `AggregatedView` with
   * whole nodes in it and never learns the format has a table in it.
   */
  it('puts the nodes back into a view before the UI sees it', async () => {
    const answered = await bridge.view({ view: 'contract', focus: vault.id });
    const drawn = answered.nodes.flatMap((element) =>
      element.type === 'node' ? [element.node] : [],
    );
    expect(drawn).toEqual([vault, deposit]);
    // And the parents survive, which is what puts a member inside its contract.
    expect(answered.nodes.map((element) => element.parent)).toEqual([null, vault.id]);
  });

  it('matches a call view only when the hop limits match too', async () => {
    // The Phase 7d defect, from the reader's side: the UI sends `up`/`down` on
    // every call request, and a payload that recorded neither answers nothing.
    await expect(
      bridge.view({ view: 'call', focus: deposit.id, up: 2, down: 3 }),
    ).resolves.toBeDefined();
    const refused = await refusal(bridge.view({ view: 'call', focus: deposit.id }));
    expect(refused.detail.name).toBe('NotExported');
  });

  it('inspects a node the export carries, node and relations together', async () => {
    const inspected: NodeInspection = await bridge.inspect(deposit.id);
    expect(inspected.node).toBe(deposit);
    expect(inspected.id).toBe(deposit.id);
    expect(inspected.outgoing).toEqual([]);
  });

  it('returns the source slice it carries', async () => {
    expect((await bridge.source(deposit.id)).id).toBe(deposit.id);
  });
});

describe('StaticBridge: what it refuses, and what it says', () => {
  const bridge = new StaticBridge(payloadOf());

  /**
   * §4, in the deliverable: a client opening an export is exactly the reader who
   * cannot tell an empty graph from a broken one, so the refusal names how much
   * this file holds and where to go for more.
   */
  it('names how many views it holds, and of what kinds', async () => {
    const refused = await refusal(bridge.view({ view: 'contract', focus: 'src/Other.sol:Other' }));

    expect(refused.detail.name).toBe('NotExported');
    expect(refused.message).toContain('3 views');
    // The mix, not just the total: "60 contract" and "129 call" answer the
    // question the refused reader is actually asking.
    expect(refused.message).toContain('1 protocol, 1 contract, 1 call');
    expect(refused.message).toContain('axiomap serve');
  });

  it('says "view" rather than "views" when it holds one', async () => {
    const one = new StaticBridge(payloadOf({ views: [payloadOf().views[0]] }));
    const refused = await refusal(one.view({ view: 'inheritance' }));
    expect(refused.message).toContain('1 view (1 protocol)');
  });

  it('refuses an inspection it does not carry, naming the node', async () => {
    const refused = await refusal(bridge.inspect('src/Other.sol:Other'));
    expect(refused.detail.name).toBe('NotExported');
    expect(refused.message).toContain('src/Other.sol:Other');
  });

  /**
   * Two different reasons a preview can be missing, and they are not the same
   * answer: one is "this node has no source", the other is "this file was too
   * large to carry it". A reader who gets the first for the second reason will
   * go looking for a bug in the node.
   */
  it('distinguishes a node with no source from an export that dropped it', async () => {
    const untruncated = await refusal(bridge.source(vault.id));
    expect(untruncated.message).toContain('does not carry source');

    const truncated = new StaticBridge(
      payloadOf({ limits: { viewsOmitted: 0, sourceTruncated: true, bytes: 1 } }),
    );
    const dropped = await refusal(truncated.source(vault.id));
    expect(dropped.message).toContain('too large to carry every source range');
  });

  /**
   * The v2 format's own failure mode. A view that draws a node the table does
   * not hold is an internally inconsistent file — it cannot come from the
   * exporter, which fills the table from the views themselves — so it is stated
   * rather than drawn around with a hole in it.
   */
  it('refuses a view whose nodes the file does not carry', async () => {
    const broken = new StaticBridge(payloadOf({ nodeTable: {} }));
    const refused = await refusal(broken.view({ view: 'protocol' }));
    expect(refused.detail.name).toBe('MalformedPayload');
    expect(refused.message).toContain(vault.id);

    const inspected = await refusal(broken.inspect(vault.id));
    expect(inspected.detail.name).toBe('MalformedPayload');
  });
});

describe('StaticBridge: searching what the file contains', () => {
  const bridge = new StaticBridge(payloadOf());

  it('answers the empty query with nothing rather than with everything', async () => {
    const results = await bridge.search('   ');
    expect(results).toEqual({ query: '', hits: [], total: 0, capped: false, limit: 20 });
  });

  it('matches on name and on id, shortest id first', async () => {
    const results = await bridge.search('Vault');
    expect(results.hits.map((hit) => hit.id)).toEqual([vault.id, deposit.id, withdraw.id]);
    expect(results.hits[0]?.line).toBe(vault.src.line);
    expect(results.hits[0]?.kind).toBe('Contract');
    expect(results.total).toBe(3);
    expect(results.capped).toBe(false);
  });

  it('caps the hits and says it capped them', async () => {
    const results = await bridge.search('Vault', 2);
    expect(results.hits).toHaveLength(2);
    expect(results.total).toBe(3);
    expect(results.capped).toBe(true);
    expect(results.limit).toBe(2);
  });

  /**
   * The caller does not get to raise the cap. `search.ts` makes the same point
   * for the live host: a palette that asked for ten thousand rows would get
   * them, and the cap is the host's to enforce.
   */
  it('will not be talked into a bigger limit than it allows', async () => {
    expect((await bridge.search('Vault', 5_000)).limit).toBe(50);
  });

  it('offers nothing it could not then show', async () => {
    // A node in the table with no inspection is not a search hit: the palette
    // must not name something the panel would refuse a click on.
    const partial = new StaticBridge(
      payloadOf({ inspections: { [vault.id]: inspection(vault) } }),
    );
    expect((await partial.search('Vault')).hits.map((hit) => hit.id)).toEqual([vault.id]);
  });

  it('finds nothing when nothing matches, without failing', async () => {
    expect((await bridge.search('zzzz')).hits).toEqual([]);
  });

  /**
   * The other direction of the same rule: an inspection whose node the table
   * does not hold is skipped rather than thrown on. A malformed file must not
   * make the palette itself fail — `view` and `inspect` are where that file is
   * reported, and a search box that throws would hide it.
   */
  it('skips an inspection whose node is missing rather than failing', async () => {
    const broken = new StaticBridge(payloadOf({ nodeTable: { [vault.id]: vault } }));
    expect((await broken.search('Vault')).hits.map((hit) => hit.id)).toEqual([vault.id]);
  });

  it('breaks a tie between equal-length ids alphabetically', async () => {
    const a = fn('src/Vault.sol:Vault.aaa(uint256)');
    const b = fn('src/Vault.sol:Vault.bbb(uint256)');
    const tied = new StaticBridge(
      payloadOf({
        nodeTable: { [b.id]: b, [a.id]: a },
        inspections: { [b.id]: inspection(b), [a.id]: inspection(a) },
      }),
    );
    expect((await tied.search('Vault.')).hits.map((hit) => hit.id)).toEqual([a.id, b.id]);
  });
});

describe('reading the payload out of the page', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[PAYLOAD_GLOBAL];
  });

  it('is null in a page that is not an export', () => {
    expect(readEmbeddedPayload()).toBeNull();
  });

  it('is null when the global is not an object', () => {
    (globalThis as Record<string, unknown>)[PAYLOAD_GLOBAL] = 'not a payload';
    expect(readEmbeddedPayload()).toBeNull();
  });

  /**
   * §3's reason for `schemaVersion` on `graph.json`, applied to the deliverable:
   * a file opened a year later should say it is from a different tool rather
   * than render most of itself. v1 is a real case rather than a hypothetical —
   * it embedded whole nodes in the views and had no table, so half-reading one
   * would draw every view empty.
   */
  it('refuses a payload from a different version of the format', () => {
    (globalThis as Record<string, unknown>)[PAYLOAD_GLOBAL] = { ...payloadOf(), payloadVersion: 1 };
    expect(readEmbeddedPayload()).toBeNull();
  });

  it('reads a payload this build wrote', () => {
    const payload = payloadOf();
    (globalThis as Record<string, unknown>)[PAYLOAD_GLOBAL] = payload;
    expect(readEmbeddedPayload()).toBe(payload);
  });
});

describe('hydration', () => {
  /**
   * The half of the v2 format that lives in this package. The other half is
   * core's `dehydrateView`, and the pair is pinned at the repo root — this
   * covers what a round trip cannot: the shape of the failure.
   */
  it('leaves a cluster element exactly as it found it', () => {
    const cluster = {
      type: 'cluster' as const,
      id: 'dir:src',
      path: 'src',
      label: 'src',
      parent: null,
      expanded: false,
      members: 9,
      internalEdges: 4,
    };
    const hydrated: AggregatedView = hydrateView(
      { ...view(), nodes: [cluster] },
      {},
    );
    expect(hydrated.nodes[0]).toBe(cluster);
  });

  it('keeps every field of the view that is not a node', () => {
    const hydrated = hydrateView(
      { ...view({ note: 'six of nine drawn', collapsed: ['src/lib'] }), nodes: [] },
      {},
    );
    expect(hydrated.note).toBe('six of nine drawn');
    expect(hydrated.collapsed).toEqual(['src/lib']);
  });

  it('throws a stated error rather than a TypeError on a missing node', () => {
    expect(() => hydrateInspection(inspection(vault), {})).toThrow(BridgeError);
    expect(() => hydrateInspection(inspection(vault), {})).toThrow(/does not carry|not the node/);
  });
});
