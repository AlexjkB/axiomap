/**
 * The extension's half of §9 rule 1: six requests in, six answers out.
 *
 * `axiomap serve` answers the same six over HTTP (`cli/src/serve/server.ts`).
 * What the two share is everything that decides *what* the answer is — the
 * decoders, the query functions, the error shape — all of which are core's. What
 * differs is the twenty lines below, and that is the transport: a message with
 * an id instead of a URL with a query string.
 *
 * ### The important property is still what is not here
 *
 * There is no `graph` method, and there is no way to ask for one. The webview
 * cannot hold an `AxiomapGraph` (§5 leaves it unable to import a core
 * *function*), and this host has no branch that would send it one. §9 rule 1 is
 * expressed as the only door in the wall rather than as a convention, in this
 * transport as in the other.
 *
 * ### No `vscode` import
 *
 * A pure function from a request and a graph to a response, so the protocol is
 * testable without an editor — which matters more here than usual, because a
 * webview host is the one part of an extension you cannot step through.
 */

import {
  decodeNodeRequest,
  decodeSearchRequest,
  decodeSourceRequest,
  decodeViewRequest,
  describeProtocolError,
  inspectNode,
  projectMeta,
  searchNodes,
  selectAggregatedView,
  sliceNode,
  type AxiomapGraph,
  type GraphFile,
  type OverlayData,
} from '@axiomap/core';
import { CHANNEL, type BridgeRequest, type BridgeResponse } from '@axiomap/webview';

export interface HostSources {
  graph: AxiomapGraph;
  file: GraphFile;
  root: string;
  renderCap: number;
  overlays: OverlayData;
  /**
   * The source of a node, when the editor has a better copy than the disk does.
   *
   * §11's preview reads a byte range off disk, and an editor is the one host
   * where the file on disk is routinely *not* what the user is looking at — an
   * unsaved buffer is the normal state of a file being edited. `sliceNode`
   * reports drift when the bytes no longer match the graph, but it cannot report
   * a difference it cannot see, so the extension passes the buffer it has.
   */
  buffer?: (file: string) => string | undefined;
}

/** True when this message is one of ours. A webview receives other traffic. */
export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<BridgeRequest>;
  return (
    message.channel === CHANNEL &&
    typeof message.id === 'number' &&
    typeof message.method === 'string' &&
    typeof message.params === 'object' &&
    message.params !== null
  );
}

function result(id: number, value: unknown): BridgeResponse {
  return { channel: CHANNEL, id, result: value };
}

/**
 * Answer one request.
 *
 * Every failure comes back as an `error` on the same id rather than as a
 * rejection: a UI waiting on a correlation id that never arrives has no way to
 * tell a refusal from a host that died, and §9 rule 2's render cap is a refusal
 * the UI is expected to *act* on.
 */
export function answer(sources: HostSources, request: BridgeRequest): BridgeResponse {
  try {
    switch (request.method) {
      case 'meta':
        return result(
          request.id,
          projectMeta(sources.file, { root: sources.root, renderCap: sources.renderCap }),
        );

      case 'view': {
        const decoded = decodeViewRequest(request.params);
        return result(
          request.id,
          selectAggregatedView(sources.graph, {
            ...decoded,
            ...(decoded.renderCap === undefined ? { renderCap: sources.renderCap } : {}),
          }),
        );
      }

      case 'inspect': {
        const { id } = decodeNodeRequest(request.params);
        return result(request.id, inspectNode(sources.graph, id));
      }

      case 'overlays':
        return result(request.id, sources.overlays);

      case 'search': {
        const { query, limit } = decodeSearchRequest(request.params);
        return result(
          request.id,
          searchNodes(sources.graph, query, limit === undefined ? {} : { limit }),
        );
      }

      case 'source': {
        const { id, context } = decodeSourceRequest(request.params);
        return result(
          request.id,
          sliceNode(sources.graph, sources.root, id, {
            ...(context === undefined ? {} : { context }),
            ...(sources.buffer === undefined ? {} : { read: sources.buffer }),
          }),
        );
      }

      default: {
        // A method this host does not know is a webview from another version,
        // which is a thing to say rather than to answer with silence.
        const method: string = request.method;
        return {
          channel: CHANNEL,
          id: request.id,
          error: { name: 'UnknownMethod', message: `This host has no "${method}" method.` },
        };
      }
    }
  } catch (error) {
    return { channel: CHANNEL, id: request.id, error: describeProtocolError(error) };
  }
}
