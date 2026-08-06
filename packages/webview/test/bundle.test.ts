/**
 * The built bundle, checked for the two properties that are invisible in source.
 *
 * §9 rule 6 is a claim about where ELK runs, and the only place that claim is
 * true or false is the output: a bundler that inlined the worker would leave
 * every line of `worker.ts` unchanged and put the layout engine back on the main
 * thread. So the assertion is on the chunks — ELK belongs to a chunk the entry
 * does not load.
 *
 * The relative-asset check is Phase 8's, taken now: a webview host mounts this
 * directory under a URI scheme that is not a server root, and absolute
 * `/assets/…` paths fail there and nowhere else.
 *
 * Skipped when the bundle is absent, the way `core`'s worker tests skip without
 * `dist/` — `pnpm check` builds first, so in CI they run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WEB_DIST } from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, WEB_DIST);
const built = fs.existsSync(path.join(dist, 'index.html'));

describe.skipIf(!built)('the built bundle', () => {
  const html = built ? fs.readFileSync(path.join(dist, 'index.html'), 'utf8') : '';
  const chunks = built
    ? fs
        .readdirSync(path.join(dist, 'assets'))
        .filter((file) => file.endsWith('.js'))
        .map((file) => ({ file, text: fs.readFileSync(path.join(dist, 'assets', file), 'utf8') }))
    : [];

  it('keeps ELK out of the chunk the page loads (§9 rule 6)', () => {
    const entry = chunks.filter(({ file }) => html.includes(file));
    expect(entry).toHaveLength(1);

    // ELK is a Java library compiled to JavaScript, and its package names come
    // with it. The entry chunk must not contain them and some other chunk must.
    // (`elk.layered.*` would be the wrong marker: those option keys are in the
    // presets, on the main thread, which is exactly where they belong.)
    const marker = 'org.eclipse.elk';
    expect(entry[0]?.text.includes(marker)).toBe(false);
    expect(chunks.some(({ text }) => text.includes(marker))).toBe(true);
  });

  /**
   * §11's code preview needs a TextMate grammar and a regex engine — a few
   * hundred kilobytes for a panel that is closed until something is clicked.
   * The import is dynamic for that reason, and "dynamic" is a property of the
   * output rather than of the source: a bundler that inlined it would leave
   * `highlight.ts` untouched and put the whole of shiki on first paint.
   */
  it('keeps the syntax highlighter out of the chunk the page loads', () => {
    const entry = chunks.filter(({ file }) => html.includes(file));
    expect(entry).toHaveLength(1);

    // The grammar's own scope name: it is in `@shikijs/langs/solidity` and
    // nowhere else in this tree.
    const marker = 'source.solidity';
    expect(entry[0]?.text.includes(marker)).toBe(false);
    expect(chunks.some(({ text }) => text.includes(marker))).toBe(true);
  });

  /**
   * Decision #2 again, at the one place it could plausibly break: shiki's
   * default engine is oniguruma compiled to WebAssembly, and the ways of
   * locating that `.wasm` at runtime include fetching it from a CDN. The
   * JavaScript engine has no asset to locate, so there should be no wasm in
   * this bundle at all.
   */
  it('ships no WebAssembly for the highlighter to go looking for', () => {
    const assets = fs.readdirSync(path.join(dist, 'assets'));
    expect(assets.filter((file) => file.endsWith('.wasm'))).toEqual([]);
  });

  it('references its assets relatively, so a webview host can mount it', () => {
    expect(html).toMatch(/src="\.\/assets\//);
    expect(html).not.toMatch(/src="\/assets\//);
  });

  it('loads nothing from the network (decision #2)', () => {
    expect(html).not.toMatch(/https?:\/\/(?!localhost|127\.0\.0\.1)/);
  });
});
