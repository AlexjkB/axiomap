/**
 * The bundle a VS Code webview loads (§7's Phase 8).
 *
 * The same UI as `vite.config.ts` builds for `axiomap serve`, chunked the way
 * `vite.export.config.ts` chunks it, and for the same practical reason rather
 * than by imitation: a webview document's origin is not the origin its assets
 * are served from, so every *second* thing the page fetches — a lazy chunk, a
 * worker script — is a cross-origin request to get right. One chunk, one
 * stylesheet, and elkjs's worker handed in as a string by the extension (see
 * `src/ui/vscode-entry.tsx`), and there is no second fetch to reason about.
 *
 * `dist/vscode/` rather than `dist/web/`: the extension ships both, because the
 * browser bundle is what a user gets if they run `axiomap serve` from a
 * terminal in the same workspace.
 */

import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwind()],
  build: {
    outDir: 'dist/vscode',
    emptyOutDir: true,
    // The extension is installed from a `.vsix` and read by whoever wants to
    // audit what they installed; a map doubles it and helps nobody debug an
    // editor panel they cannot open devtools on without a command.
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/ui/vscode-entry.tsx',
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'vscode.js',
        assetFileNames: 'vscode.[ext]',
      },
    },
  },
});
