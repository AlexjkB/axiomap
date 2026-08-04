/**
 * Shared graph builds for the Phase 2 suites.
 *
 * Building a fixture graph parses every file in it, so the four correctness
 * fixtures are built once per process and shared. The resolver is pure over
 * the symbol table, so sharing is safe — but nothing may mutate what it gets
 * back, and the golden suite serializes rather than edits for that reason.
 */

import { buildProjectGraph, type ProjectGraphResult } from '../src/index.js';
import { fixture } from './fixtures.js';

export const CORRECTNESS_FIXTURES = ['minimal', 'inheritance', 'defi', 'pathological'] as const;

export type FixtureName = (typeof CORRECTNESS_FIXTURES)[number];

const cache = new Map<string, Promise<ProjectGraphResult>>();

/**
 * The cache is disabled and the pool is single-worker on purpose: a test that
 * silently reads a stale parse cache from a previous run is a test that stops
 * failing when it should.
 *
 * **Enrichment is off.** `defi/` ships build-info artifacts from Phase 3, and
 * without this every suite that shares these graphs would silently be testing
 * the semantic tier instead of the syntactic one. The heuristic graph is the
 * baseline §7 compares the enriched graph against, so it is the one the goldens
 * pin; `enrichedGraphOf` is the other side of that comparison.
 */
export function graphOf(name: FixtureName): Promise<ProjectGraphResult> {
  let pending = cache.get(name);
  if (pending === undefined) {
    pending = buildProjectGraph(fixture(name), { cacheDir: null, workers: 1, enrich: false });
    cache.set(name, pending);
  }
  return pending;
}

/** The same project with the semantic tier enabled, when artifacts exist. */
export function enrichedGraphOf(name: FixtureName): Promise<ProjectGraphResult> {
  const key = `${name}:enriched`;
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = buildProjectGraph(fixture(name), { cacheDir: null, workers: 1 });
    cache.set(key, pending);
  }
  return pending;
}

/** Build with the mode threshold pinned, for tests about edges rather than modes. */
export function graphWithoutModeGating(name: FixtureName): Promise<ProjectGraphResult> {
  const key = `${name}:ungated`;
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = buildProjectGraph(fixture(name), {
      cacheDir: null,
      workers: 1,
      enrich: false,
      callResolutionThreshold: 0,
    });
    cache.set(key, pending);
  }
  return pending;
}
