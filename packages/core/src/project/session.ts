/**
 * What a host needs before it can answer anything: a project root, §13's
 * config, and a graph — built now, or read from `.axiomap/graph.json` while
 * that artifact is still true.
 *
 * ### Why this is in core rather than in the CLI
 *
 * It was the CLI's, through Phase 6 and Phase 7, because the CLI was the only
 * host that opened a project. Phase 8's extension is the second, and §5's
 * permitted graph is `vscode → core + webview` — so the extension cannot import
 * this from `packages/cli` and would otherwise write its own copy of the
 * freshness rule below. That rule is a *policy*, not plumbing: which artifact is
 * trustworthy, and what makes it stale. Two implementations of it would drift
 * into the extension and the CLI disagreeing about whether the graph on screen
 * describes the code on disk, which is the one disagreement this tool cannot
 * afford. Phase 7b's rule about the inspector, one level up.
 *
 * `fs` only, which is what §6 allows core.
 *
 * ### The artifact is used only while it is still true
 *
 * `axiomap build` writes `.axiomap/graph.json`, and a query should not re-parse
 * a 200k-SLOC project to answer "who writes to `totalSupply`". But a stale
 * artifact is worse than no artifact: it answers confidently about code that has
 * since changed, and every query would then be quietly wrong at exactly the
 * moment an auditor is relying on it — mid-edit.
 *
 * So the artifact is used when it exists and **no source file is newer than
 * it**, and rebuilt otherwise. An mtime scan is a directory walk the ingest was
 * going to do anyway, and a rebuild with a warm parse cache is a second or two.
 * The expensive-and-right option is the default; `stale` is there for the caller
 * who knows better, and says what it is.
 *
 * This is the same reasoning Phase 3 applied to build-info artifacts, one level
 * up: an artifact is trusted only against the bytes it was made from.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  buildProjectGraph,
  effectiveSettings,
  type BuildProjectGraphOptions,
  type ProjectGraphResult,
} from '../ingest.js';
import { graphFromFile, readGraph, type AxiomapGraph } from '../graph/index.js';
import type { GraphFile, GraphSettings } from '../graph/schema.js';
import type { AnalysisOptions } from '../analysis/index.js';
import { CONFIG_FILE, loadConfig, type AxiomapConfig, type LoadedConfig } from './config.js';
import { detectProject } from './detect.js';
import { listSolidityFiles } from './detect.js';

/** Where `axiomap build` writes the artifact, relative to the project root. */
export const GRAPH_FILE = path.join('.axiomap', 'graph.json');

export interface SessionOptions {
  /** Project directory. Default: the current directory. */
  path?: string;
  /** Explicit `axiomap.config.json`. */
  config?: string;
  /** Rebuild even if the stored artifact looks current. */
  rebuild?: boolean;
  /** Use the stored artifact even if sources are newer. */
  stale?: boolean;
  workers?: number;
  /** Skip the semantic tier (§4) — the syntactic graph, deliberately. */
  noEnrich?: boolean;
}

export interface ProjectContext {
  root: string;
  config: AxiomapConfig;
  configFile: string | null;
  warnings: string[];
}

export function openProject(options: SessionOptions): ProjectContext {
  const root = path.resolve(options.path ?? process.cwd());
  if (!fs.existsSync(root)) {
    throw new Error(`No such directory: ${root}`);
  }
  const loaded: LoadedConfig = loadConfig(root, options.config);
  return {
    root,
    config: loaded.config,
    configFile: loaded.file,
    warnings: loaded.warnings,
  };
}

/**
 * §13's knobs, in the shape the core passes take them.
 *
 * One place, because §13 fixes that a diff analyses both revisions with the
 * *invoking* working tree's config, and the only way to be sure of that is for
 * there to be one function that turns a config into analysis options.
 */
export function analysisOptions(config: AxiomapConfig): AnalysisOptions {
  return {
    ...(config.entrypoints === undefined ? {} : { entrypoints: config.entrypoints }),
    ...(config.accessControlModifiers === undefined
      ? {}
      : { accessControlModifiers: config.accessControlModifiers }),
    ...(config.reentrancyGuards === undefined ? {} : { reentrancyGuards: config.reentrancyGuards }),
  };
}

export function buildOptions(
  context: ProjectContext,
  options: SessionOptions,
): BuildProjectGraphOptions {
  const { config } = context;
  return {
    ...(config.include === undefined ? {} : { include: config.include }),
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
    ...(config.trustBoundaries?.external === undefined
      ? {}
      : { trustBoundaries: { external: config.trustBoundaries.external } }),
    analysis: analysisOptions(config),
    ...(options.workers === undefined ? {} : { workers: options.workers }),
    ...(options.noEnrich === true ? { enrich: false } : {}),
  };
}

export interface LoadedGraph {
  graph: AxiomapGraph;
  file: GraphFile;
  /** Where it came from, for the header line. */
  origin: 'built' | 'artifact';
  /** Set when the artifact was rebuilt, and why. */
  reason: string | null;
}

/**
 * Do the settings this artifact was built with match the ones in force now?
 *
 * The mtime check below catches an edited config at the default path. It cannot
 * catch a config named explicitly, a config outside the project, or a graph
 * built with enrichment off — and in every one of those cases the artifact is a
 * confident answer to a different question. `axiomap query externals
 * --unprotected -c strict.json` reading a graph built with the default guard
 * list is the kind of wrong this tool exists not to be.
 *
 * Compared as canonical JSON rather than field by field, so a §13 field added
 * later is covered without anyone remembering to add it here.
 */
function settingsMatch(stored: GraphSettings | undefined, wanted: GraphSettings): boolean {
  const canonical = (value: GraphSettings | undefined): string =>
    JSON.stringify(
      Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    );
  return canonical(stored) === canonical(wanted);
}

/** The newest mtime among the things a graph is derived from, or null. */
export function newestInput(root: string): number | null {
  const project = detectProject(root);
  let newest: number | null = null;

  const consider = (file: string): void => {
    try {
      const { mtimeMs } = fs.statSync(file);
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch {
      // A file that vanished between the walk and the stat cannot make the
      // artifact fresher, so ignoring it is the safe direction.
    }
  };

  for (const relative of listSolidityFiles(project)) consider(path.join(root, relative));
  for (const relative of project.configFiles) consider(path.join(root, relative));
  consider(path.join(root, CONFIG_FILE));

  return newest;
}

/**
 * What a host may want to say while a build is running.
 *
 * A hook rather than a return value because the interesting moment is the one
 * *before* the answer: a 200k-SLOC parse is seconds long, and a terminal wants a
 * spinner and an editor wants a progress notification. Neither belongs in core,
 * and neither is worth a second copy of the function below.
 */
export interface SessionHooks {
  onBuildStart?: (root: string) => void;
  onBuildEnd?: (result: { files: number } | { error: unknown }) => void;
}

async function build(
  context: ProjectContext,
  options: SessionOptions,
  hooks: SessionHooks,
): Promise<ProjectGraphResult> {
  hooks.onBuildStart?.(context.root);
  try {
    const result = await buildProjectGraph(context.root, buildOptions(context, options));
    hooks.onBuildEnd?.({ files: result.files.length });
    return result;
  } catch (error) {
    hooks.onBuildEnd?.({ error });
    throw error;
  }
}

/**
 * The artifact if it is still true, a fresh build otherwise.
 *
 * The one function every host calls, and the reason this module is in core.
 */
export async function loadProjectGraph(
  context: ProjectContext,
  options: SessionOptions = {},
  hooks: SessionHooks = {},
): Promise<LoadedGraph> {
  const artifact = path.join(context.root, GRAPH_FILE);
  const wanted = effectiveSettings(buildOptions(context, options));

  if (options.rebuild !== true && fs.existsSync(artifact)) {
    let reason: string | null = null;
    if (options.stale !== true) {
      const newest = newestInput(context.root);
      const written = fs.statSync(artifact).mtimeMs;
      if (newest !== null && newest > written) {
        reason = 'a source file is newer than .axiomap/graph.json';
      }
    }

    if (reason === null) {
      try {
        const file = readGraph(artifact);
        // Checked even under `stale`: that flag means "the sources moved on and
        // I know it", not "answer a different question than the one I asked". A
        // settings mismatch is not staleness, it is a category error.
        if (!settingsMatch(file.generator.settings, wanted)) {
          reason = '.axiomap/graph.json was built with different settings (AXIOMAP.md §13)';
        } else {
          return { graph: graphFromFile(file, artifact), file, origin: 'artifact', reason: null };
        }
      } catch (error) {
        // A schema mismatch or a hand-edited artifact is a reason to rebuild,
        // not a reason to stop: the sources are still there and they are the
        // truth. The message still surfaces, so nothing is silent.
        reason = error instanceof Error ? error.message : String(error);
      }
    }

    const built = await build(context, options, hooks);
    return { graph: built.graph, file: built.file, origin: 'built', reason };
  }

  const built = await build(context, options, hooks);
  return { graph: built.graph, file: built.file, origin: 'built', reason: null };
}
