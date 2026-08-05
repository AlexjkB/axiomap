/**
 * §9 rule 6: **layout in a web worker.**
 *
 * "Render nodes unlaid-out immediately, animate into position when ELK returns.
 * Never block on layout." ELK layered on a few hundred compound nodes is tens to
 * hundreds of milliseconds of straight-line JavaScript, and on the main thread
 * that is a frozen viewport — no pan, no zoom, no scroll — for exactly as long.
 * So it runs here, and the only thing crossing the boundary is JSON.
 *
 * This file is the whole of the worker: a request in, positions out, one ELK
 * instance reused across requests because constructing one is not free. It is
 * deliberately thin — everything worth testing lives in `elk-graph.ts`, on the
 * side of the boundary a test can reach.
 */

import ELK from 'elkjs/lib/elk.bundled.js';

import { toPositions, type ElkRoot, type Positions } from './elk-graph.js';

export interface LayoutRequest {
  /** Echoed back, so a stale answer to a superseded view can be dropped. */
  id: number;
  graph: ElkRoot;
}

export type LayoutResponse =
  | { id: number; ok: true; positions: Positions; ms: number }
  | { id: number; ok: false; message: string };

const elk = new ELK();

/**
 * The worker's global scope, typed for the two calls this file makes.
 *
 * `lib.dom` and `lib.webworker` cannot both be loaded — they declare the same
 * globals with different types — and the rest of this package is a DOM program.
 * Naming the two members used here is smaller and more honest than switching
 * the whole package's lib set for one file.
 */
const scope = globalThis as unknown as {
  addEventListener(type: 'message', handler: (event: { data: LayoutRequest }) => void): void;
  postMessage(message: LayoutResponse): void;
};

scope.addEventListener('message', (event) => {
  const request = event.data;
  const started = Date.now();
  elk
    .layout(request.graph)
    .then((laidOut) => {
      const response: LayoutResponse = {
        id: request.id,
        ok: true,
        positions: toPositions(laidOut as ElkRoot),
        ms: Date.now() - started,
      };
      scope.postMessage(response);
    })
    .catch((error: unknown) => {
      // A layout that fails must not take the graph with it: the elements are
      // already on screen, unlaid-out, which is what rule 6 asks for anyway.
      const response: LayoutResponse = {
        id: request.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
      scope.postMessage(response);
    });
});
