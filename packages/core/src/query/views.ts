/**
 * §11's five views, as subgraph selection.
 *
 * §11 is explicit that a view is "a filter + layout + styling preset over one
 * graph, never a separate pipeline". This file is the **filter** third of that
 * sentence and nothing else: it takes a graph and returns which nodes and edges
 * belong to a view. Layout and styling are the renderer's, and the renderer is
 * Phase 7.
 *
 * That split is what makes `axiomap export --view state-access --format mermaid`
 * possible in a phase with no UI, and it is the same selection Phase 7's webview
 * will request over the query API (§9 rule 1: the webview never receives the
 * full graph).
 *
 * ### What is deliberately not here
 *
 * §9's **aggregation layer** — clustering by directory, drill-down, the 1,500
 * element render cap — is assigned to Phase 7 by §7, and needs the interaction
 * model it exists to serve in order to be designed. The one piece of it that a
 * static export genuinely cannot do without is the protocol map's contract-level
 * rollup, because without it the protocol map degenerates into the inheritance
 * tree; that rollup is below and is honest about being a projection.
 */

import type { AxiomapGraph } from '../graph/build.js';
import { CALL_EDGE_KINDS, type GraphEdge, type GraphNode } from '../graph/schema.js';
import { traverse } from './traverse.js';

export const VIEW_NAMES = [
  'protocol',
  'contract',
  'call',
  'state-access',
  'inheritance',
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

export interface ViewOptions {
  view: ViewName;
  /** Required by `contract` and `call` (§9 rule 4). */
  focus?: string;
  /** Upstream hops for the call view. §9's default is 2. */
  up?: number;
  /** Downstream hops for the call view. §9's default is 3. */
  down?: number;
  /** Include contracts flagged `isTest`/`isMock`. Default: false. */
  includeTests?: boolean;
}

/**
 * A subgraph, for a renderer or an exporter.
 *
 * The arrays are `readonly`, and the reason is worth stating because Phase 7 is
 * the consumer that will be tempted: **these are the graph's own node and edge
 * objects, by reference.** graphology holds attributes by reference, so a
 * webview that hung a layout coordinate or a selection flag on a node here
 * would be writing into the graph `graph.json` serializes — and the next
 * `axiomap diff` would report a phantom change. Copy before decorating.
 *
 * The one exception is the protocol map's rolled-up edges, which are synthesised
 * here and owned by the caller. They are identifiable by their `rollup:` id.
 */
export interface ViewSelection {
  view: ViewName;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** What was filtered and why, for the CLI to print above the output. */
  note: string;
}

export class ViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewError';
  }
}

/** §9's defaults, named here so the CLI and the webview cannot disagree. */
export const DEFAULT_CALL_UP = 2;
export const DEFAULT_CALL_DOWN = 3;

function scaffolding(graph: AxiomapGraph, node: GraphNode): boolean {
  if (node.kind === 'Contract') return node.isTest || node.isMock;
  if (node.scope === null || !graph.hasNode(node.scope)) return false;
  const owner = graph.getNodeAttributes(node.scope);
  return owner.kind === 'Contract' && (owner.isTest || owner.isMock);
}

/** Every edge whose endpoints both survived the node filter. */
function inducedEdges(
  graph: AxiomapGraph,
  keep: ReadonlySet<string>,
  accept: (edge: GraphEdge) => boolean,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  graph.forEachEdge((_key, edge) => {
    if (!keep.has(edge.from) || !keep.has(edge.to)) return;
    if (!accept(edge)) return;
    edges.push(edge);
  });
  return edges.sort((a, b) => a.id.localeCompare(b.id));
}

function nodesOf(graph: AxiomapGraph, keep: ReadonlySet<string>): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const id of keep) if (graph.hasNode(id)) nodes.push(graph.getNodeAttributes(id));
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The contract a node belongs to for rollup purposes: itself if it is a
 * contract, otherwise its scope.
 */
function containerOf(graph: AxiomapGraph, id: string): string | null {
  if (!graph.hasNode(id)) return null;
  const node = graph.getNodeAttributes(id);
  if (node.kind === 'Contract') return node.id;
  if (node.scope !== null && graph.hasNode(node.scope)) return node.scope;
  return null;
}

/**
 * The protocol map (§11's default view): contracts, plus inheritance, plus
 * cross-contract calls rolled up to the contract level and weighted by call
 * count.
 *
 * The rollup is a **projection, and is labelled one**. It synthesises edges
 * that are not in the graph — id `rollup:<from>-><to>` — so nothing downstream
 * can mistake one for a resolved call site. §9 rule 3 wants this weighted by
 * call count and that is what `count` carries; §16's open question about
 * weighting by distinct call sites instead is Phase 7's to answer with a
 * renderer in front of it.
 */
function protocolView(graph: AxiomapGraph, includeTests: boolean): ViewSelection {
  const keep = new Set<string>();
  graph.forEachNode((_id, node) => {
    if (node.kind !== 'Contract') return;
    if (!includeTests && scaffolding(graph, node)) return;
    keep.add(node.id);
  });

  const edges = inducedEdges(graph, keep, (edge) => edge.kind === 'inherits');

  // Roll function-level calls up to their containers.
  const rolled = new Map<string, GraphEdge>();
  graph.forEachEdge((_key, edge) => {
    if (!CALL_EDGE_KINDS.has(edge.kind)) return;
    const from = containerOf(graph, edge.from);
    const to = containerOf(graph, edge.to);
    if (from === null || to === null || from === to) return;
    if (!keep.has(from) || !keep.has(to)) return;

    const id = `rollup:${from}->${to}`;
    const existing = rolled.get(id);
    if (existing === undefined) {
      rolled.set(id, {
        ...edge,
        id,
        kind: edge.kind,
        from,
        to,
        sites: [...edge.sites] as GraphEdge['sites'],
        count: edge.count,
        possibleTargets: [],
      });
    } else {
      existing.count += edge.count;
      existing.sites.push(...edge.sites);
      // The lowest-confidence contributing edge decides the rollup's label: an
      // aggregate is only as certain as its least certain member, and rounding
      // that up is exactly the flattery §4 refuses.
      const rank = { semantic: 0, heuristic: 1, ambiguous: 2, unresolved: 3 } as const;
      if (rank[edge.resolution] > rank[existing.resolution]) {
        existing.resolution = edge.resolution;
      }
    }
  });

  return {
    view: 'protocol',
    nodes: nodesOf(graph, keep),
    edges: [...edges, ...[...rolled.values()].sort((a, b) => a.id.localeCompare(b.id))],
    note:
      `${keep.size} contracts, inheritance plus cross-contract calls rolled up to the ` +
      'contract level and weighted by call-site count' +
      (includeTests ? '' : '; test and mock contracts excluded (--include-tests to keep them)'),
  };
}

/** §11's contract detail: one contract's members and the relations among them. */
function contractView(graph: AxiomapGraph, requested: string): ViewSelection {
  /*
   * A member asked for its own contract.
   *
   * This used to refuse, with a message that named the contract to pass
   * instead — which is the tool computing the answer and then declining to
   * act on it. Clicking "Contract detail" with a function selected is the
   * obvious way to ask "what else is in here", and containment is exact
   * (`node.scope`), so there is nothing being guessed at.
   */
  const focus = containerOf(graph, requested) ?? requested;
  const node = graph.getNodeAttributes(focus);
  if (node.kind !== 'Contract') {
    throw new ViewError(
      `The contract view needs a Contract or one of its members, and "${requested}" is a ` +
        `${graph.getNodeAttributes(requested).kind} that is not inside one.`,
    );
  }
  const redirected = focus !== requested;

  const keep = new Set<string>([focus]);
  graph.forEachOutEdge(focus, (_key, edge) => {
    if (edge.kind === 'declares' || edge.kind === 'inherits') keep.add(edge.to);
  });
  // Inherited members, in a distinct tier (§11) — carried as nodes here, with
  // the tier being the renderer's job.
  for (const base of node.linearizedBases) {
    if (base === focus || !graph.hasNode(base)) continue;
    keep.add(base);
    graph.forEachOutEdge(base, (_key, edge) => {
      if (edge.kind === 'declares') keep.add(edge.to);
    });
  }

  return {
    view: 'contract',
    nodes: nodesOf(graph, keep),
    edges: inducedEdges(graph, keep, () => true),
    note:
      `${node.name} and its members, including ${node.linearizedBases.length - 1} base contracts` +
      // Say so rather than silently showing something other than what was
      // asked for: the focus on screen and the view being drawn differ.
      (redirected ? `, opened from ${graph.getNodeAttributes(requested).name}` : ''),
  };
}

/**
 * §11's call graph. §9 rule 4: function-level detail **always requires a focus
 * node**, with configurable hop limits.
 */
function callView(
  graph: AxiomapGraph,
  focus: string,
  up: number,
  down: number,
): ViewSelection {
  /*
   * §4: in structural mode the call graph "does not survive; disable the view
   * with an explanation and a prompt to build the project."
   *
   * Detected from the graph rather than from `mode`, which this function is not
   * given and which would be a second source of truth for the same fact:
   * structural mode is *implemented* by dropping `calls` and `creates` in
   * `build.ts`, so their absence is the condition itself rather than a proxy
   * for it. It also covers the honest second case — a project with no call
   * sites at all — which lands in structural mode by the same route.
   *
   * Without this the view answered with the focus node and no edges, and a note
   * reading "1 functions within 2 up and 3 down". That is a confident wrong
   * answer — "this function calls nothing and nothing calls it" — about a graph
   * that deliberately withheld the edges, which is the exact failure the mode
   * exists to prevent.
   */
  let hasCallEdges = false;
  graph.forEachEdge((_key, edge) => {
    if (CALL_EDGE_KINDS.has(edge.kind)) hasCallEdges = true;
  });
  if (!hasCallEdges) {
    throw new ViewError(
      'This graph has no call edges, so there is no call graph to draw. Either the ' +
        'project has no call sites, or resolution fell below the threshold and §4 ' +
        'withheld them rather than drawing a sparse and misleading graph — `axiomap ' +
        'stats` prints which, and building the project (`forge build --build-info`) is ' +
        'what enables them. The other four views are unaffected.',
    );
  }

  const keep = new Set<string>([focus]);
  for (const hit of traverse(graph, focus, 'callers', { depth: up })) keep.add(hit.id);
  for (const hit of traverse(graph, focus, 'callees', { depth: down })) keep.add(hit.id);

  return {
    view: 'call',
    nodes: nodesOf(graph, keep),
    edges: inducedEdges(graph, keep, (edge) => CALL_EDGE_KINDS.has(edge.kind)),
    note: `${keep.size} functions within ${up} up and ${down} down of ${focus}`,
  };
}

/**
 * §11's state access map: bipartite, functions one side, storage the other.
 *
 * "Nothing else does this well and it instantly answers who can touch this"
 * (§11), and it is the view that survives structural mode (§4), which makes it
 * the one worth having in a terminal.
 */
function stateAccessView(
  graph: AxiomapGraph,
  focus: string | undefined,
  includeTests: boolean,
): ViewSelection {
  const scope = focus === undefined ? null : focus;
  const keep = new Set<string>();
  const edges: GraphEdge[] = [];

  graph.forEachEdge((_key, edge) => {
    if (edge.kind !== 'reads' && edge.kind !== 'writes') return;
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) return;
    const from = graph.getNodeAttributes(edge.from);
    const to = graph.getNodeAttributes(edge.to);
    if (!includeTests && (scaffolding(graph, from) || scaffolding(graph, to))) return;
    if (scope !== null && containerOf(graph, edge.to) !== scope && containerOf(graph, edge.from) !== scope) {
      return;
    }
    keep.add(edge.from);
    keep.add(edge.to);
    edges.push(edge);
  });

  return {
    view: 'state-access',
    nodes: nodesOf(graph, keep),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    note:
      `${edges.length} reads/writes` +
      (scope === null ? ' across the project' : ` involving ${scope}`),
  };
}

/**
 * §11's inheritance tree: "C3 order, shadowed and overridden members flagged".
 *
 * The members are the half that is easy to get wrong, and it was: `inherits` is
 * the only contract-level relation, while `overrides` and `implements` are
 * **function-level** (Phase 2 settled that split deliberately, because it is the
 * one an auditor asks for). A selection of Contract nodes alone therefore admits
 * neither — both endpoints have to survive the node filter, and a Function never
 * does. On `defi/` that silently dropped all seven `implements` edges and left
 * §11's second clause unachievable from this view's output.
 *
 * So the functions on either end of an override relation are kept too, when both
 * of their contracts are. They carry `scope`, so a renderer can nest each member
 * under its contract without a `declares` edge cluttering a view that is about
 * inheritance.
 */
function inheritanceView(graph: AxiomapGraph, includeTests: boolean): ViewSelection {
  const contracts = new Set<string>();
  graph.forEachNode((_id, node) => {
    if (node.kind !== 'Contract') return;
    if (!includeTests && scaffolding(graph, node)) return;
    contracts.add(node.id);
  });

  const keep = new Set<string>(contracts);
  const memberEdges: GraphEdge[] = [];
  graph.forEachEdge((_key, edge) => {
    if (edge.kind !== 'overrides' && edge.kind !== 'implements') return;
    const from = containerOf(graph, edge.from);
    const to = containerOf(graph, edge.to);
    if (from === null || to === null || !contracts.has(from) || !contracts.has(to)) return;
    keep.add(edge.from);
    keep.add(edge.to);
    memberEdges.push(edge);
  });

  const edges = [
    ...inducedEdges(graph, contracts, (edge) => edge.kind === 'inherits'),
    ...memberEdges.sort((a, b) => a.id.localeCompare(b.id)),
  ];

  return {
    view: 'inheritance',
    nodes: nodesOf(graph, keep),
    edges,
    note:
      `${contracts.size} contracts in C3 order; ${edges.length} relations ` +
      `(${String(memberEdges.length)} at member level)`,
  };
}

export function selectView(graph: AxiomapGraph, options: ViewOptions): ViewSelection {
  const includeTests = options.includeTests ?? false;

  if (options.view === 'protocol') return protocolView(graph, includeTests);
  if (options.view === 'inheritance') return inheritanceView(graph, includeTests);
  if (options.view === 'state-access') {
    return stateAccessView(graph, options.focus, includeTests);
  }

  if (options.focus === undefined) {
    throw new ViewError(
      options.view === 'call'
        ? 'The call view always requires a focus node (AXIOMAP.md §9): pass --focus <node>. ' +
          'Nobody reads a whole-project function graph, in a terminal or anywhere else.'
        : 'The contract view requires a focus contract: pass --focus <contract>.',
    );
  }
  if (!graph.hasNode(options.focus)) {
    throw new ViewError(`"${options.focus}" is not a node in this graph.`);
  }

  if (options.view === 'contract') return contractView(graph, options.focus);
  return callView(graph, options.focus, options.up ?? DEFAULT_CALL_UP, options.down ?? DEFAULT_CALL_DOWN);
}
