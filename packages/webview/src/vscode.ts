/**
 * The fourth host: VS Code, over `postMessage` (§9 rule 1's other half).
 *
 * §9 rule 1 names two transports for one interface — "in VS Code this is
 * `postMessage`; in browser mode it is a local HTTP endpoint" — and Phase 7
 * built the interface so that this file is the whole difference. `HttpBridge`
 * turns a request into a URL; this turns it into a message and waits for the
 * answer with the same id. The UI does not learn which one it got, which is the
 * property `StaticBridge` already demonstrated from the third direction.
 *
 * ### Correlation ids, and nothing else
 *
 * A webview's channel is one unordered stream in each direction, so every
 * request carries an id and every answer quotes it. Requests are *not* queued
 * or deduplicated here: `App` already cancels the ones it no longer wants by
 * ignoring their results, and a bridge that silently coalesced two calls would
 * be making a decision about freshness that belongs to the caller.
 *
 * ### Two things this has that the other bridges do not
 *
 * `HostBridge` is request/response, which is all a browser tab and a static
 * file can be. An editor is a live host, and Phase 8's exit criterion is
 * bidirectional navigation — so there are two *notification* channels beside
 * it, deliberately outside the interface the UI shares with the other hosts:
 *
 * - **`reveal`**, webview → editor: §11's "click node → reveal in editor" and
 *   "click edge → reveal the call site". It is fire-and-forget, because the
 *   answer is an editor moving rather than a value.
 * - **`select` / `refresh`**, editor → webview: §11's inverse navigation ("the
 *   editor cursor highlights the corresponding graph node") and the artifact
 *   watch telling the UI its graph was rebuilt underneath it.
 *
 * Both are typed here, and the extension owns the other end.
 */

import type {
  AggregatedView,
  AggregatedViewOptions,
  NodeInspection,
  AuditState,
  ProjectMeta,
  ProtocolError,
  SearchResults,
  SourceSlice,
} from '@axiomap/core';

import { BridgeError, type HostBridge } from './bridge.js';
import {
  encodeNodeRequest,
  encodeSearchRequest,
  encodeSourceRequest,
  encodeViewRequest,
} from './protocol.js';

/** Marks a message as this protocol's, so a stray `postMessage` is ignored. */
export const CHANNEL = 'axiomap';

/** The six `HostBridge` methods, as they travel. */
export type BridgeMethod = 'meta' | 'view' | 'inspect' | 'auditState' | 'search' | 'source';

/**
 * A request in flight.
 *
 * `params` is the **same encoding browser mode puts in a query string** —
 * `encodeViewRequest` and friends, flat string pairs — rather than the request
 * object itself, which a structured channel could carry. That is deliberate: it
 * means a `postMessage` host decodes with `decodeViewRequest`, the function the
 * repo-root test already pins against that encoder, and there is no third
 * spelling of a view request for the two existing ones to drift from. The
 * transport differs; the message does not.
 */
export interface BridgeRequest {
  channel: typeof CHANNEL;
  id: number;
  method: BridgeMethod;
  params: Record<string, string>;
}

export interface BridgeResponse {
  channel: typeof CHANNEL;
  id: number;
  result?: unknown;
  error?: ProtocolError;
}

/**
 * Where an editor should put the cursor.
 *
 * A node reveals at its declaration; an edge reveals at its **call site**
 * (§10: "clicking the edge from `deposit` to `_mint` lands inside `deposit` at
 * the exact call — not at `_mint`'s definition"). The site travels as a
 * `SourceRef`'s fields rather than as a node id, because there is no node at a
 * call site — that is the whole reason §10 puts a `src` on every edge.
 */
export type RevealTarget =
  | { kind: 'node'; id: string }
  | { kind: 'site'; file: string; line: number; column: number };

export interface RevealMessage {
  channel: typeof CHANNEL;
  event: 'reveal';
  target: RevealTarget;
}

/**
 * Editor → webview.
 *
 * `select` and `focus` are deliberately different events, because the two things
 * that produce them are different requests. A **cursor** landing on a
 * declaration means "highlight this" — the user is reading code and the graph is
 * following along, and dragging the view somewhere else on every keystroke would
 * make the panel unusable while typing. A **command** (a CodeLens click, "reveal
 * in graph") means "go here", which is §11's "focus here" arriving from outside
 * the webview.
 *
 * `refresh` means the host's graph is no longer the one every answer the UI is
 * holding was about.
 */
export type HostEvent =
  | { channel: typeof CHANNEL; event: 'select'; id: string; kind: string }
  | { channel: typeof CHANNEL; event: 'focus'; id: string; kind: string }
  | { channel: typeof CHANNEL; event: 'refresh'; reason: string };

/** The slice of the VS Code webview API this file uses. */
export interface VsCodeApi {
  postMessage(message: unknown): void;
}

/** Messages this window receives, as the DOM delivers them. */
type Incoming = BridgeResponse | HostEvent;

function isOurs(value: unknown): value is Incoming {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { channel?: unknown }).channel === CHANNEL
  );
}

export interface VsCodeBridgeOptions {
  api: VsCodeApi;
  /** `window` in the webview; injectable so the protocol is testable without one. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * `HostBridge` over `postMessage`, plus the two notification channels.
 */
export class VsCodeBridge implements HostBridge {
  readonly #api: VsCodeApi;
  readonly #target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();

  #next = 1;
  #selectListeners = new Set<(id: string, kind: string) => void>();
  #focusListeners = new Set<(id: string, kind: string) => void>();
  #refreshListeners = new Set<(reason: string) => void>();

  constructor(options: VsCodeBridgeOptions) {
    this.#api = options.api;
    this.#target = options.target ?? window;
    this.#target.addEventListener('message', this.#onMessage as EventListener);
  }

  #onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isOurs(message)) return;

    if ('event' in message) {
      if (message.event === 'select') {
        for (const listener of this.#selectListeners) listener(message.id, message.kind);
      } else if (message.event === 'focus') {
        for (const listener of this.#focusListeners) listener(message.id, message.kind);
      } else {
        for (const listener of this.#refreshListeners) listener(message.reason);
      }
      return;
    }

    const waiting = this.#pending.get(message.id);
    if (waiting === undefined) return;
    this.#pending.delete(message.id);
    if (message.error !== undefined) waiting.reject(new BridgeError(message.error));
    else waiting.resolve(message.result);
  };

  #call<T>(method: BridgeMethod, params: Record<string, string>): Promise<T> {
    const id = this.#next;
    this.#next += 1;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      const request: BridgeRequest = { channel: CHANNEL, id, method, params };
      try {
        this.#api.postMessage(request);
      } catch (cause) {
        this.#pending.delete(id);
        reject(
          new BridgeError({
            name: 'HostUnreachable',
            message: `The extension host did not accept the request: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
        );
      }
    });
  }

  meta(): Promise<ProjectMeta> {
    return this.#call<ProjectMeta>('meta', {});
  }

  view(request: AggregatedViewOptions): Promise<AggregatedView> {
    return this.#call<AggregatedView>('view', encodeViewRequest(request));
  }

  inspect(id: string): Promise<NodeInspection> {
    return this.#call<NodeInspection>('inspect', encodeNodeRequest(id));
  }

  auditState(): Promise<AuditState> {
    return this.#call<AuditState>('auditState', {});
  }

  search(query: string, limit?: number): Promise<SearchResults> {
    return this.#call<SearchResults>('search', encodeSearchRequest(query, limit));
  }

  source(id: string, context?: number): Promise<SourceSlice> {
    return this.#call<SourceSlice>('source', encodeSourceRequest(id, context));
  }

  /** §11: click a node, and the editor goes to its declaration. */
  reveal(target: RevealTarget): void {
    const message: RevealMessage = { channel: CHANNEL, event: 'reveal', target };
    this.#api.postMessage(message);
  }

  /** §11's inverse navigation: the editor's cursor moved onto a node. */
  onSelect(listener: (id: string, kind: string) => void): () => void {
    this.#selectListeners.add(listener);
    return () => this.#selectListeners.delete(listener);
  }

  /** A command asked for a node: §11's "focus here", from outside the webview. */
  onFocus(listener: (id: string, kind: string) => void): () => void {
    this.#focusListeners.add(listener);
    return () => this.#focusListeners.delete(listener);
  }

  /** The artifact watch: the host rebuilt, so what is drawn is out of date. */
  onRefresh(listener: (reason: string) => void): () => void {
    this.#refreshListeners.add(listener);
    return () => this.#refreshListeners.delete(listener);
  }

  dispose(): void {
    this.#target.removeEventListener('message', this.#onMessage as EventListener);
    for (const waiting of this.#pending.values()) {
      waiting.reject(new BridgeError({ name: 'Disposed', message: 'The webview was closed.' }));
    }
    this.#pending.clear();
    this.#selectListeners.clear();
    this.#focusListeners.clear();
    this.#refreshListeners.clear();
  }
}

/**
 * The handle VS Code gives a webview script, once per document.
 *
 * Calling it twice throws, so the result is memoised — React 18's StrictMode
 * mounts everything twice in development and would otherwise take the whole UI
 * down before it drew anything.
 */
let acquired: VsCodeApi | null = null;

export function acquireApi(): VsCodeApi {
  if (acquired !== null) return acquired;
  const acquire = (globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
  if (acquire === undefined) {
    throw new Error('acquireVsCodeApi is not available: this bundle is the VS Code entry point.');
  }
  acquired = acquire();
  return acquired;
}
