/**
 * What every read-only command needs before it can answer anything: a project
 * root, §13's config, and a graph.
 *
 * ### The artifact is used only while it is still true
 *
 * `axiomap build` writes `.axiomap/graph.json`, and `axiomap query` should not
 * re-parse a 200k-SLOC project to answer "who writes to `totalSupply`". But a
 * stale artifact is worse than no artifact: it answers confidently about code
 * that has since changed, and every one of §12's queries would then be quietly
 * wrong at exactly the moment an auditor is relying on it — mid-edit.
 *
 * So the artifact is used when it exists and **no source file is newer than
 * it**, and rebuilt otherwise. An mtime scan is a directory walk the ingest was
 * going to do anyway, and a rebuild with a warm parse cache is a second or two.
 * The expensive-and-right option is the default; `--stale` is there for the
 * person who knows better, and says what it is.
 *
 * This is the same reasoning Phase 3 applied to build-info artifacts, one level
 * up: an artifact is trusted only against the bytes it was made from.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  buildProjectGraph,
  CONFIG_FILE,
  effectiveSettings,
  detectProject,
  ensureAxiomapDir,
  graphFromFile,
  listSolidityFiles,
  loadConfig,
  readGraph,
  writeGraph,
  type AnalysisOptions,
  type AxiomapConfig,
  type AxiomapGraph,
  type BuildProjectGraphOptions,
  type GraphFile,
  type GraphSettings,
  type LoadedConfig,
} from '@axiomap/core';

import { spinner } from './progress.js';

export const GRAPH_FILE = path.join('.axiomap', 'graph.json');

export interface CommonOptions {
  /** Project directory. Default: the current directory. */
  path?: string;
  /** Explicit `axiomap.config.json`. */
  config?: string;
  json?: boolean;
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

export function openProject(options: CommonOptions): ProjectContext {
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
    ...(config.reentrancyGuards === undefined
      ? {}
      : { reentrancyGuards: config.reentrancyGuards }),
  };
}

export function buildOptions(
  context: ProjectContext,
  options: CommonOptions,
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
 * catch `--config elsewhere.json`, a config outside the project, or a graph
 * built with `--no-enrich` — and in every one of those cases the artifact is a
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
function newestInput(root: string, config: AxiomapConfig): number | null {
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
  // `include`/`exclude` change which files matter, and they live in the config
  // file above; nothing else about a config changes the graph's inputs.
  void config;

  return newest;
}

export async function loadGraph(
  context: ProjectContext,
  options: CommonOptions,
): Promise<LoadedGraph> {
  const artifact = path.join(context.root, GRAPH_FILE);
  const quiet = options.json === true;

  const wanted = effectiveSettings(buildOptions(context, options));

  if (options.rebuild !== true && fs.existsSync(artifact)) {
    let reason: string | null = null;
    if (options.stale !== true) {
      const newest = newestInput(context.root, context.config);
      const written = fs.statSync(artifact).mtimeMs;
      if (newest !== null && newest > written) {
        reason = 'a source file is newer than .axiomap/graph.json';
      }
    }

    if (reason === null) {
      try {
        const file = readGraph(artifact);
        // Checked even under `--stale`: that flag means "the sources moved on
        // and I know it", not "answer a different question than the one I
        // asked". A settings mismatch is not staleness, it is a category error.
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

    const built = await build(context, options, quiet);
    return { ...built, reason };
  }

  return { ...(await build(context, options, quiet)), reason: null };
}

async function build(
  context: ProjectContext,
  options: CommonOptions,
  quiet: boolean,
): Promise<{ graph: AxiomapGraph; file: GraphFile; origin: 'built' }> {
  const spin = spinner(`Parsing ${context.root}`, quiet);
  try {
    const result = await buildProjectGraph(context.root, buildOptions(context, options));
    spin.succeed(`Graphed ${String(result.files.length)} files`);
    return { graph: result.graph, file: result.file, origin: 'built' };
  } catch (error) {
    spin.fail('Build failed');
    throw error;
  }
}

/** `axiomap build` — the one command that writes the artifact. */
export async function buildAndWrite(
  context: ProjectContext,
  options: CommonOptions,
): Promise<{ file: GraphFile; graph: AxiomapGraph; files: string[]; artifact: string }> {
  await ensureAxiomapDir(context.root);
  const spin = spinner(`Parsing ${context.root}`, options.json === true);
  try {
    const result = await buildProjectGraph(context.root, buildOptions(context, options));
    spin.succeed(`Graphed ${String(result.files.length)} files`);
    const artifact = path.join(context.root, GRAPH_FILE);
    writeGraph(artifact, result.file);
    return { file: result.file, graph: result.graph, files: result.files, artifact };
  } catch (error) {
    spin.fail('Build failed');
    throw error;
  }
}
