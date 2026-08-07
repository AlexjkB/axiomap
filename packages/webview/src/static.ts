/**
 * The third host: a file.
 *
 * `HostBridge` has two implementations that talk to a process — `HttpBridge`
 * here, and Phase 8's `postMessage` one. This is the one with nothing on the
 * other end: every answer was computed by `axiomap export --format html` and
 * inlined into the page (§12's "single self-contained HTML file with the graph
 * embedded"). The UI does not learn which bridge it got, which is the property
 * that makes the deliverable the same tool the auditor used rather than a
 * screenshot of it.
 *
 * ### What it refuses, and why that is the point
 *
 * A live host answers any request. A file answers the ones that were exported,
 * and the rest have to be *stated*: `BridgeError` with a sentence naming how
 * many views this file holds. §4's whole position is that a tool which cannot
 * answer should say so rather than show a plausible blank — and a client
 * opening an audit deliverable is exactly the reader who cannot tell an empty
 * graph from a broken one.
 */

import type {
  AggregatedView,
  AggregatedViewOptions,
  DisplayNode,
  GraphNode,
  NodeInspection,
  AuditState,
  ProjectMeta,
  SearchResults,
  SourceSlice,
  StaticAggregatedView,
  StaticInspection,
  StaticPayload,
} from '@axiomap/core';

import { BridgeError, type HostBridge } from './bridge.js';

/** Where the exporter puts the payload. Read by the export entry, nowhere else. */
export const PAYLOAD_GLOBAL = '__AXIOMAP_PAYLOAD__';

/** The payload shape this reader understands. Core's exporter writes the same number. */
export const READS_PAYLOAD_VERSION = 2;

/**
 * Put a view back together from the payload's node table.
 *
 * The exporter's `dehydrateView` is the other half, and this is written twice
 * for §5's reason — this package may import core's *types* and not its
 * functions, the same rule that makes `sameViewRequest` a pair. The repo-root
 * suite pins the round trip, because a hydrator that dropped a field would draw
 * a subtly wrong graph rather than raise anything: a lost `parent` puts a node
 * outside the directory box it belongs in, and nothing about that looks like an
 * error.
 *
 * A missing table entry is not one of those quiet failures — it means the file
 * is internally inconsistent, so it is stated rather than drawn around.
 */
export function hydrateView(
  view: StaticAggregatedView,
  nodeTable: Record<string, GraphNode>,
): AggregatedView {
  const nodes: DisplayNode[] = view.nodes.map((element) => {
    if (element.type === 'cluster') return element;
    const node = nodeTable[element.id];
    if (node === undefined) {
      throw new BridgeError({
        name: 'MalformedPayload',
        message: `This exported file draws "${element.id}" but does not carry it.`,
      });
    }
    return { type: 'node', id: element.id, node, parent: element.parent };
  });
  return { ...view, nodes };
}

/** As `hydrateView`, for §11's inspector. */
export function hydrateInspection(
  inspection: StaticInspection,
  nodeTable: Record<string, GraphNode>,
): NodeInspection {
  const node = nodeTable[inspection.id];
  if (node === undefined) {
    throw new BridgeError({
      name: 'MalformedPayload',
      message: `This exported file has the relations of "${inspection.id}" but not the node.`,
    });
  }
  return { ...inspection, node };
}

/**
 * Do two view requests ask for the same thing?
 *
 * Core has this too, as `sameViewRequest`, and this is the second
 * implementation — §5 lets this package import core's *types* and not its
 * functions, so the exporter's copy and the reader's copy are written twice for
 * the same reason `encodeViewRequest` and `decodeViewRequest` are. And they
 * drift the same silent way: a comparison that disagreed would answer a click
 * with the wrong view rather than raise anything. `test/serve-protocol.test.ts`
 * at the repo root pins the pair, which is where the other one is pinned.
 *
 * `expand` is compared as a set because the engine closes the expansion set
 * under its ancestors, so two orderings are the same request. Absent and
 * default are *not* equal: the exporter records the request it actually passed,
 * and guessing a default here would answer a question nobody asked.
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

export class StaticBridge implements HostBridge {
  private readonly payload: StaticPayload;

  constructor(payload: StaticPayload) {
    this.payload = payload;
  }

  /** The view this file opens on: the one the export was asked for. */
  get initial(): AggregatedViewOptions | null {
    return this.payload.views[0]?.request ?? null;
  }

  meta(): Promise<ProjectMeta> {
    return Promise.resolve(this.payload.meta);
  }

  /**
   * What this file holds, in the terms the exporter's quota spends it in.
   *
   * The refusal below names the mix rather than one total, because "190 views"
   * and "60 contract views and 129 call graphs" answer different questions, and
   * the reader who has just been refused is asking the second one.
   */
  private held(): string {
    const counts = new Map<string, number>();
    for (const entry of this.payload.views) {
      const kind = entry.request.view;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts]
      .map(([kind, count]) => `${String(count)} ${kind}`)
      .join(', ');
  }

  view(request: AggregatedViewOptions): Promise<AggregatedView> {
    const found = this.payload.views.find((entry) => sameViewRequest(entry.request, request));
    if (found !== undefined) {
      try {
        return Promise.resolve(hydrateView(found.view, this.payload.nodeTable));
      } catch (error) {
        return Promise.reject(error as Error);
      }
    }
    return Promise.reject(
      new BridgeError({
        name: 'NotExported',
        message:
          `This is an exported file, and it holds ${String(this.payload.views.length)} view` +
          `${this.payload.views.length === 1 ? '' : 's'} (${this.held()}) — not this one. ` +
          'Run axiomap serve on the project to go further than the export goes.',
      }),
    );
  }

  inspect(id: string): Promise<NodeInspection> {
    const found = this.payload.inspections[id];
    if (found !== undefined) {
      try {
        return Promise.resolve(hydrateInspection(found, this.payload.nodeTable));
      } catch (error) {
        return Promise.reject(error as Error);
      }
    }
    return Promise.reject(
      new BridgeError({
        name: 'NotExported',
        message: `This export does not carry the attributes of "${id}".`,
      }),
    );
  }

  auditState(): Promise<AuditState> {
    return Promise.resolve(this.payload.auditState);
  }

  /**
   * Searching an export searches what the export contains.
   *
   * The match runs over the inspections that were embedded, which is a smaller
   * set than the project — so the palette is honest by construction here: it
   * cannot offer a node this file could not then show. The ranking is
   * deliberately simpler than `searchNodes`': a plain substring, because the
   * candidate set is already small and a second ranking implementation is a
   * second thing to disagree with the first.
   */
  search(query: string, limit?: number): Promise<SearchResults> {
    const needle = query.trim().toLowerCase();
    const cap = Math.min(limit ?? 20, 50);
    if (needle === '') {
      return Promise.resolve({ query: '', hits: [], total: 0, capped: false, limit: cap });
    }

    const matched = Object.values(this.payload.inspections)
      // A node in the table with no inspection is not offered: the palette must
      // not name something the panel would then refuse.
      .flatMap((inspection) => {
        const node = this.payload.nodeTable[inspection.id];
        return node === undefined ? [] : [{ id: inspection.id, node }];
      })
      .filter(
        (entry) =>
          entry.node.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));

    return Promise.resolve({
      query: query.trim(),
      hits: matched.slice(0, cap).map((entry) => ({
        id: entry.id,
        name: entry.node.name,
        kind: entry.node.kind,
        scope: entry.node.scope,
        file: entry.node.file,
        line: entry.node.src.line,
        match: 'contains' as const,
      })),
      total: matched.length,
      capped: matched.length > cap,
      limit: cap,
    });
  }

  source(id: string): Promise<SourceSlice> {
    const found = this.payload.sources[id];
    if (found !== undefined) return Promise.resolve(found);
    return Promise.reject(
      new BridgeError({
        name: 'NotExported',
        message: this.payload.limits.sourceTruncated
          ? 'This export was too large to carry every source range, and this node’s was left out.'
          : 'This export does not carry source for this node.',
      }),
    );
  }
}

/** The payload the exporter inlined, or null in a page that is not an export. */
export function readEmbeddedPayload(): StaticPayload | null {
  const value = (globalThis as Record<string, unknown>)[PAYLOAD_GLOBAL];
  if (typeof value !== 'object' || value === null) return null;
  const payload = value as StaticPayload;
  // A version mismatch is refused rather than half-read, for the reason §3
  // gives `graph.json` a `schemaVersion`: a file opened a year later should say
  // it is from a different tool, not render most of itself. v1 is a real case
  // now rather than a hypothetical one — it embedded a whole node everywhere a
  // node appeared, and half-reading one would draw views with no nodes in them.
  return payload.payloadVersion === READS_PAYLOAD_VERSION ? payload : null;
}
