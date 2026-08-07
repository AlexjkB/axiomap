/**
 * §9 rule 1 in browser mode: "a local HTTP endpoint from `axiomap serve`".
 *
 * Two data routes and a static directory, and the important property is what is
 * *not* here — there is no route that returns the graph. `/api/view` calls
 * `selectAggregatedView` and returns what it returns; a client that wants
 * something else asks a different question. That is the rule, expressed as the
 * only door in the wall rather than as a convention.
 *
 * ### Loopback by default
 *
 * Decision #2 is zero network access, and while a local server is not an
 * outbound connection, the spirit is the same: this tool is pointed at
 * confidential client code, and a graph of it should not appear on a coffee-shop
 * LAN because a default was convenient. `127.0.0.1` unless someone explicitly
 * asks otherwise, and when they do, the banner says what they just published.
 *
 * ### The graph is built once
 *
 * `serve` is "build + open the UI" (§12). Re-graphing per request would put a
 * multi-second parse behind a click, and watching for edits is Phase 8's
 * artifact watch. A source file that changes under a running server is not
 * picked up; the banner says so, and restarting is one keystroke.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  NodeNotFoundError,
  RenderCapError,
  SourceUnavailableError,
  ViewError,
  DEFAULT_RENDER_CAP,
  decodeNodeRequest,
  decodeSearchRequest,
  decodeSourceRequest,
  decodeViewRequest,
  describeProtocolError,
  inspectNode,
  auditState,
  projectMeta,
  searchNodes,
  selectAggregatedView,
  sliceNode,
  type AxiomapGraph,
  type FindingsFile,
  type GraphFile,
  type AuditState,
  type ProjectMeta,
  type ProtocolError,
  type ReviewState,
} from '@axiomap/core';

const VIEW_ENDPOINT = '/api/view';
const META_ENDPOINT = '/api/meta';
const NODE_ENDPOINT = '/api/node';
const AUDIT_STATE_ENDPOINT = '/api/audit-state';
const SEARCH_ENDPOINT = '/api/search';
const SOURCE_ENDPOINT = '/api/source';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

export interface ServerOptions {
  graph: AxiomapGraph;
  file: GraphFile;
  root: string;
  /** Built webview bundle to serve as static files. */
  assets: string;
  /** §13's `renderCap`, already resolved by the caller. */
  renderCap?: number;
  /**
   * `.axiomap/review.json` and `.axiomap/findings.json`, already read (the two
   * audit-state files). Absent means the file was not there, which the
   * UI distinguishes from present-and-empty: "nobody has reviewed anything" and
   * "everything is unreviewed" are the same picture and different sentences.
   */
  review?: ReviewState | null;
  findings?: FindingsFile | null;
  host?: string;
  /** 0 asks the OS for a free port, which is what the tests use. */
  port?: number;
}

export interface ServeHandle {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * An error, as HTTP carries it.
 *
 * The *body* is `describeProtocolError`'s, in core, because Phase 8's
 * `postMessage` host sends the same shape and a UI reads one of them. What is
 * HTTP's alone, and stays here, is the status: which of these is a refusal, a
 * missing thing, or a fault.
 */
function toProtocolError(error: unknown): { status: number; body: ProtocolError } {
  const body = describeProtocolError(error);
  // 422: the request was understood and is a thing this host will not do.
  if (error instanceof RenderCapError) return { status: 422, body };
  if (error instanceof ViewError) return { status: 400, body };
  if (error instanceof NodeNotFoundError) return { status: 404, body };
  // 404 rather than 500: a node with nothing readable behind it is an answer
  // about the graph, not a fault. An `Unresolved` placeholder and a file the
  // graph was built from a different checkout of both land here, and both are
  // things the panel says out loud rather than states as an error.
  if (error instanceof SourceUnavailableError) return { status: 404, body };
  return { status: 500, body };
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // Nothing here is cacheable: the next request may be a different view of a
    // graph the user just rebuilt.
    'cache-control': 'no-store',
  });
  response.end(body);
}

/**
 * The graph file minus the graph.
 *
 * The field list is `projectMeta`'s, in core, since Phase 8 gave the extension
 * the same header to publish — see there for why it is an explicit list rather
 * than a rest-destructure.
 */
function metaOf(options: ServerOptions): ProjectMeta {
  return projectMeta(options.file, {
    root: options.root,
    renderCap: options.renderCap ?? DEFAULT_RENDER_CAP,
  });
}

/**
 * Static files, refusing anything outside the bundle.
 *
 * The path traversal guard is not theatre: this process has a graph of somebody
 * else's protocol open and read access to their whole checkout, and a `..` in a
 * URL is the cheapest way to turn a viewer into a file server.
 */
function sendAsset(response: http.ServerResponse, assets: string, pathname: string): void {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(assets, relative);
  if (target !== assets && !target.startsWith(assets + path.sep)) {
    sendJson(response, 403, { error: { name: 'Forbidden', message: 'Outside the bundle.' } });
    return;
  }

  let body: Buffer;
  try {
    body = fs.readFileSync(target);
  } catch {
    sendJson(response, 404, {
      error: { name: 'NotFound', message: `No such asset: ${relative}` },
    });
    return;
  }

  response.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  response.end(body);
}

/**
 * The two audit-state files, projected onto node ids.
 *
 * Computed once: both are read at startup like the graph, and `auditState` is
 * a pure function of them, so recomputing per request would spend the staleness
 * pass over every entry to produce the same bytes.
 */
function auditStateOf(options: ServerOptions): AuditState {
  return auditState(options.graph, {
    review: options.review ?? null,
    findings: options.findings ?? null,
  });
}

function queryParams(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) params[key] = value;
  return params;
}

export function createServer(options: ServerOptions): http.Server {
  const audit = auditStateOf(options);

  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, {
        error: { name: 'MethodNotAllowed', message: 'This host answers GET only.' },
      });
      return;
    }

    // A browser asks for this unprompted, and a 404 in the console of a tool
    // whose job is to be trustworthy about what it found is a bad first
    // impression. No icon is a fine answer; an error is not.
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }

    if (url.pathname === META_ENDPOINT) {
      sendJson(response, 200, metaOf(options));
      return;
    }

    if (url.pathname === VIEW_ENDPOINT) {
      try {
        const request_ = decodeViewRequest(queryParams(url));
        const view = selectAggregatedView(options.graph, {
          ...request_,
          ...(request_.renderCap === undefined && options.renderCap !== undefined
            ? { renderCap: options.renderCap }
            : {}),
        });
        sendJson(response, 200, view);
      } catch (error) {
        const { status, body } = toProtocolError(error);
        sendJson(response, status, { error: body });
      }
      return;
    }

    if (url.pathname === AUDIT_STATE_ENDPOINT) {
      sendJson(response, 200, audit);
      return;
    }

    if (url.pathname === NODE_ENDPOINT) {
      try {
        const { id } = decodeNodeRequest(queryParams(url));
        sendJson(response, 200, inspectNode(options.graph, id));
      } catch (error) {
        const { status, body } = toProtocolError(error);
        sendJson(response, status, { error: body });
      }
      return;
    }

    // §11's palette. The match and the cap are both `searchNodes`', on this
    // side of the bridge — see `core/query/search.ts` for why that is §9 rule
    // 1 rather than an optimisation.
    if (url.pathname === SEARCH_ENDPOINT) {
      try {
        const { query, limit } = decodeSearchRequest(queryParams(url));
        sendJson(
          response,
          200,
          searchNodes(options.graph, query, limit === undefined ? {} : { limit }),
        );
      } catch (error) {
        const { status, body } = toProtocolError(error);
        sendJson(response, status, { error: body });
      }
      return;
    }

    /*
     * §11's code preview, and the only route that reads a file off disk in
     * response to a request.
     *
     * It is safe for a reason that is structural rather than careful: the
     * request carries a **node id**, and `sliceNode` takes the path from the
     * graph. There is no parameter here that names a file, so the static-asset
     * guard's problem — a `..` in a URL turning a viewer into a file server —
     * does not have an analogue to defend against.
     */
    if (url.pathname === SOURCE_ENDPOINT) {
      try {
        const { id, context } = decodeSourceRequest(queryParams(url));
        sendJson(
          response,
          200,
          sliceNode(options.graph, options.root, id, context === undefined ? {} : { context }),
        );
      } catch (error) {
        const { status, body } = toProtocolError(error);
        sendJson(response, status, { error: body });
      }
      return;
    }

    sendAsset(response, options.assets, url.pathname);
  });
}

export async function startServer(options: ServerOptions): Promise<ServeHandle> {
  const server = createServer(options);
  const host = options.host ?? '127.0.0.1';

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    url: `http://${shown.includes(':') ? `[${shown}]` : shown}:${String(address.port)}/`,
    host,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve();
          else reject(error);
        });
        // Keep-alive sockets would hold the process open past close().
        server.closeAllConnections();
      }),
  };
}
