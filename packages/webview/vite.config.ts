/**
 * The bundle, built once and hosted twice (§5).
 *
 * Output goes to `dist/web/`, beside — not on top of — the `dist/` that `tsc`
 * emits for this package's node-side types. `axiomap serve` serves that
 * directory as static files, and Phase 8 loads the same one inside a VS Code
 * webview.
 *
 * Two settings are load-bearing rather than taste:
 *
 * - **`base: './'`**, so the built `index.html` references its assets
 *   relatively. A webview host mounts the bundle under a URI scheme that is not
 *   a server root, and absolute `/assets/...` paths break there — which is a
 *   thing to get right now rather than to discover in Phase 8.
 * - **No `manualChunks`.** ELK is pulled in by `layout/worker.ts` only, and Vite
 *   emits a worker as its own chunk, which is what keeps §9 rule 6 true: the
 *   layout engine is never on the main thread's critical path.
 */

import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwind()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    // A dev tool's bundle is read by the people who run it; keep it readable.
    sourcemap: true,
    target: 'es2022',
  },
});
