/**
 * The entry point of an exported file (§12's `--format html`).
 *
 * It renders the same `App` as `main.tsx`, which is the whole claim the export
 * makes: a client opening the deliverable gets the tool, not a picture of it.
 * Two things differ, and both are about there being no process on the other
 * end.
 *
 * - **The bridge is `StaticBridge`**, answering from the payload the exporter
 *   inlined rather than from `axiomap serve`.
 * - **ELK comes from a blob**, not from a URL. §9 rule 6 still holds — layout
 *   runs in a worker and never blocks the viewport — but a single file has no
 *   `assets/` directory to load a worker script out of, so the exporter inlines
 *   the worker's source and this constructs a `Blob` URL from it. That is also
 *   why §7's Phase 9 says this file "redistributes" elkjs and needs the
 *   attribution in its footer: it literally contains it.
 *
 * This entry is built by `vite.export.config.ts` with `inlineDynamicImports`,
 * so the shiki grammar that `main.tsx` loads lazily is in the one chunk here.
 * A deliverable cannot fetch a second chunk, and unhighlighted source in the
 * one artifact a client actually reads would be the export showing less than
 * the tool does.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ELK from 'elkjs/lib/elk-api.js';

import { readEmbeddedPayload, StaticBridge } from '../static.js';
import { App } from './App.js';
import { LayoutClient, type LayoutEngine } from './layout/client.js';
import './styles.css';

/** Where the exporter puts elkjs's worker source. */
const ELK_GLOBAL = '__AXIOMAP_ELK_WORKER__';

function blobEngine(source: string): LayoutEngine {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  return new ELK({
    workerFactory: () => new Worker(url, { type: 'classic' }),
  }) as unknown as LayoutEngine;
}

const container = document.getElementById('root');
if (container === null) throw new Error('No #root element to mount into.');

const payload = readEmbeddedPayload();
const workerSource = (globalThis as Record<string, unknown>)[ELK_GLOBAL];

if (payload === null) {
  // Not a silent blank: this file is only ever produced by the exporter, so
  // arriving here means the payload was stripped or is from another version.
  container.textContent =
    'This Axiomap export has no embedded graph, or was made by a different version of the tool.';
} else {
  createRoot(container).render(
    <StrictMode>
      <App
        bridge={new StaticBridge(payload)}
        {...(typeof workerSource === 'string'
          ? { layoutClient: new LayoutClient(blobEngine(workerSource)) }
          : {})}
      />
    </StrictMode>,
  );
}
