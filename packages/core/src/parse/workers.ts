/**
 * Parallel parse pool (§9, ingest budget).
 *
 * Files are dealt round-robin across worker threads, each of which reads,
 * caches and parses its own share. Round-robin rather than contiguous chunks
 * because Solidity file sizes are wildly uneven — a directory of interfaces
 * next to a 2,000-line vault — and contiguous chunks leave one worker holding
 * every large file in a directory.
 *
 * The pool also runs **inline** when no worker entry is available, which is
 * the case under vitest's TypeScript transform. Same code path, same results,
 * no threads; the benchmark runs against built output where threads are real.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { ParseCache } from './cache.js';
import { createParser } from './index.js';
import type { ParserId, ParseResult } from './interface.js';
import type { WorkerInput, WorkerRequest, WorkerResponse } from './worker-entry.js';

export interface ParsePoolOptions {
  root: string;
  parserId: ParserId;
  /** Defaults to `min(cpus - 1, 8)`, at least 1. */
  workers?: number;
  /** Absolute path; null disables the disk cache. */
  cacheDir?: string | null;
  /** Override for tests and benchmarks that run against `dist/`. */
  workerEntry?: URL;
}

export interface ParseRunStats {
  files: number;
  workers: number;
  cacheHits: number;
  cacheMisses: number;
  /** True when the run fell back to single-threaded parsing. */
  inline: boolean;
  millis: number;
}

export interface ParseRun {
  results: Map<string, ParseResult>;
  stats: ParseRunStats;
}

function defaultWorkerCount(): number {
  return Math.max(1, Math.min(os.cpus().length - 1, 8));
}

function defaultWorkerEntry(): URL {
  return new URL('./worker-entry.js', import.meta.url);
}

/** Round-robin so uneven file sizes even out across workers. */
function deal<T>(items: readonly T[], buckets: number): T[][] {
  const out: T[][] = Array.from({ length: buckets }, () => []);
  items.forEach((item, i) => {
    (out[i % buckets] as T[]).push(item);
  });
  return out;
}

export async function parseFiles(
  files: readonly string[],
  options: ParsePoolOptions,
): Promise<ParseRun> {
  const started = performance.now();
  const cacheDir = options.cacheDir === undefined ? null : options.cacheDir;
  const entry = options.workerEntry ?? defaultWorkerEntry();
  const canThread = files.length > 8 && fs.existsSync(entry);

  if (!canThread) {
    const run = await parseInline(files, options, cacheDir);
    return {
      results: run.results,
      stats: { ...run.stats, millis: performance.now() - started },
    };
  }

  const workerCount = Math.max(1, Math.min(options.workers ?? defaultWorkerCount(), files.length));
  const batches = deal(files, workerCount);
  const results = new Map<string, ParseResult>();
  let cacheHits = 0;
  let cacheMisses = 0;

  const input: WorkerInput = {
    root: options.root,
    parserId: options.parserId,
    cacheDir,
  };

  await Promise.all(
    batches.map(
      (batch) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(entry, { workerData: input });
          let ready = false;

          worker.on('message', (message: WorkerResponse) => {
            if (!ready) {
              // First message is the worker's ready handshake; the real
              // request only goes out once its parser and cache are built,
              // so startup cost is not billed to the first file.
              ready = true;
              worker.postMessage({ files: batch } satisfies WorkerRequest);
              return;
            }
            const decoded = JSON.parse(message.payload) as [string, ParseResult][];
            for (const [file, result] of decoded) results.set(file, result);
            cacheHits += message.cacheHits;
            cacheMisses += message.cacheMisses;
            void worker.terminate().then(() => {
              resolve();
            });
          });

          worker.on('error', reject);
        }),
    ),
  );

  return {
    results,
    stats: {
      files: files.length,
      workers: workerCount,
      cacheHits,
      cacheMisses,
      inline: false,
      millis: performance.now() - started,
    },
  };
}

async function parseInline(
  files: readonly string[],
  options: ParsePoolOptions,
  cacheDir: string | null,
): Promise<{ results: Map<string, ParseResult>; stats: Omit<ParseRunStats, 'millis'> }> {
  const parser = await createParser(options.parserId);
  const cache = cacheDir === null ? null : await ParseCache.open(cacheDir, options.parserId);
  const results = new Map<string, ParseResult>();
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(options.root, file), 'utf8');
    } catch (error) {
      results.set(file, unreadable(file, error));
      continue;
    }

    const cached = cache?.get(file, text) ?? null;
    if (cached !== null) {
      cacheHits++;
      results.set(file, cached);
      continue;
    }

    cacheMisses++;
    const result = parser.parse(file, text);
    cache?.set(file, text, result);
    results.set(file, result);
  }

  return {
    results,
    stats: {
      files: files.length,
      workers: 1,
      cacheHits,
      cacheMisses,
      inline: true,
    },
  };
}

function unreadable(file: string, error: unknown): ParseResult {
  return {
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
  };
}
