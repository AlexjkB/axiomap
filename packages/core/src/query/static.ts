/**
 * The shape of a self-contained export (§12's `--format html`).
 *
 * §12: "`export --format html` emits a single self-contained HTML file with the
 * graph embedded — shareable with a client as an audit deliverable." §7's Phase
 * 9 says what that file *is* when it notes that it "redistributes" elkjs: the
 * webview in one file, not a second renderer.
 *
 * ### "The graph embedded" is not the graph
 *
 * §9 rule 1 is that the webview never receives the full graph, and an export
 * that inlined an `AxiomapGraph` would be that rule broken in the one artifact
 * that leaves the building. So what is embedded is **the answers a host would
 * have given** — a set of `AggregatedView`s, the inspections for the nodes in
 * them, their source slices, and the two audit-state files. The UI in an
 * exported file asks its bridge exactly the questions it asks over HTTP, and
 * the bridge answers from this rather than from a socket.
 *
 * That also makes the export's honesty problem tractable: a question this
 * payload does not answer is a *stated* limit ("this export contains 34 views")
 * rather than a blank canvas, which is the distinction §4 insists on
 * everywhere else.
 *
 * ### Nodes live in one table, and views point at it (payload v2)
 *
 * v1 embedded a whole `GraphNode` everywhere a node appeared: once per
 * `AggregatedView` that drew it, and once more in its `NodeInspection`. Measured
 * on a 298-contract project that was **2,073 distinct nodes carried as 4,421
 * node objects** — 2.1x, and the duplication grows with the number of views,
 * which is the axis an export is meant to grow along.
 *
 * So the payload carries `nodeTable`, and the views and inspections carry ids.
 * `dehydrateView` and `dehydrateInspection` below split a host's answer into the
 * two halves; the reader puts them back together before the UI sees anything,
 * so nothing downstream of the bridge learns that the format has a table in it.
 *
 * **It is a table, not a graph.** §9 rule 1 is about the webview never receiving
 * the graph, and the property that keeps this on the right side of that line is
 * unchanged from v1: only nodes some embedded view actually *draws* are in it,
 * there are no edges, and there is no adjacency to walk. The name is deliberate
 * — a top-level `nodes` beside an `edges` would be a `graph.json` under another
 * name, and `export-rendered.test.ts` asserts the absence of both.
 *
 * ### Views are matched by request, not by a key
 *
 * `StaticView.request` is the `AggregatedViewOptions` the entry answers, and a
 * bridge finds its entry by comparing requests field by field. A key function
 * would have to be written twice — the CLI builds this payload and the webview
 * reads it, and §5 lets them share types and not code — and a key that drifted
 * would silently answer with the wrong view. Comparing the request itself
 * cannot drift, because it is the thing being compared.
 */

import type { AggregatedView, AggregatedViewOptions, ClusterElement } from './aggregate.js';
import type { NodeInspection } from './inspect.js';
import type { AuditState } from './audit-state.js';
import type { ProjectMeta } from './protocol.js';
import type { GraphNode } from '../graph/schema.js';
import type { SourceSlice } from '../source/slice.js';

/** The version this build writes and reads. Bumped whenever the shape changes. */
export const PAYLOAD_VERSION = 2;

/** A drawn node, as the payload stores it: the id, where it hangs, what it does. */
export interface StaticNodeElement {
  type: 'node';
  id: string;
  parent: string | null;
  /** {@link NodeElement.calls} — whether opening the call graph here shows anything. */
  calls: boolean;
}

export type StaticDisplayNode = ClusterElement | StaticNodeElement;

/** An `AggregatedView` with its node objects lifted into `nodeTable`. */
export interface StaticAggregatedView extends Omit<AggregatedView, 'nodes'> {
  nodes: readonly StaticDisplayNode[];
}

/** A `NodeInspection` with its node object lifted into `nodeTable`. */
export type StaticInspection = Omit<NodeInspection, 'node'>;

/** One answered view request. */
export interface StaticView {
  request: AggregatedViewOptions;
  view: StaticAggregatedView;
}

export interface StaticPayload {
  /** Bumped when the shape changes, so a stale exporter is refused rather than half-read. */
  payloadVersion: typeof PAYLOAD_VERSION;
  /** ISO 8601. A deliverable is read weeks later and should say when it was made. */
  generatedAt: string;
  /** The header §4 requires on screen: mode, its copy, the resolution score. */
  meta: ProjectMeta;
  /** The two audit-state files. Empty objects when the project had neither. */
  auditState: AuditState;
  /**
   * Every node any embedded view draws, once, by id.
   *
   * Not a graph: no edges, no adjacency, and nothing in it that some view does
   * not put on screen. See the header.
   */
  nodeTable: Record<string, GraphNode>;
  /** Every view this file can draw. The first is the one it opens on. */
  views: StaticView[];
  /** §11's inspector, per node id, for the nodes the embedded views draw. */
  inspections: Record<string, StaticInspection>;
  /** §11's code preview, per node id. Absent for a node whose source was not embedded. */
  sources: Record<string, SourceSlice>;
  /**
   * What was left out, in the terms of what it would have been.
   *
   * An export is bounded — see the exporter's budget — and a deliverable that
   * silently stops answering at the third click is worse than one that says how
   * far it goes.
   */
  limits: {
    /** Views the exporter would have embedded had the budget allowed. */
    viewsOmitted: number;
    /** True when source slices were dropped to stay inside the budget. */
    sourceTruncated: boolean;
    bytes: number;
  };
}

/**
 * Split a view into the part that is drawn and the nodes it draws.
 *
 * The exporter puts the second half in `nodeTable` and the first in a
 * `StaticView`; `hydrateView` in `@axiomap/webview` is the inverse, and is
 * written twice for §5's reason — that package may import these types and not
 * these functions. `test/serve-protocol.test.ts` at the repo root pins the
 * round trip, because this is a pair that drifts silently: a reader that lost a
 * `parent` would draw a node outside the cluster it belongs to and raise
 * nothing.
 */
export function dehydrateView(view: AggregatedView): {
  view: StaticAggregatedView;
  nodes: GraphNode[];
} {
  const nodes: GraphNode[] = [];
  const elements: StaticDisplayNode[] = view.nodes.map((element) => {
    if (element.type === 'cluster') return element;
    nodes.push(element.node);
    return { type: 'node', id: element.id, parent: element.parent, calls: element.calls };
  });
  return { view: { ...view, nodes: elements }, nodes };
}

/** As `dehydrateView`, for §11's inspector. */
export function dehydrateInspection(inspection: NodeInspection): {
  inspection: StaticInspection;
  node: GraphNode;
} {
  const { node, ...rest } = inspection;
  return { inspection: rest, node };
}

/**
 * Do two view requests ask for the same thing?
 *
 * Field by field over `AggregatedViewOptions`, with `expand` compared as a set:
 * the engine closes the expansion set under its ancestors, so two orderings of
 * the same directories are the same request. Absent and default are *not*
 * treated as equal — the exporter records the request it actually passed, and a
 * bridge that guessed a default would answer a question nobody asked (the same
 * rule `decodeViewRequest` follows).
 */
export function sameViewRequest(a: AggregatedViewOptions, b: AggregatedViewOptions): boolean {
  if (
    a.view !== b.view ||
    a.focus !== b.focus ||
    a.up !== b.up ||
    a.down !== b.down ||
    a.includeTests !== b.includeTests ||
    a.renderCap !== b.renderCap ||
    a.cluster !== b.cluster ||
    a.autoExpand !== b.autoExpand
  ) {
    return false;
  }
  const left = [...(a.expand ?? [])].sort();
  const right = [...(b.expand ?? [])].sort();
  return left.length === right.length && left.every((entry, at) => entry === right[at]);
}
