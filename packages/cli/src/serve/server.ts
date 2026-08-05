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
  RenderCapError,
  ViewError,
  callDefaults,
  decodeViewRequest,
  selectAggregatedView,
  VIEW_NAMES,
  type AxiomapGraph,
  type GraphFile,
  type ProjectMeta,
  type ProtocolError,
} from '@axiomap/core';

const VIEW_ENDPOINT = '/api/view';
const META_ENDPOINT = '/api/meta';

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

function toProtocolError(error: unknown): { status: number; body: ProtocolError } {
  if (error instanceof RenderCapError) {
    return {
      // 422: the request was understood and is a thing this host will not do.
      status: 422,
      body: {
        name: 'RenderCapError',
        message: error.message,
        elements: error.elements,
        cap: error.cap,
        view: error.view,
      },
    };
  }
  if (error instanceof ViewError) {
    return { status: 400, body: { name: 'ViewError', message: error.message } };
  }
  return {
    status: 500,
    body: { name: 'Error', message: error instanceof Error ? error.message : String(error) },
  };
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
 * Spelled as an explicit field list rather than a rest-destructure so that a
 * field added to `GraphFile` later is *not* published by accident. §9 rule 1 is
 * a rule about what leaves this process, and "whatever the artifact happens to
 * contain" is not a payload anyone decided on.
 */
function metaOf(options: ServerOptions): ProjectMeta {
  const file = options.file;
  const header = {
    schemaVersion: file.schemaVersion,
    generator: file.generator,
    project: file.project,
    mode: file.mode,
    modeReason: file.modeReason,
    score: file.score,
    diagnostics: file.diagnostics,
  };
  return {
    ...header,
    root: options.root,
    renderCap: options.renderCap ?? 1500,
    views: VIEW_NAMES,
    callDefaults: callDefaults(),
  };
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

export function createServer(options: ServerOptions): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, {
        error: { name: 'MethodNotAllowed', message: 'This host answers GET only.' },
      });
      return;
    }

    if (url.pathname === META_ENDPOINT) {
      sendJson(response, 200, metaOf(options));
      return;
    }

    if (url.pathname === VIEW_ENDPOINT) {
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) params[key] = value;
      try {
        const request_ = decodeViewRequest(params);
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
