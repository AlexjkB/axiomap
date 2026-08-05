/**
 * The query API both the CLI and the webview consume (§5).
 *
 * §9 rule 1 makes this the seam that matters at scale: "the webview never
 * receives the full graph — core exposes a query API; the webview requests
 * subgraphs by view + filter + focus". Phase 6 is the first consumer and builds
 * it for the terminal; Phase 7 is the second and must not need a different one.
 *
 * So everything here takes a graph and returns plain data. No formatting, no
 * colour, no `fs`. `axiomap query callers-of` is a table renderer wrapped
 * around `traverse`, and the inspector panel will be a React component wrapped
 * around the same call.
 */

export * from './refs.js';
export * from './traverse.js';
export * from './inspect.js';
export * from './views.js';
