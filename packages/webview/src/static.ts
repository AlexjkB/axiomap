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
  NodeInspection,
  OverlayData,
  ProjectMeta,
  SearchResults,
  SourceSlice,
  StaticPayload,
} from '@axiomap/core';

import { BridgeError, type HostBridge } from './bridge.js';

/** Where the exporter puts the payload. Read by the export entry, nowhere else. */
export const PAYLOAD_GLOBAL = '__AXIOMAP_PAYLOAD__';

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

  view(request: AggregatedViewOptions): Promise<AggregatedView> {
    const found = this.payload.views.find((entry) => sameViewRequest(entry.request, request));
    if (found !== undefined) return Promise.resolve(found.view);
    return Promise.reject(
      new BridgeError({
        name: 'NotExported',
        message:
          `This is an exported file, and it holds ${String(this.payload.views.length)} view` +
          `${this.payload.views.length === 1 ? '' : 's'} — not this one. ` +
          'Run axiomap serve on the project to go further than the export goes.',
      }),
    );
  }

  inspect(id: string): Promise<NodeInspection> {
    const found = this.payload.inspections[id];
    if (found !== undefined) return Promise.resolve(found);
    return Promise.reject(
      new BridgeError({
        name: 'NotExported',
        message: `This export does not carry the attributes of "${id}".`,
      }),
    );
  }

  overlays(): Promise<OverlayData> {
    return Promise.resolve(this.payload.overlays);
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
      .filter(
        (inspection) =>
          inspection.node.name.toLowerCase().includes(needle) ||
          inspection.id.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));

    return Promise.resolve({
      query: query.trim(),
      hits: matched.slice(0, cap).map((inspection) => ({
        id: inspection.id,
        name: inspection.node.name,
        kind: inspection.node.kind,
        scope: inspection.node.scope,
        file: inspection.node.file,
        line: inspection.node.src.line,
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
  // it is from a different tool, not render most of itself.
  return payload.payloadVersion === 1 ? payload : null;
}
