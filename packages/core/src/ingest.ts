/**
 * The pipeline end to end: detect a project, enumerate its Solidity, parse it
 * in parallel, index it into a global symbol table, resolve names to edges and
 * build the graph.
 *
 * That is all of §4's diagram down to `GRAPH (usable)`. Everything below that
 * line — the semantic tier in `enrich/` — is optional by construction and is
 * Phase 3; `buildProjectGraph` never calls a compiler and never needs one.
 *
 * Not in §5's layout: the layout names directories, and this is the one thing
 * that composes them. Putting it inside any of `parse/`, `project/` or
 * `symbols/` would make that directory depend on the other two.
 */

import path from 'node:path';

import type { AnalysisOptions } from './analysis/index.js';
import { loadSemanticOverlay, type SemanticOverlayLoad } from './enrich/index.js';
import { buildGraph, type BuiltGraph } from './graph/build.js';
import type { GraphSettings } from './graph/schema.js';
import { parseFiles, type ParseRunStats } from './parse/workers.js';
import { DEFAULT_PARSER_ID } from './parse/index.js';
import type { ParserId } from './parse/interface.js';
import { detectProject, listSolidityFiles, type DetectedProject } from './project/detect.js';
import { pathFilter } from './project/globs.js';
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
  /**
   * §13's `include` / `exclude`, as project-relative globs. Applied to the file
   * list before anything is parsed, so an excluded file costs nothing and
   * appears nowhere — not in the graph, not in the score, not in the diff.
   *
   * Absent means §13's default: everything `listSolidityFiles` found.
   */
  include?: readonly string[];
  exclude?: readonly string[];
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
  const keep = pathFilter(options.include, options.exclude);
  const files = listSolidityFiles(project).filter(keep);
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

export interface BuildProjectGraphOptions extends IngestOptions {
  /** Override §4's measured mode threshold; see `graph/score.ts`. */
  callResolutionThreshold?: number;
  /**
   * Read build artifacts and upgrade edges to `semantic` (§4's top tier).
   * Defaults to true and costs nothing when there are none — pass false to
   * build the syntactic graph deliberately, which is what the golden files pin.
   */
  enrich?: boolean;
  /** Explicit build-info paths, instead of discovering them under the root. */
  buildInfo?: readonly string[];
  /** §13's `entrypoints`, `accessControlModifiers` and `reentrancyGuards`. */
  analysis?: AnalysisOptions;
  /** §13's `trustBoundaries`. */
  trustBoundaries?: { external?: readonly string[] };
}

/**
 * The settings that decided this graph's content, in the shape the artifact
 * stores.
 *
 * Built from the same options object the pipeline just ran on, so the record
 * cannot disagree with what actually happened — the failure this whole field
 * exists to prevent is a graph that does not say what it is.
 *
 * `callResolutionThreshold` is deliberately absent: it is a test knob, not a
 * §13 setting, and it changes the *mode* rather than the content, which `mode`
 * already reports.
 */
export function effectiveSettings(options: BuildProjectGraphOptions): GraphSettings {
  const analysis = options.analysis ?? {};
  return {
    ...(options.include === undefined ? {} : { include: [...options.include] }),
    ...(options.exclude === undefined ? {} : { exclude: [...options.exclude] }),
    ...(analysis.entrypoints === undefined ? {} : { entrypoints: [...analysis.entrypoints] }),
    ...(analysis.accessControlModifiers === undefined
      ? {}
      : { accessControlModifiers: [...analysis.accessControlModifiers] }),
    ...(analysis.reentrancyGuards === undefined
      ? {}
      : { reentrancyGuards: [...analysis.reentrancyGuards] }),
    ...(options.trustBoundaries?.external === undefined
      ? {}
      : { trustBoundaries: [...options.trustBoundaries.external] }),
    ...(options.enrich === false ? { enrich: false as const } : {}),
  };
}

export interface ProjectGraphResult extends IngestResult, BuiltGraph {
  /** What the semantic tier found, or null when it did not run or found nothing. */
  semantic: SemanticOverlayLoad | null;
}

/**
 * Ingest a project and build its graph. This is what `axiomap build` runs and
 * what the golden-file suite asserts on.
 */
export async function buildProjectGraph(
  root: string,
  options: BuildProjectGraphOptions = {},
): Promise<ProjectGraphResult> {
  const ingested = await ingestProject(root, options);

  // Optional by construction: `loadSemanticOverlay` returns null for a project
  // with no artifacts, or artifacts that no longer match the sources, and the
  // build carries on with the graph it already had.
  //
  // The `catch` is decision #1 in one statement. Nothing this tier can do — a
  // truncated artifact, an AST shape from a solc nobody has tried, a bug in
  // this repo — may cost the user the graph they would have had without it.
  // `test/enrich-stub.test.ts` replaces the whole module with one that throws,
  // and every fixture still builds.
  let semantic: SemanticOverlayLoad | null = null;
  if (options.enrich !== false) {
    try {
      semantic = loadSemanticOverlay({
        project: ingested.project,
        table: ingested.table,
        ...(options.buildInfo === undefined ? {} : { buildInfo: options.buildInfo }),
      });
    } catch (error) {
      semantic = {
        overlay: null,
        covered: 0,
        stale: 0,
        diagnostics: [
          {
            severity: 'warning',
            message:
              'Semantic enrichment failed and was skipped; the graph is the syntactic one. ' +
              `Cause: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  const built = buildGraph({
    project: ingested.project,
    table: ingested.table,
    parserId: options.parserId ?? DEFAULT_PARSER_ID,
    ...(options.callResolutionThreshold === undefined
      ? {}
      : { callResolutionThreshold: options.callResolutionThreshold }),
    ...(semantic === null ? {} : { semanticDiagnostics: semantic.diagnostics }),
    ...(semantic?.overlay == null ? {} : { semantic: semantic.overlay }),
    ...(options.analysis === undefined ? {} : { analysis: options.analysis }),
    ...(options.trustBoundaries === undefined
      ? {}
      : { trustBoundaries: options.trustBoundaries }),
    settings: effectiveSettings(options),
  });
  return { ...ingested, ...built, semantic };
}
