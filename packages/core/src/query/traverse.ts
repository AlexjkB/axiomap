/**
 * §12's traversal queries: `callers-of`, `callees-of`, `reachable-from`, `path`.
 *
 * All four walk the call graph — `calls` and `creates`, the two kinds §4's mode
 * gate is computed over and the two structural mode withholds. Nothing here
 * recomputes reachability; `analysis/reachability.ts` already answers "is this
 * reachable from outside", and these answer "from where, and by what route",
 * which is the question you ask once you have the first answer.
 *
 * ### Virtual dispatch is followed, and said so
 *
 * §10 gives an interface call one static edge to the interface's function plus
 * `possibleTargets` for every implementation. Following only the static edge
 * reports an implementation reached solely through its interface as
 * unreachable, which is the error `analysis/reachability.ts` already refuses to
 * make. So these traversals follow `possibleTargets` too — and every step
 * carries `virtual: true` when it did, because "`Pair.mint` is called by
 * `Router.addLiquidity`" and "`Pair.mint` is one of four things
 * `Router.addLiquidity`'s interface call could reach" are different claims, and
 * an auditor is entitled to know which one they are reading.
 */

import type { AxiomapGraph } from '../graph/build.js';
import { CALL_EDGE_KINDS, type GraphEdge, type SourceRefRecord } from '../graph/schema.js';

export type Direction = 'callers' | 'callees';

export interface TraverseOptions {
  /**
   * Hops. `Infinity` for the transitive closure, which is what
   * `reachable-from` is. §12 gives `callers-of`/`callees-of` a `--depth`, and
   * the CLI defaults them to 1 — an unbounded `callees-of` would be
   * `reachable-from` under another name.
   */
  depth?: number;
}

/** One hop, and the evidence for it. */
export interface CallStep {
  from: string;
  to: string;
  /** The call site (§10: an edge's `src` is where the call is written). */
  src: SourceRefRecord;
  subkind: GraphEdge['subkind'];
  resolution: GraphEdge['resolution'];
  /** Reached through `possibleTargets` rather than the static edge. */
  virtual: boolean;
}

export interface TraverseHit {
  id: string;
  /** Hops from the origin; 1 is a direct caller or callee. */
  depth: number;
  /** The first route found to it, shortest-first by construction. */
  via: CallStep[];
}

function step(edge: GraphEdge, to: string, virtual: boolean): CallStep {
  return {
    from: edge.from,
    to,
    src: edge.src,
    subkind: edge.subkind,
    resolution: edge.resolution,
    virtual,
  };
}

/**
 * Every call hop in the graph, both ways round, built once per traversal.
 *
 * The reverse direction is the reason this is an index rather than a pair of
 * `forEachInEdge` calls: a node can be reached as somebody's `possibleTarget`,
 * and the only way to find those from the target's side is to have looked at
 * every edge. Doing that per visited node makes `callers-of` O(V·E), which on
 * `large/`'s 74,512 edges is the difference between a query and a coffee break.
 */
interface CallIndex {
  callees: Map<string, CallStep[]>;
  callers: Map<string, CallStep[]>;
}

function push(into: Map<string, CallStep[]>, key: string, value: CallStep): void {
  const list = into.get(key);
  if (list === undefined) into.set(key, [value]);
  else list.push(value);
}

function buildCallIndex(graph: AxiomapGraph): CallIndex {
  const callees = new Map<string, CallStep[]>();
  const callers = new Map<string, CallStep[]>();

  graph.forEachEdge((_key, edge) => {
    if (!CALL_EDGE_KINDS.has(edge.kind)) return;
    push(callees, edge.from, step(edge, edge.to, false));
    push(callers, edge.to, step(edge, edge.to, false));

    for (const target of edge.possibleTargets) {
      if (target === edge.to || !graph.hasNode(target)) continue;
      push(callees, edge.from, step(edge, target, true));
      push(callers, target, step(edge, target, true));
    }
  });

  return { callees, callers };
}

/**
 * Breadth-first, so the recorded route to each node is a shortest one and
 * `depth` is a real hop count rather than whatever order the walk happened to
 * take.
 */
export function traverse(
  graph: AxiomapGraph,
  origin: string,
  direction: Direction,
  options: TraverseOptions = {},
): TraverseHit[] {
  const limit = options.depth ?? Infinity;
  const index = buildCallIndex(graph);
  const adjacency = direction === 'callees' ? index.callees : index.callers;
  const other = (hop: CallStep): string => (direction === 'callees' ? hop.to : hop.from);

  const seen = new Map<string, TraverseHit>();
  let frontier: { id: string; via: CallStep[] }[] = [{ id: origin, via: [] }];
  let depth = 0;

  while (frontier.length > 0 && depth < limit) {
    depth += 1;
    const next: { id: string; via: CallStep[] }[] = [];
    for (const current of frontier) {
      for (const hop of adjacency.get(current.id) ?? []) {
        const id = other(hop);
        if (id === origin || seen.has(id)) continue;
        const via = [...current.via, hop];
        seen.set(id, { id, depth, via });
        next.push({ id, via });
      }
    }
    frontier = next;
  }

  return [...seen.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
}

/** §12's `reachable-from`: the transitive downstream closure. */
export function reachableFrom(graph: AxiomapGraph, origin: string): TraverseHit[] {
  return traverse(graph, origin, 'callees');
}

/**
 * §12's `path <from> <to>`: one shortest call path, or null.
 *
 * One rather than all: the number of paths through a call graph is exponential,
 * and the question an auditor is asking — "can this reach that, and how" — is
 * answered by an example. Shortest, because a shortest path is the one with the
 * fewest places for the reader to lose the thread.
 */
export function callPath(graph: AxiomapGraph, from: string, to: string): CallStep[] | null {
  if (from === to) return [];
  const hit = traverse(graph, from, 'callees').find((candidate) => candidate.id === to);
  return hit === undefined ? null : hit.via;
}
