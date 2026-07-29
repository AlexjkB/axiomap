/**
 * The Phase 1 pipeline end to end: detect a project, enumerate its Solidity,
 * parse it in parallel, and index it into a global symbol table.
 *
 * This is the top half of §4's diagram — everything down to and including the
 * symbol table. Heuristic resolution and graph construction sit below it in
 * Phase 2 and consume the table this returns.
 *
 * Not in §5's layout: the layout names directories, and this is the one thing
 * that composes them. Putting it inside any of `parse/`, `project/` or
 * `symbols/` would make that directory depend on the other two.
 */

import path from 'node:path';

import { parseFiles, type ParseRunStats } from './parse/workers.js';
import { DEFAULT_PARSER_ID } from './parse/index.js';
import type { ParserId } from './parse/interface.js';
import { detectProject, listSolidityFiles, type DetectedProject } from './project/detect.js';
import { buildSymbolTable } from './symbols/build.js';
import type { SymbolTable } from './symbols/table.js';

export interface IngestOptions {
  parserId?: ParserId;
  workers?: number;
  /**
   * Disk cache location. Defaults to `<root>/.axiomap/cache/parse`; pass null
   * to disable, which is what the cold half of the benchmark does.
   */
  cacheDir?: string | null;
  workerEntry?: URL;
}

export interface IngestResult {
  project: DetectedProject;
  table: SymbolTable;
  files: string[];
  parseStats: ParseRunStats;
}

export async function ingestProject(
  root: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const project = detectProject(root);
  const files = listSolidityFiles(project);
  const parserId = options.parserId ?? DEFAULT_PARSER_ID;

  const cacheDir =
    options.cacheDir === undefined
      ? path.join(project.root, '.axiomap', 'cache', 'parse')
      : options.cacheDir;

  const run = await parseFiles(files, {
    root: project.root,
    parserId,
    ...(options.workers === undefined ? {} : { workers: options.workers }),
    cacheDir,
    ...(options.workerEntry === undefined ? {} : { workerEntry: options.workerEntry }),
  });

  const table = buildSymbolTable({ project, results: run.results });

  return { project, table, files, parseStats: run.stats };
}
