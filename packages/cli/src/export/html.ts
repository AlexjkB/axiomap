/**
 * `axiomap export --format html` (§12) — the audit deliverable.
 *
 * §12: "a single self-contained HTML file with the graph embedded — shareable
 * with a client". §7's Phase 9 settles what that file *is* when it says it
 * "redistributes" elkjs and needs the attribution in its footer: **the webview
 * in one file**, not a second renderer. §16 records the two deferrals that got
 * it here and the trigger that fired.
 *
 * So this module does three things and invents nothing:
 *
 * 1. Ask the same query API the UI asks over HTTP, for a bounded set of views.
 * 2. Put the answers in a `StaticPayload` (`core/query/static.ts`).
 * 3. Wrap that, the single-chunk bundle, the stylesheet and elkjs's worker
 *    source in one document, with the attribution in the footer.
 *
 * ### "The graph embedded" is answers, not the graph
 *
 * §9 rule 1 says the webview never receives the full graph, and the export is
 * the artifact where breaking that would be permanent — a `graph.json` inlined
 * in a file sent to a third party. What is embedded is what a host would have
 * *answered*: views, inspections, source ranges, the two audit-state files. The
 * UI in the exported file asks its bridge the same questions and does not learn
 * that the answers were precomputed.
 *
 * ### It is bounded, and it says where it stops
 *
 * A 300-contract protocol has thousands of reachable views and every one of
 * them could be embedded. The exporter walks them from the one that was asked
 * for and stops at a byte budget, then records what it left out. A deliverable
 * that silently stops answering at the third click is worse than one that says
 * how far it goes — the same argument §9 rule 2 makes for the render cap, and §4
 * makes for everything else.
 *
 * ### What it stops on is a quota per view kind, not a queue running dry
 *
 * Phase 7d walked that set breadth-first and spent the budget in the order the
 * queue produced it. On a 298-contract project that meant **190 views: one
 * protocol map and 189 contract views, and not one call graph** — the contract
 * views reached the ceiling before the walk got to the first function. §9 rule 4
 * makes the call graph the view that requires a focus node, and §11 makes it the
 * one an auditor lives in, so a deliverable that can never contain one is §15's
 * ninth item not working.
 *
 * Raising the ceiling does not fix that; it buys more contract views. The fix is
 * to decide **how much of what** before the walk starts, which is `VIEW_QUOTA`
 * below. It is stated here rather than left to emerge from a traversal order,
 * because "how much of what" is the kind of thing that otherwise gets decided
 * twice — once in the queue and once in whatever reads it.
 */

import {
  dehydrateInspection,
  dehydrateView,
  inspectNode,
  PAYLOAD_VERSION,
  RenderCapError,
  selectAggregatedView,
  sliceNode,
  type AggregatedView,
  type AggregatedViewOptions,
  type AxiomapGraph,
  type GraphNode,
  type OverlayData,
  type ProjectMeta,
  type SourceSlice,
  type StaticAggregatedView,
  type StaticInspection,
  type StaticPayload,
  type StaticView,
} from '@axiomap/core';

/**
 * How much JSON an export may carry, before the bundle around it.
 *
 * Chosen to be generous rather than tuned: a deliverable is written once and
 * read on somebody else's laptop, and 12 MB of JSON is a file that still opens.
 * The three fractions below spend it in priority order — views are what makes
 * the file navigable, attributes are what makes a node worth clicking, and
 * source is the largest and the most redundant with what the client already has.
 */
export const DEFAULT_EXPORT_BUDGET = 12 * 1024 * 1024;
const VIEW_SHARE = 0.4;
const INSPECT_SHARE = 0.7;

/**
 * The three things a view can be, from the reader's point of view.
 *
 * §11 lists five views, but only three shapes are *reachable by clicking* in an
 * export: the view the file opened on and its directory expansions, a contract's
 * members, and a call graph rooted on a function. `state-access` and
 * `inheritance` are opening views rather than destinations, so they share the
 * map's quota — an export asked for one of them spends that quota on it.
 */
export type ViewQuotaKind = 'map' | 'contract' | 'call';

/**
 * **The policy: how much of the view budget each kind may spend.**
 *
 * Fractions of `budget * VIEW_SHARE`, and they are floors as much as ceilings —
 * a kind may not be starved by another kind's queue being longer, which is
 * exactly what happened to the call graph in Phase 7d.
 *
 * - **`call` gets the largest share** because it is the view §9 rule 4 makes
 *   focus-dependent and §11 makes the one an auditor works in, and because it is
 *   the only kind whose absence makes a click land on a refusal rather than on a
 *   less-detailed answer.
 * - **`contract` is the middle** — it is the drill-down every contract on the
 *   map offers, so it wants breadth, but a contract view the file lacks still
 *   leaves the map and the inspector answering for that contract.
 * - **`map` is small** because there are few of them: the opening view plus one
 *   per directory expansion, and a project has tens of directories, not
 *   thousands of them.
 *
 * Unspent quota is not wasted: whatever no kind claimed is pooled and offered
 * back to the kinds that still have queued requests (see `buildPayload`). So a
 * nine-contract project still embeds everything reachable, and only a project
 * big enough to exhaust the budget ever sees these numbers bite.
 */
export const VIEW_QUOTA: Readonly<Record<ViewQuotaKind, number>> = {
  map: 0.15,
  contract: 0.35,
  call: 0.5,
};

/** Which quota a request spends from. */
export function quotaKind(request: AggregatedViewOptions): ViewQuotaKind {
  if (request.view === 'contract') return 'contract';
  if (request.view === 'call') return 'call';
  return 'map';
}

/** Round-robin order, so a kind is never blocked behind another kind's queue. */
const QUOTA_ORDER: readonly ViewQuotaKind[] = ['map', 'contract', 'call'];

export interface HtmlExportOptions {
  graph: AxiomapGraph;
  meta: ProjectMeta;
  overlays: OverlayData;
  /** Project root, for the source slices. */
  root: string;
  /** The view the file opens on — everything else is reached from it. */
  initial: AggregatedViewOptions;
  budget?: number;
  /** Injected by the test; the real one reads the built bundle. */
  bundle: { script: string; style: string; elkWorker: string };
  /** For the title and the footer. */
  project: string;
  version: string;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

/**
 * Every node the drawn views actually contain.
 *
 * Clusters are directories rather than nodes (§10's kinds are declarations), so
 * they contribute nothing to inspect — which is the same reason the UI does not
 * open the inspector when one is clicked.
 */
function drawnNodes(view: StaticAggregatedView): string[] {
  return view.nodes.flatMap((element) => (element.type === 'node' ? [element.id] : []));
}

/**
 * The views reachable in one click from a drawn one.
 *
 * This mirrors `navigation.ts`'s reducer deliberately — a contract opens into
 * its members, a function into the call graph rooted on it — because the set
 * this walks has to be the set the UI can ask for. A view the UI can reach and
 * the exporter did not embed is a dead click, and one the exporter embedded and
 * the UI cannot reach is dead weight.
 */
function nextRequests(
  request: AggregatedViewOptions,
  view: AggregatedView,
  hops: { up: number; down: number },
): AggregatedViewOptions[] {
  const out: AggregatedViewOptions[] = [];

  for (const element of view.nodes) {
    if (element.type === 'cluster') {
      // Drilling into a directory: `navigation.ts` adds the path to `expand`
      // and re-requests the same view. A collapsed cluster the export did not
      // embed the expansion of is a box that cannot be opened.
      if (element.expanded) continue;
      out.push({ ...request, expand: [...(request.expand ?? []), element.path] });
      continue;
    }
    const node = element.node;
    if (node.kind === 'Contract') {
      out.push({ view: 'contract', focus: node.id });
    } else if (node.kind === 'Function') {
      /*
       * The hop limits have to be the ones the UI will *send*, not the ones
       * this export happens to have been invoked with.
       *
       * `navigation.ts` puts `up`/`down` on every call-view request, taking
       * them from `meta.callDefaults`. Embedding `{view:'call', focus}` without
       * them produced a file where every function click answered "this export
       * does not hold that view" — 49 embedded views and not one of them the
       * one being asked for. Found by clicking, not by a failing assertion.
       */
      out.push({ view: 'call', focus: node.id, up: hops.up, down: hops.down });
    }
  }
  return out;
}

/** A stable string for "have I already embedded this request?". */
function requestKey(request: AggregatedViewOptions): string {
  return JSON.stringify({
    view: request.view,
    focus: request.focus ?? null,
    up: request.up ?? null,
    down: request.down ?? null,
    includeTests: request.includeTests ?? null,
    renderCap: request.renderCap ?? null,
    cluster: request.cluster ?? null,
    autoExpand: request.autoExpand ?? null,
    expand: [...(request.expand ?? [])].sort(),
  });
}

export function buildPayload(options: HtmlExportOptions): StaticPayload {
  const budget = options.budget ?? DEFAULT_EXPORT_BUDGET;
  const views: StaticView[] = [];
  const nodeTable: Record<string, GraphNode> = {};
  const inspections: Record<string, StaticInspection> = {};
  const sources: Record<string, SourceSlice> = {};

  let used = 0;
  let viewsOmitted = 0;

  const viewBudget = budget * VIEW_SHARE;
  const allowance: Record<ViewQuotaKind, number> = {
    map: viewBudget * VIEW_QUOTA.map,
    contract: viewBudget * VIEW_QUOTA.contract,
    call: viewBudget * VIEW_QUOTA.call,
  };
  const spent: Record<ViewQuotaKind, number> = { map: 0, contract: 0, call: 0 };
  const queues: Record<ViewQuotaKind, AggregatedViewOptions[]> = { map: [], contract: [], call: [] };

  const seen = new Set<string>();
  queues[quotaKind(options.initial)].push(options.initial);
  seen.add(requestKey(options.initial));

  /**
   * Answer one request and record it, or say why it was not recorded.
   *
   * `cap` is what this request may cost — the kind's remaining quota during the
   * quota rounds, and the shared remainder afterwards. `null` means "whatever it
   * costs", which only the opening view gets: a file that opened on nothing
   * because the budget was tight would be worse than a large file.
   */
  const embed = (
    request: AggregatedViewOptions,
    cap: number | null,
  ): { status: 'embedded' | 'refused' | 'over'; cost: number } => {
    let view: AggregatedView;
    try {
      view = selectAggregatedView(options.graph, request);
    } catch (error) {
      // A view the engine refuses is not a gap in the export: §9 rule 2's
      // refusal is the correct answer to that request, and the reader gets the
      // same refusal from `StaticBridge`. Anything else is a real failure and
      // should not be swallowed.
      if (error instanceof RenderCapError) return { status: 'refused', cost: 0 };
      throw error;
    }

    const split = dehydrateView(view);
    // The honest cost of embedding this view: the view itself, plus the nodes it
    // draws that no earlier view already put in the table. Charging for a node
    // twice would reintroduce the accounting v1 had, one level up.
    const fresh = split.nodes.filter((node) => !(node.id in nodeTable));
    const cost = bytes(split.view) + fresh.reduce((total, node) => total + bytes(node), 0);
    if (cap !== null && cost > cap) return { status: 'over', cost };

    for (const node of fresh) nodeTable[node.id] = node;
    views.push({ request, view: split.view });
    used += cost;

    for (const next of nextRequests(request, view, options.meta.callDefaults)) {
      const key = requestKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queues[quotaKind(next)].push(next);
    }
    return { status: 'embedded', cost };
  };

  /*
   * The quota rounds. One request per kind per round, so `call` starts being
   * embedded as soon as the first contract view has produced one rather than
   * after every contract view has been considered — which is the whole of the
   * defect this replaces.
   *
   * A kind closes when its next request does not fit what it has left. Its
   * remaining queue is not walked: computing a thousand views in order to reject
   * them costs seconds and tells the reader nothing the count does not.
   */
  const closed = new Set<ViewQuotaKind>();
  while (closed.size < QUOTA_ORDER.length) {
    let progressed = false;
    for (const kind of QUOTA_ORDER) {
      if (closed.has(kind)) continue;
      const request = queues[kind].shift();
      if (request === undefined) {
        closed.add(kind);
        continue;
      }
      progressed = true;
      const first = views.length === 0;
      const result = embed(request, first ? null : allowance[kind] - spent[kind]);
      if (result.status === 'embedded') {
        spent[kind] += result.cost;
      } else if (result.status === 'over') {
        // Put it back: the remainder pass may still afford it.
        queues[kind].unshift(request);
        closed.add(kind);
      } else {
        viewsOmitted += 1;
      }
    }
    if (!progressed) break;
  }

  /*
   * Whatever no kind claimed is offered back, round-robin, to the kinds that
   * still have requests queued. This is what keeps the quotas from *costing*
   * anything on a project small enough to embed whole: `defi/`'s queues run dry
   * long before any of them closes, and a project whose call graph is cheap gets
   * the contract views the call quota did not need.
   */
  let remaining = viewBudget - used;
  let draining = true;
  while (draining && remaining > 0) {
    draining = false;
    for (const kind of QUOTA_ORDER) {
      const request = queues[kind].shift();
      if (request === undefined) continue;
      const result = embed(request, remaining);
      if (result.status === 'over') {
        queues[kind].unshift(request);
        continue;
      }
      draining = true;
      if (result.status === 'refused') viewsOmitted += 1;
      remaining -= result.cost;
    }
  }

  // Everything still queued is a view this file could have held and does not.
  viewsOmitted += QUOTA_ORDER.reduce((total, kind) => total + queues[kind].length, 0);

  const ids = [...new Set(views.flatMap((entry) => drawnNodes(entry.view)))].sort();

  for (const id of ids) {
    if (used > budget * INSPECT_SHARE) break;
    try {
      // The node half is already in `nodeTable` — every id here came from a
      // view that put it there — so only the relations are new bytes.
      const split = dehydrateInspection(inspectNode(options.graph, id));
      inspections[id] = split.inspection;
      used += bytes(split.inspection);
    } catch {
      // A node in a view that cannot be inspected would be a bug in the engine
      // rather than in the export; the panel says so on the other side, and one
      // missing attribute set must not lose the whole deliverable.
    }
  }

  let sourceTruncated = false;
  for (const id of ids) {
    if (used > budget) {
      sourceTruncated = true;
      break;
    }
    try {
      // Three lines of context, the same as the live UI asks for, so the panel
      // in an export looks like the panel in the tool.
      const slice = sliceNode(options.graph, options.root, id, { context: 3 });
      sources[id] = slice;
      used += bytes(slice);
    } catch {
      // §10's synthetic placeholders have no source, and a file the graph was
      // built from a different checkout of is unreadable. Both are answers the
      // preview states rather than failures of the export.
    }
  }

  return {
    payloadVersion: PAYLOAD_VERSION,
    generatedAt: new Date().toISOString(),
    meta: options.meta,
    overlays: options.overlays,
    nodeTable,
    views,
    inspections,
    sources,
    limits: { viewsOmitted, sourceTruncated, bytes: used },
  };
}

/**
 * `</script>` inside embedded JSON would close the tag it is inside.
 *
 * A Solidity file containing that string in a comment is all it would take, and
 * the failure is a deliverable that renders as garbage on somebody else's
 * machine — after it has been sent. `<!--` and U+2028/9 are the same class of
 * problem: the first can open a comment in a classic script, the second two are
 * line terminators in JavaScript but not in JSON.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * §7's Phase 9: "**`elkjs` is `EPL-2.0 OR GPL-3.0-or-later`** … the `.vsix` and
 * the self-contained HTML export both *redistribute* it. Generate a
 * `THIRD-PARTY-NOTICES.md`, ship it in the `.vsix`, and embed the attribution
 * in the HTML export's footer."
 *
 * This is that footer. It is in the document rather than in a comment because
 * an attribution nobody can see is not one, and it names the other redistributed
 * dependencies for the same reason — the file contains cytoscape, React and
 * shiki as literally as it contains elkjs.
 */
/**
 * The footer is the export's only chrome, and it has to make room for itself.
 *
 * `styles.css` gives the app the full viewport height, so a footer added as a
 * sibling would be pushed off the bottom. It is fixed, and `#root` is inset by
 * its height — which keeps the attribution visible without the app's own layout
 * needing to know that an export exists.
 */
const FOOTER_STYLE = `
#root { height: calc(100% - 22px); }
.ax-export-footer {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 10px;
  font-family: var(--ax-ui);
  font-size: 10px;
  color: var(--ax-dim);
  background: var(--ax-panel);
  border-top: 1px solid var(--ax-border);
  white-space: nowrap;
  overflow: hidden;
}
`;

const ATTRIBUTION: readonly [string, string][] = [
  ['elkjs', 'EPL-2.0 OR GPL-3.0-or-later'],
  ['cytoscape', 'MIT'],
  ['react / react-dom', 'MIT'],
  ['shiki', 'MIT'],
];

export function renderHtml(payload: StaticPayload, options: HtmlExportOptions): string {
  const title = `Axiomap — ${options.project}`;
  const notices = ATTRIBUTION.map(([name, licence]) => `${name} (${licence})`).join(' · ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <!--
      Self-contained by construction. Decision #2 is zero network access, and
      this file is the one that leaves the building: it must not fetch a font, a
      script or a stylesheet from anywhere. Everything below is inline.
    -->
    <style>${options.bundle.style}</style>
    <style>${FOOTER_STYLE}</style>
  </head>
  <body>
    <div id="root"></div>
    <footer class="ax-export-footer">
      <span>
        Axiomap ${escapeHtml(options.version)} · ${escapeHtml(options.project)} ·
        generated ${escapeHtml(payload.generatedAt)}
      </span>
      <span>Bundled: ${escapeHtml(notices)}</span>
    </footer>
    <script>
      window.${'__AXIOMAP_PAYLOAD__'} = ${embedJson(payload)};
      window.${'__AXIOMAP_ELK_WORKER__'} = ${embedJson(options.bundle.elkWorker)};
    </script>
    <script type="module">${options.bundle.script}</script>
  </body>
</html>
`;
}
