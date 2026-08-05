/**
 * The request half of §9 rule 1's wire format, written on this side of §5's
 * boundary.
 *
 * Core owns the *decode* — `decodeViewRequest` in `core/query/protocol.ts`,
 * which the host calls — and this file owns the encode. They are not shared
 * code and cannot be: §5 lets the webview import core's **types** and nothing
 * else, so a function is not something it can borrow.
 *
 * Written twice, they can drift, and drift here is silent: a UI that spells the
 * downstream hop limit `depth` against a host that reads `down` draws a graph
 * that is wrong rather than raising an error that is loud. So the pair is
 * pinned by a test that belongs to neither package — `test/serve-protocol.test.ts`
 * at the repo root — which asserts that decoding what this encodes returns the
 * request it started from.
 */

import type { AggregatedViewOptions } from '@axiomap/core';

/** Where `axiomap serve` listens. Pinned against core's constants by the same test. */
export const VIEW_ENDPOINT = '/api/view';
export const META_ENDPOINT = '/api/meta';

const EXPAND_SEPARATOR = ',';

/**
 * Request → query parameters.
 *
 * An option the caller did not set stays absent rather than being filled in
 * with a default here. The engine's defaults are the engine's (§9 rule 4's hop
 * limits, §13's `renderCap`), and a UI that shipped its own copy of them would
 * be a second source of truth for a number the graph is built with.
 */
export function encodeViewRequest(request: AggregatedViewOptions): Record<string, string> {
  const params: Record<string, string> = { view: request.view };
  if (request.focus !== undefined) params['focus'] = request.focus;
  if (request.up !== undefined) params['up'] = String(request.up);
  if (request.down !== undefined) params['down'] = String(request.down);
  if (request.includeTests !== undefined) params['includeTests'] = request.includeTests ? '1' : '0';
  if (request.renderCap !== undefined) params['renderCap'] = String(request.renderCap);
  if (request.cluster !== undefined) params['cluster'] = request.cluster ? '1' : '0';
  if (request.autoExpand !== undefined) params['autoExpand'] = request.autoExpand ? '1' : '0';
  if (request.expand !== undefined && request.expand.length > 0) {
    params['expand'] = request.expand.join(EXPAND_SEPARATOR);
  }
  return params;
}
