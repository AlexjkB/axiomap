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
 * them could be embedded. The exporter walks them breadth-first from the one
 * that was asked for and stops at a byte budget, then records what it left out.
 * A deliverable that silently stops answering at the third click is worse than
 * one that says how far it goes — the same argument §9 rule 2 makes for the
 * render cap, and §4 makes for everything else.
 */

import {
  inspectNode,
  RenderCapError,
  selectAggregatedView,
  sliceNode,
  type AggregatedView,
  type AggregatedViewOptions,
  type AxiomapGraph,
  type NodeInspection,
  type OverlayData,
  type ProjectMeta,
  type SourceSlice,
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
function drawnNodes(view: AggregatedView): string[] {
  return view.nodes.flatMap((element) => (element.type === 'node' ? [element.node.id] : []));
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
  const inspections: Record<string, NodeInspection> = {};
  const sources: Record<string, SourceSlice> = {};

  let used = 0;
  let viewsOmitted = 0;

  const seen = new Set<string>();
  const queue: AggregatedViewOptions[] = [options.initial];
  seen.add(requestKey(options.initial));

  while (queue.length > 0) {
    const request = queue.shift() as AggregatedViewOptions;

    let view: AggregatedView;
    try {
      view = selectAggregatedView(options.graph, request);
    } catch (error) {
      // A view the engine refuses is not a gap in the export: §9 rule 2's
      // refusal is the correct answer to that request, and the reader gets the
      // same refusal from `StaticBridge`. Anything else is a real failure and
      // should not be swallowed.
      if (error instanceof RenderCapError) {
        viewsOmitted += 1;
        continue;
      }
      throw error;
    }

    const cost = bytes(view);
    // The first view is always embedded, whatever it costs: a file that opened
    // on nothing because the budget was tight would be worse than a large file.
    if (views.length > 0 && used + cost > budget * VIEW_SHARE) {
      viewsOmitted += 1;
      continue;
    }

    views.push({ request, view });
    used += cost;

    for (const next of nextRequests(request, view, options.meta.callDefaults)) {
      const key = requestKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }

  const ids = [...new Set(views.flatMap((entry) => drawnNodes(entry.view)))].sort();

  for (const id of ids) {
    if (used > budget * INSPECT_SHARE) break;
    try {
      const inspection = inspectNode(options.graph, id);
      inspections[id] = inspection;
      used += bytes(inspection);
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
    payloadVersion: 1,
    generatedAt: new Date().toISOString(),
    meta: options.meta,
    overlays: options.overlays,
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
