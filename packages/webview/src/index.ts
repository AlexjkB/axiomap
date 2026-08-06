/**
 * The node-side surface of this package: what a *host* needs, not what the
 * browser bundle contains.
 *
 * The UI itself is reached as built files (`dist/web/`), never as an import —
 * `axiomap serve` serves that directory and Phase 8's webview loads it. What is
 * exported here is the contract between the two: the bridge a host implements
 * (§9 rule 1) and the request encoding it will be asked to decode.
 */

export {
  BridgeError,
  HttpBridge,
  type FetchLike,
  type HostBridge,
  type HttpBridgeOptions,
} from './bridge.js';
export {
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

/**
 * The third host (§12's `--format html`): a file. `sameViewRequest` is exported
 * because the pair it forms with core's copy is pinned at the repo root — see
 * `static.ts` for why there are two.
 */
export { PAYLOAD_GLOBAL, readEmbeddedPayload, sameViewRequest, StaticBridge } from './static.js';

/** Where `vite build` puts the bundle, relative to the package root. */
export const WEB_DIST = 'dist/web';
/** Where the single-chunk build the HTML export inlines goes. */
export const EXPORT_DIST = 'dist/export';
