/**
 * How the UI reaches the graph — and the only way it does.
 *
 * §9 rule 1: "The webview never receives the full graph. Core exposes a query
 * API; the webview requests subgraphs by view + filter + focus. In VS Code this
 * is `postMessage`; in browser mode it is a local HTTP endpoint from `axiomap
 * serve`." Two hosts, one interface, and behind both of them exactly one core
 * call: `selectAggregatedView`. Nothing in this package holds an
 * `AxiomapGraph`, and there is no code path by which it could — the type-only
 * import below is the whole of its relationship with core (§5).
 *
 * `HttpBridge` is the browser-mode half. Phase 8's VS Code host implements the
 * same interface over `postMessage`, and the UI does not learn which one it got.
 */

import type {
  AggregatedView,
  AggregatedViewOptions,
  NodeInspection,
  OverlayData,
  ProjectMeta,
  ProtocolError,
  SearchResults,
  SourceSlice,
} from '@axiomap/core';

import {
  META_ENDPOINT,
  NODE_ENDPOINT,
  OVERLAY_ENDPOINT,
  SEARCH_ENDPOINT,
  SOURCE_ENDPOINT,
  VIEW_ENDPOINT,
  encodeNodeRequest,
  encodeSearchRequest,
  encodeSourceRequest,
  encodeViewRequest,
} from './protocol.js';

export interface HostBridge {
  /** §4's mode, its copy, and the resolution score. Header, not graph content. */
  meta(): Promise<ProjectMeta>;
  /** One view + filter + focus request. The only door into the graph. */
  view(request: AggregatedViewOptions): Promise<AggregatedView>;
  /**
   * §11's inspector: one node's attributes and relations.
   *
   * It is a *bridge* method rather than something the panel derives from the
   * view it is already holding, because a view carries only what it draws — a
   * caller outside the current hop limit, or in a collapsed directory, is not
   * in it. Deriving the panel from the drawn subgraph would make the inspector
   * quietly answer "callers I happen to be showing you", which is not the
   * question §11 asks it.
   */
  inspect(id: string): Promise<NodeInspection>;
  /** §11's review-state and imported-findings overlays. Two files, not the graph. */
  overlays(): Promise<OverlayData>;
  /**
   * §11's `/` fuzzy search palette.
   *
   * The match runs on the host and the result is capped there. This method
   * exists rather than a `nodes()` the UI could filter itself precisely because
   * the latter is §9 rule 1's forbidden payload with a search box drawn on it.
   */
  search(query: string, limit?: number): Promise<SearchResults>;
  /**
   * §11's inline code preview: a byte range around one node's `src`.
   *
   * The first thing across this bridge that is the *user's source* rather than
   * something derived from it, which is why it takes a node id and not a path —
   * the file comes from the graph. See `core/source/slice.ts`.
   */
  source(id: string, context?: number): Promise<SourceSlice>;
}

/**
 * An error the host refused a request with, carrying its numbers.
 *
 * §9 rule 2 makes exceeding the render cap "an error with an actionable
 * message, never a silent hairball", and actionable means the UI can offer the
 * way out rather than only reprint the sentence — so `elements` and `cap`
 * survive the wire as fields.
 */
export class BridgeError extends Error {
  readonly detail: ProtocolError;

  constructor(detail: ProtocolError) {
    super(detail.message);
    this.name = detail.name === '' ? 'BridgeError' : detail.name;
    this.detail = detail;
  }

  /** True when the host refused because the result was too big to draw. */
  get isRenderCap(): boolean {
    return this.detail.name === 'RenderCapError';
  }
}

/** The part of `fetch` this file uses, so a test can supply one without a DOM. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface HttpBridgeOptions {
  /** Where `axiomap serve` is listening. Defaults to the page's own origin. */
  base?: string;
  fetch?: FetchLike;
}

function isErrorEnvelope(value: unknown): value is { error: ProtocolError } {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null && 'message' in error;
}

/** Browser mode: one local HTTP endpoint, on the origin that served the page. */
export class HttpBridge implements HostBridge {
  private readonly base: string;
  private readonly get: FetchLike;

  constructor(options: HttpBridgeOptions = {}) {
    this.base = (options.base ?? '').replace(/\/$/, '');
    // Bound, because an unbound `fetch` throws "Illegal invocation".
    this.get = options.fetch ?? ((url: string) => globalThis.fetch(url));
  }

  url(endpoint: string, params: Record<string, string> = {}): string {
    const query = Object.entries(params)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    return `${this.base}${endpoint}${query === '' ? '' : `?${query}`}`;
  }

  private async fetchJson(url: string): Promise<unknown> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.get(url);
    } catch {
      throw new BridgeError({
        name: 'HostUnreachable',
        message:
          `Could not reach axiomap serve at ${this.base === '' ? "this page's origin" : this.base}. ` +
          'Is it still running?',
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      if (isErrorEnvelope(body)) throw new BridgeError(body.error);
      throw new BridgeError({
        name: 'HostError',
        message: `The host answered ${String(response.status)} with no explanation.`,
      });
    }
    return body;
  }

  async meta(): Promise<ProjectMeta> {
    return (await this.fetchJson(this.url(META_ENDPOINT))) as ProjectMeta;
  }

  async view(request: AggregatedViewOptions): Promise<AggregatedView> {
    return (await this.fetchJson(
      this.url(VIEW_ENDPOINT, encodeViewRequest(request)),
    )) as AggregatedView;
  }

  async inspect(id: string): Promise<NodeInspection> {
    return (await this.fetchJson(this.url(NODE_ENDPOINT, encodeNodeRequest(id)))) as NodeInspection;
  }

  async overlays(): Promise<OverlayData> {
    return (await this.fetchJson(this.url(OVERLAY_ENDPOINT))) as OverlayData;
  }

  async search(query: string, limit?: number): Promise<SearchResults> {
    return (await this.fetchJson(
      this.url(SEARCH_ENDPOINT, encodeSearchRequest(query, limit)),
    )) as SearchResults;
  }

  async source(id: string, context?: number): Promise<SourceSlice> {
    return (await this.fetchJson(
      this.url(SOURCE_ENDPOINT, encodeSourceRequest(id, context)),
    )) as SourceSlice;
  }
}
