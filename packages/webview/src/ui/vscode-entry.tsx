/**
 * The entry point inside a VS Code webview (§7's Phase 8).
 *
 * It renders the same `App` as `main.tsx` and the export entry, which is the
 * claim Phase 7 kept making and this is the phase that tests: one UI, four
 * hosts, and the difference between them is which bridge is constructed here.
 * Three things differ from browser mode, and all three follow from the webview
 * being a document the editor owns rather than a page a server hands out.
 *
 * - **The bridge is `VsCodeBridge`**, over `postMessage`, and it doubles as the
 *   `EditorLink` — the notifications an editor can carry and a browser cannot
 *   (`editor.ts`).
 * - **ELK comes from a blob**, as it does in the export, and for a related
 *   reason. §9 rule 6 still holds; what a webview cannot do is start a worker
 *   from an asset URL, because the document's origin (`vscode-webview://…`) is
 *   not the origin its resources are served from, and a cross-origin worker
 *   script is refused by the browser engine underneath. The extension reads
 *   `elk-worker.min.js` off disk and hands it over as a string, which this turns
 *   into a same-origin `Blob`.
 * - **The build is single-chunk** (`vite.vscode.config.ts`), for the same
 *   reason: a lazily-imported second chunk is one more cross-origin fetch to
 *   get right, and the whole bundle is on local disk anyway.
 *
 * If the worker source is missing, the app still mounts and the status bar says
 * `layout failed: …` — 7b's rule, which is that a dead layout engine must never
 * be indistinguishable from an ugly graph.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ELK from 'elkjs/lib/elk-api.js';

import { acquireApi, VsCodeBridge } from '../vscode.js';
import { App } from './App.js';
import { LayoutClient, type LayoutEngine } from './layout/client.js';
import './styles.css';

/** Where the extension puts elkjs's worker source. Same name the export uses. */
const ELK_GLOBAL = '__AXIOMAP_ELK_WORKER__';

function blobEngine(source: string): LayoutEngine {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  return new ELK({
    workerFactory: () => new Worker(url, { type: 'classic' }),
  }) as unknown as LayoutEngine;
}

const container = document.getElementById('root');
if (container === null) throw new Error('No #root element to mount into.');

const bridge = new VsCodeBridge({ api: acquireApi() });
const workerSource = (globalThis as Record<string, unknown>)[ELK_GLOBAL];

createRoot(container).render(
  <StrictMode>
    <App
      bridge={bridge}
      editor={bridge}
      {...(typeof workerSource === 'string'
        ? { layoutClient: new LayoutClient(blobEngine(workerSource)) }
        : {})}
    />
  </StrictMode>,
);
