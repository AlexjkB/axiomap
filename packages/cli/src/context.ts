/**
 * The terminal's half of opening a project.
 *
 * The policy — which artifact is trustworthy, what makes it stale, how §13's
 * config becomes analysis options — **moved to `core/project/session.ts` in
 * Phase 8**, because the VS Code extension is the second host to open a project
 * and §5 forbids it importing this package. Two copies of "is
 * `.axiomap/graph.json` still true" would be two answers to that question, and
 * the two hosts disagreeing about whether the graph describes the code on disk
 * is the one disagreement this tool cannot afford.
 *
 * What is left here is what is genuinely the CLI's: the option names its flags
 * spell (`--json`, `--stale`), and the spinner a terminal shows while a build
 * runs. Both are presentation, and core has none.
 */

import path from 'node:path';

import {
  buildOptions,
  buildProjectGraph,
  ensureAxiomapDir,
  GRAPH_FILE,
  loadProjectGraph,
  writeGraph,
  type AxiomapGraph,
  type GraphFile,
  type LoadedGraph,
  type ProjectContext,
  type SessionOptions,
} from '@axiomap/core';

import { spinner } from './progress.js';

export {
  analysisOptions,
  buildOptions,
  GRAPH_FILE,
  openProject,
  type LoadedGraph,
  type ProjectContext,
} from '@axiomap/core';

/**
 * Every read-only command's flags.
 *
 * `SessionOptions` plus `--json`, which decides whether the spinner is drawn —
 * a progress animation interleaved with machine-readable output on the same
 * stream is output nobody can parse.
 */
export interface CommonOptions extends SessionOptions {
  json?: boolean;
}

/** Core's loader, with the terminal's spinner attached to its two moments. */
export async function loadGraph(
  context: ProjectContext,
  options: CommonOptions,
): Promise<LoadedGraph> {
  const quiet = options.json === true;
  const spin = spinner(`Parsing ${context.root}`, quiet);
  return loadProjectGraph(context, options, {
    onBuildEnd: (result) => {
      if ('error' in result) spin.fail('Build failed');
      else spin.succeed(`Graphed ${String(result.files)} files`);
    },
  });
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
