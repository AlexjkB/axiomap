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
 * ### Views are matched by request, not by a key
 *
 * `StaticView.request` is the `AggregatedViewOptions` the entry answers, and a
 * bridge finds its entry by comparing requests field by field. A key function
 * would have to be written twice — the CLI builds this payload and the webview
 * reads it, and §5 lets them share types and not code — and a key that drifted
 * would silently answer with the wrong view. Comparing the request itself
 * cannot drift, because it is the thing being compared.
 */

import type { AggregatedView, AggregatedViewOptions } from './aggregate.js';
import type { NodeInspection } from './inspect.js';
import type { OverlayData } from './overlays.js';
import type { ProjectMeta } from './protocol.js';
import type { SourceSlice } from '../source/slice.js';

/** One answered view request. */
export interface StaticView {
  request: AggregatedViewOptions;
  view: AggregatedView;
}

export interface StaticPayload {
  /** Bumped when the shape changes, so a stale exporter is refused rather than half-read. */
  payloadVersion: 1;
  /** ISO 8601. A deliverable is read weeks later and should say when it was made. */
  generatedAt: string;
  /** The header §4 requires on screen: mode, its copy, the resolution score. */
  meta: ProjectMeta;
  /** §11's two file-backed overlays. Empty objects when the project had neither. */
  overlays: OverlayData;
  /** Every view this file can draw. The first is the one it opens on. */
  views: StaticView[];
  /** §11's inspector, per node id, for the nodes the embedded views draw. */
  inspections: Record<string, NodeInspection>;
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
