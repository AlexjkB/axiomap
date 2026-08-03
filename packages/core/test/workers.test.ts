/**
 * The real worker-thread path.
 *
 * `parseFiles` falls back to inline parsing when no built worker entry exists,
 * which is what happens under vitest's TypeScript transform — so every other
 * test in this suite exercises the fallback, not the threads. This file points
 * the pool at `dist/parse/worker-entry.js` so the threaded path is covered
 * too. It is the code the CLI and the benchmark actually run; leaving it to
 * the benchmark alone would mean a worker regression shows up as a number
 * nobody diffs.
 *
 * Skipped rather than failed when `dist/` is absent: `pnpm check` builds before
 * testing, so CI always runs it, but a bare `vitest run` on a clean tree should
 * not fail for a missing build.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseFiles } from '../src/parse/workers.js';
import { BACKENDS, fixture, PARSER } from './fixtures.js';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const WORKER_ENTRY = new URL(`file://${path.join(DIST, 'parse/worker-entry.js')}`);
const built = existsSync(WORKER_ENTRY);

// More than the 8-file threshold below which the pool stays inline.
const FILES = [
  'src/Assembly.sol',
  'src/BadImport.sol',
  'src/Crlf.sol',
  'src/DoesNotCompile.sol',
  'src/Indirect.sol',
  'src/Legacy.sol',
  'src/Proxy.sol',
  'src/SyntaxError.sol',
  'src/dup-a/Duplicate.sol',
  'src/dup-b/Duplicate.sol',
];

describe.runIf(built)('worker pool', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'axiomap-workers-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it.each(BACKENDS)('[%s] returns the same results as inline parsing', async (parserId) => {
    const root = fixture('pathological');

    const threaded = await parseFiles(FILES, {
      root,
      parserId,
      cacheDir: null,
      workers: 3,
      workerEntry: WORKER_ENTRY,
    });
    const inline = await parseFiles(FILES, { root, parserId, cacheDir: null });

    expect(threaded.stats.inline).toBe(false);
    expect(threaded.stats.workers).toBe(3);
    expect(inline.stats.inline).toBe(true);

    expect([...threaded.results.keys()].sort()).toEqual([...FILES].sort());
    for (const file of FILES) {
      expect(threaded.results.get(file)).toEqual(inline.results.get(file));
    }
  });

  it('shares one disk cache across workers', async () => {
    const options = {
      root: fixture('pathological'),
      parserId: PARSER,
      cacheDir,
      workers: 3,
      workerEntry: WORKER_ENTRY,
    };

    const cold = await parseFiles(FILES, options);
    expect(cold.stats.cacheMisses).toBe(FILES.length);
    expect(cold.stats.cacheHits).toBe(0);

    const warm = await parseFiles(FILES, options);
    expect(warm.stats.cacheHits).toBe(FILES.length);
    expect(warm.results.get('src/Proxy.sol')).toEqual(cold.results.get('src/Proxy.sol'));
  });

  it('keeps the two same-named files apart', async () => {
    // Byte-similar files at different paths. A content-only cache key would
    // let one overwrite the other's source refs.
    const run = await parseFiles(FILES, {
      root: fixture('pathological'),
      parserId: PARSER,
      cacheDir,
      workers: 3,
      workerEntry: WORKER_ENTRY,
    });

    const a = run.results.get('src/dup-a/Duplicate.sol');
    const b = run.results.get('src/dup-b/Duplicate.sol');

    expect(a?.unit.file).toBe('src/dup-a/Duplicate.sol');
    expect(b?.unit.file).toBe('src/dup-b/Duplicate.sol');
    expect(a?.unit.contracts[0]?.src.file).toBe('src/dup-a/Duplicate.sol');
    expect(b?.unit.contracts[0]?.src.file).toBe('src/dup-b/Duplicate.sol');
    expect(a?.unit.contracts[0]?.stateVariables).not.toEqual(
      b?.unit.contracts[0]?.stateVariables,
    );
  });
});
