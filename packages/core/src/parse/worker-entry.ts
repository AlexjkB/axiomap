/**
 * Worker-thread entry for the parallel parse pool.
 *
 * Each worker owns its own parser instance and its own cache handle, and does
 * its own file reads — the read is as parallelisable as the parse and doing it
 * on the main thread would serialise the cheap half of the work.
 *
 * Results cross the thread boundary as a **JSON string**, not as objects.
 * Structured-clone of a few thousand deep AST objects is slower than
 * `JSON.stringify` + `JSON.parse` for this shape, and the string form is
 * exactly what the disk cache stores anyway.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { ParseCache } from './cache.js';
import { createParser } from './index.js';
import type { ParserId, ParseResult } from './interface.js';

export interface WorkerInput {
  root: string;
  parserId: ParserId;
  cacheDir: string | null;
}

export interface WorkerRequest {
  files: string[];
}

export interface WorkerResponse {
  /** JSON of `[file, ParseResult][]`. */
  payload: string;
  cacheHits: number;
  cacheMisses: number;
}

async function main(): Promise<void> {
  if (parentPort === null) return;

  const input = workerData as WorkerInput;
  // Both awaits finish before the ready handshake below, so the grammar
  // compile is never billed to the first file's parse time.
  const parser = await createParser(input.parserId);
  const cache =
    input.cacheDir === null ? null : await ParseCache.open(input.cacheDir, input.parserId);

  let hits = 0;
  let misses = 0;

  parentPort.on('message', (request: WorkerRequest) => {
    const results: [string, ParseResult][] = [];

    for (const file of request.files) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(input.root, file), 'utf8');
      } catch (error) {
        // An unreadable file is a diagnostic, not a crash (decision #1).
        results.push([
          file,
          {
            unit: {
              file,
              pragmas: [],
              imports: [],
              contracts: [],
              functions: [],
              constants: [],
              structs: [],
              enums: [],
              errors: [],
              userDefinedValueTypes: [],
            },
            diagnostics: [
              {
                message: `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
                severity: 'error',
                src: null,
              },
            ],
            recovered: true,
          },
        ]);
        continue;
      }

      const cached = cache?.get(file, text) ?? null;
      if (cached !== null) {
        hits++;
        results.push([file, cached]);
        continue;
      }

      misses++;
      const result = parser.parse(file, text);
      cache?.set(file, text, result);
      results.push([file, result]);
    }

    const response: WorkerResponse = {
      payload: JSON.stringify(results),
      cacheHits: hits,
      cacheMisses: misses,
    };
    parentPort?.postMessage(response);
  });

  parentPort.postMessage({ payload: '[]', cacheHits: 0, cacheMisses: 0 } satisfies WorkerResponse);
}

void main();
