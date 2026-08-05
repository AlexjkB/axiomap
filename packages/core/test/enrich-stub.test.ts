/**
 * The standing guard on decision #1 (§5, §7).
 *
 * > `enrich/` is the only directory allowed to require a compiler. If any other
 * > module develops a hard dependency on solc output, decision #1 has quietly
 * > been broken. This is worth a dedicated test: run the whole pipeline with
 * > `enrich/` stubbed out and assert the graph still builds.
 *
 * **Keep this test forever.** It is cheap and it guards the property the entire
 * product rests on: a graph for code that does not compile. The way that
 * property dies is not a decision — it is a `import { … } from '../enrich/…'`
 * added to `resolve/` one afternoon because the type was convenient, and six
 * months later nothing works without artifacts and nobody can say when that
 * started.
 *
 * Two halves, because either alone can pass while the property is broken:
 *
 * 1. **Behavioural.** `enrich/` is replaced with a module whose every export
 *    throws. Every fixture must still parse, resolve, score, pick a mode and
 *    serialize — the same graph as a normal build, since none of them enriches
 *    without artifacts anyway. `defi/` *does* have artifacts, and is the
 *    interesting case: it must fall back to the heuristic graph rather than
 *    fail.
 * 2. **Structural.** No source file outside `enrich/` may import it, except the
 *    one composition point that is allowed to. A stub is only as good as the
 *    call sites it stands in for, and a second importer would slip past the
 *    first half whenever it happened not to be exercised.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { fixture } from './fixtures.js';
import { CORRECTNESS_FIXTURES } from './graphs.js';

/**
 * `enrich/`, deleted as far as the rest of the engine is concerned. Not a
 * no-op: a stub that quietly returned null would also pass if someone made the
 * call unconditional, and this way the pipeline has to be genuinely uninterested
 * in the answer.
 */
vi.mock('../src/enrich/index.js', () => ({
  loadSemanticOverlay: () => {
    throw new Error('enrich/ is stubbed out: nothing outside it may require a compiler');
  },
  discoverBuildInfo: () => {
    throw new Error('enrich/ is stubbed out');
  },
  readBuildInfo: () => {
    throw new Error('enrich/ is stubbed out');
  },
  buildInfoDirectories: () => {
    throw new Error('enrich/ is stubbed out');
  },
}));

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** The one module allowed to reach the semantic tier. */
const COMPOSITION_POINT = 'ingest.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the pipeline with enrich/ stubbed out', () => {
  for (const name of CORRECTNESS_FIXTURES) {
    it(`still builds a graph for ${name}/`, async () => {
      // Imported inside the test so the mock is in place first.
      const { buildProjectGraph, serializeGraph, parseGraph } = await import('../src/index.js');

      const { file } = await buildProjectGraph(fixture(name), { cacheDir: null, workers: 1 });

      expect(file.nodes.length).toBeGreaterThan(0);
      expect(file.edges.length).toBeGreaterThan(0);
      // Nothing is semantic without a compiler, by definition (§4).
      expect(file.score.overall.semantic).toBe(0);
      expect(file.mode).not.toBe('full');
      expect(file.generator.compilers).toEqual([]);
      // Skipped, not swallowed: a tier that failed says so.
      expect(
        file.diagnostics.some((d) => d.message.startsWith('Semantic enrichment failed')),
      ).toBe(true);
      // And it is still a valid, round-trippable artifact.
      expect(() => parseGraph(serializeGraph(file))).not.toThrow();
    });
  }

  it('produces the same graph as an ordinary heuristic build', async () => {
    // `defi/` has committed build artifacts, so this is the fixture where a
    // hard dependency on the semantic tier would actually show up.
    const { buildProjectGraph, serializeGraph } = await import('../src/index.js');
    const stubbed = await buildProjectGraph(fixture('defi'), { cacheDir: null, workers: 1 });
    const heuristic = await buildProjectGraph(fixture('defi'), {
      cacheDir: null,
      workers: 1,
      enrich: false,
    });
    // Two things legitimately differ and neither is graph *content*:
    //
    // - the diagnostic saying the tier was skipped, and
    // - `generator.settings.enrich`, because these builds really were
    //   configured differently. One declined the semantic tier; the other asked
    //   for it and got a module that throws. That the artifact can tell them
    //   apart is the point of recording settings at all — what this test is
    //   about is that the nodes and edges come out the same either way.
    const content = (file: typeof stubbed.file): string =>
      serializeGraph({
        ...file,
        generator: { ...file.generator, settings: undefined },
        diagnostics: file.diagnostics.filter(
          (d) => !d.message.startsWith('Semantic enrichment failed'),
        ),
      });
    expect(content(stubbed.file)).toBe(content(heuristic.file));
  });

  it('is imported by exactly one module outside itself', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const relative = path.relative(SRC, file).split(path.sep).join('/');
      if (relative.startsWith('enrich/') || relative === COMPOSITION_POINT) continue;
      const source = fs.readFileSync(file, 'utf8');
      // A type-only import is fine — it disappears at runtime and `graph/` owns
      // the `SemanticOverlay` contract precisely so the seam can be typed
      // without being depended on.
      for (const match of source.matchAll(/^\s*import\s+(type\s+)?[^;]*?['"]([^'"]*enrich[^'"]*)['"]/gm)) {
        if (match[1] === undefined) offenders.push(`${relative} imports ${match[2]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
