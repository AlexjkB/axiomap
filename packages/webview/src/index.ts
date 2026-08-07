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
  AUDIT_STATE_ENDPOINT,
  SEARCH_ENDPOINT,
  SOURCE_ENDPOINT,
  VIEW_ENDPOINT,
  encodeNodeRequest,
  encodeSearchRequest,
  encodeSourceRequest,
  encodeViewRequest,
} from './protocol.js';

/**
 * The third host (§12's `--format html`): a file. `sameViewRequest` and the two
 * hydrators are exported because each forms a pair with a function in core that
 * is pinned at the repo root — see `static.ts` for why there are two of each.
 */
export {
  hydrateInspection,
  hydrateView,
  PAYLOAD_GLOBAL,
  READS_PAYLOAD_VERSION,
  readEmbeddedPayload,
  sameViewRequest,
  StaticBridge,
} from './static.js';

/**
 * The fourth host (§7's Phase 8): a VS Code webview, over `postMessage`.
 *
 * The extension imports the wire types and the channel name from here, so the
 * two ends of §9 rule 1's second transport are one declaration rather than two
 * that agree today. `VsCodeBridge` itself is constructed inside the webview and
 * is exported for the same reason `HttpBridge` is: so a test can drive it.
 */
export {
  acquireApi,
  CHANNEL,
  VsCodeBridge,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  type HostEvent,
  type RevealMessage,
  type RevealTarget,
  type VsCodeApi,
  type VsCodeBridgeOptions,
} from './vscode.js';
export type { EditorLink } from './editor.js';

/** Where `vite build` puts the bundle, relative to the package root. */
export const WEB_DIST = 'dist/web';
/** Where the single-chunk build the HTML export inlines goes. */
export const EXPORT_DIST = 'dist/export';
/** Where the single-chunk build a VS Code webview loads goes. */
export const VSCODE_DIST = 'dist/vscode';
