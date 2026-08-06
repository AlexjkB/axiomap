/**
 * The single-chunk build the HTML export inlines (§12, §16).
 *
 * The served bundle (`vite.config.ts`) is deliberately split: ELK is its own
 * asset so §9 rule 6's worker is real, and shiki's grammar is a dynamic import
 * so a user who never opens the inspector does not pay for it on first paint.
 * Both of those are decisions about a page that can fetch a second file.
 *
 * A `--format html` export cannot fetch anything. So this config builds the
 * same UI with `inlineDynamicImports`, one JS chunk and one CSS file, which the
 * CLI then inlines into a single document along with elkjs's worker source and
 * the graph payload. It is the same code and the same components; only the
 * chunking differs, which is why this is a second *config* rather than a second
 * renderer — the thing §7's Phase 9 and §16 are both explicit the export must
 * not be.
 */

import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwind()],
  build: {
    outDir: 'dist/export',
    emptyOutDir: true,
    // A deliverable is read, not debugged, and a source map would double a file
    // that is already being sent to somebody else.
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/ui/export-entry.tsx',
      output: {
        // The whole point: no second chunk to fetch.
        inlineDynamicImports: true,
        entryFileNames: 'export.js',
        assetFileNames: 'export.[ext]',
      },
    },
  },
});
