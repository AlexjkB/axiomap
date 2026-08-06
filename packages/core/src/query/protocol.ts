/**
 * The wire shape of §9 rule 1.
 *
 * Rule 1 says the webview never receives the full graph: it "requests subgraphs
 * by view + filter + focus", over `postMessage` in VS Code and a local HTTP
 * endpoint under `axiomap serve`. `selectAggregatedView` is the call that
 * answers such a request, and it already lives in this directory.
 *
 * What did not exist is an agreed spelling of the request itself. This file is
 * the host's half of it: the types both ends speak, and the decode a host
 * applies to whatever arrived. The encode is the webview's half and lives
 * there, because §5 lets that package import core's *types* and not its
 * functions — so the two are pinned against each other by a test at the repo
 * root rather than shared as code.
 *
 * Nothing here knows a transport exists: plain records in, a request out. No
 * `http`, no `fs`. Phase 8's `postMessage` host decodes with the same function.
 */

import type { GraphFile } from '../graph/schema.js';
import type { AggregatedViewOptions } from './aggregate.js';
import { DEFAULT_CALL_DOWN, DEFAULT_CALL_UP, ViewError, VIEW_NAMES, type ViewName } from './views.js';

/** Where a host serves the endpoints. Shared so neither end guesses. */
export const VIEW_ENDPOINT = '/api/view';
export const META_ENDPOINT = '/api/meta';
/** §11's inspector: one node, its attributes and its relations. */
export const NODE_ENDPOINT = '/api/node';
/** §11's review-state and imported-findings overlays, the two files the host reads. */
export const OVERLAY_ENDPOINT = '/api/overlays';
/** §11's `/` fuzzy search palette. Matched and capped on this side (§9 rule 1). */
export const SEARCH_ENDPOINT = '/api/search';
/** §11's inline code preview: a byte range around one node's `src`. */
export const SOURCE_ENDPOINT = '/api/source';

/**
 * What the UI shows above the graph before it has drawn anything: §4's mode and
 * its copy, the resolution score, and the project it is looking at.
 *
 * It is the `graph.json` header minus the graph — the nodes and edges are
 * exactly what rule 1 says must not be sent. §4 requires the mode and score to
 * be stated rather than implied, and `modeReason` is written to be shown
 * verbatim, so this is the smallest payload that lets a UI be honest before the
 * first view loads.
 */
export interface ProjectMeta extends Omit<GraphFile, 'nodes' | 'edges'> {
  /** Absolute path of the project being served, for the window title. */
  root: string;
  /** §13's `renderCap` as resolved by the host (§9 rule 2). */
  renderCap: number;
  views: readonly ViewName[];
  /** §9 rule 4's hop defaults, so the UI's steppers start where the engine does. */
  callDefaults: { up: number; down: number };
}

/** An error a request produced, in a form a UI can act on rather than only print. */
export interface ProtocolError {
  name: string;
  message: string;
  /** Present on a `RenderCapError` (§9 rule 2), which is the one a UI can offer a way out of. */
  elements?: number;
  cap?: number;
  view?: string;
}

/** The `expand` set is a list, and one query parameter holds it. */
const EXPAND_SEPARATOR = ',';

function isViewName(value: string): value is ViewName {
  return (VIEW_NAMES as readonly string[]).includes(value);
}

function integer(params: Record<string, string | undefined>, key: string): number | undefined {
  const raw = params[key];
  if (raw === undefined || raw === '') return undefined;
  // Not `parseInt`, which reads "1.5" as 1 and "3px" as 3. Truncating a number
  // a caller did not write is the quiet kind of wrong: the request succeeds and
  // answers a question nobody asked.
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(value) || value < 0) {
    throw new ViewError(`"${key}" must be a non-negative integer, not "${raw}".`);
  }
  return value;
}

function flag(params: Record<string, string | undefined>, key: string): boolean | undefined {
  const raw = params[key];
  if (raw === undefined || raw === '') return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new ViewError(`"${key}" must be 0 or 1, not "${raw}".`);
}

/**
 * Query parameters → request, refusing what it cannot read.
 *
 * A host is parsing input a user could have typed into a URL bar, and §6's rule
 * about not guessing applies to it as much as to the resolver: an unknown view
 * name names the five that exist rather than falling back to the default,
 * because a UI that silently shows the protocol map when you asked for the call
 * graph is telling you something untrue about the code.
 */
export function decodeViewRequest(
  params: Record<string, string | undefined>,
): AggregatedViewOptions {
  const view = params['view'] ?? 'protocol';
  if (!isViewName(view)) {
    throw new ViewError(`Unknown view "${view}". Views: ${VIEW_NAMES.join(', ')}.`);
  }

  const focus = params['focus'];
  const up = integer(params, 'up');
  const down = integer(params, 'down');
  const renderCap = integer(params, 'renderCap');
  const includeTests = flag(params, 'includeTests');
  const cluster = flag(params, 'cluster');
  const autoExpand = flag(params, 'autoExpand');
  const rawExpand = params['expand'];
  const expand =
    rawExpand === undefined || rawExpand === ''
      ? undefined
      : rawExpand
          .split(EXPAND_SEPARATOR)
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '');

  return {
    view,
    ...(focus === undefined || focus === '' ? {} : { focus }),
    ...(up === undefined ? {} : { up }),
    ...(down === undefined ? {} : { down }),
    ...(includeTests === undefined ? {} : { includeTests }),
    ...(renderCap === undefined ? {} : { renderCap }),
    ...(cluster === undefined ? {} : { cluster }),
    ...(autoExpand === undefined ? {} : { autoExpand }),
    ...(expand === undefined ? {} : { expand }),
  };
}

/**
 * Query parameters → a node id, refusing an empty one.
 *
 * The same shape as `decodeViewRequest` and for the same reason: a host is
 * reading input a user could have typed, and the honest failure is a stated
 * refusal rather than a panel about whichever node sorted first.
 */
export function decodeNodeRequest(params: Record<string, string | undefined>): { id: string } {
  const id = params['id'];
  if (id === undefined || id.trim() === '') {
    throw new ViewError('"id" is required: which node should be inspected?');
  }
  return { id };
}

/**
 * Query parameters → a search request.
 *
 * `limit` is decoded because a UI may legitimately want fewer rows than the
 * default; it is *clamped* by `searchNodes` rather than here, because the
 * ceiling is a property of the query API and not of one transport (§9 rule 1
 * has to hold over `postMessage` too).
 */
export function decodeSearchRequest(
  params: Record<string, string | undefined>,
): { query: string; limit?: number } {
  const query = params['q'] ?? '';
  const limit = integer(params, 'limit');
  return { query, ...(limit === undefined ? {} : { limit }) };
}

/**
 * Query parameters → a source-slice request.
 *
 * Note what is *not* decodable: a path. §11's preview asks for the source of a
 * **node**, and `sliceNode` takes the file from the graph — so there is no
 * parameter here through which a caller could name a file to read. That is the
 * whole of the design; see `source/slice.ts`.
 */
export function decodeSourceRequest(
  params: Record<string, string | undefined>,
): { id: string; context?: number } {
  const id = params['id'];
  if (id === undefined || id.trim() === '') {
    throw new ViewError('"id" is required: which node\'s source should be shown?');
  }
  const context = integer(params, 'context');
  return { id, ...(context === undefined ? {} : { context }) };
}

/** §9 rule 4's defaults, in the shape {@link ProjectMeta} carries them. */
export function callDefaults(): { up: number; down: number } {
  return { up: DEFAULT_CALL_UP, down: DEFAULT_CALL_DOWN };
}
