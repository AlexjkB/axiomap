/**
 * Reading and writing `graph.json`.
 *
 * §3: `graph.json` is a public artifact, so it carries a `schemaVersion` and a
 * mismatch is **refused**, not coerced. The failure mode this prevents is
 * specific and nasty — an old graph deserialised into a new shape produces a
 * diff full of phantom changes, and diff output is the product (§8).
 *
 * Output is deterministic: keys in a fixed order, arrays sorted by the builder,
 * two-space indent, trailing newline. The golden-file suite is the most
 * important test in the project (§7), and a serializer whose output depends on
 * insertion order turns every run into a spurious diff and trains people to
 * regenerate goldens without reading them — the one habit §6 says would destroy
 * the correctness guarantees.
 */

import fs from 'node:fs';
import path from 'node:path';

import { GRAPH_SCHEMA_VERSION, graphFileSchema, type GraphFile } from './schema.js';

export class GraphSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphSchemaError';
  }
}

/**
 * Key order is fixed here rather than left to object literal order, so that a
 * refactor in `build.ts` cannot silently reorder every golden file.
 */
function orderedGraph(file: GraphFile): unknown {
  return {
    schemaVersion: file.schemaVersion,
    generator: {
      name: file.generator.name,
      parser: file.generator.parser,
      hashVersion: file.generator.hashVersion,
    },
    project: {
      kind: file.project.kind,
      sources: file.project.sources,
      files: file.project.files,
    },
    mode: file.mode,
    modeReason: file.modeReason,
    score: file.score,
    diagnostics: file.diagnostics,
    nodes: file.nodes,
    edges: file.edges,
  };
}

export function serializeGraph(file: GraphFile): string {
  return `${JSON.stringify(orderedGraph(file), null, 2)}\n`;
}

export function parseGraph(text: string, source = '<memory>'): GraphFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new GraphSchemaError(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Check the version before the shape, so a version mismatch reports itself
  // as a version mismatch rather than as forty field errors.
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== GRAPH_SCHEMA_VERSION) {
    throw new GraphSchemaError(
      `${source} has schemaVersion ${String(version)}, but this build of Axiomap writes ` +
        `${GRAPH_SCHEMA_VERSION}. Rebuild the graph with "axiomap build".`,
    );
  }

  const result = graphFileSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.join('.')}: ${issue.message}`;
    throw new GraphSchemaError(`${source} does not match the graph schema${where}`);
  }
  return result.data;
}

export function writeGraph(target: string, file: GraphFile): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeGraph(file), 'utf8');
}

export function readGraph(target: string): GraphFile {
  return parseGraph(fs.readFileSync(target, 'utf8'), target);
}

/**
 * §4's one-line build summary, printed on every build.
 *
 * Deliberately blunt about uncertainty: the confidence split is the headline,
 * not a footnote, because a tool that quietly implies certainty it does not
 * have is worse than useless in an audit.
 */
export function describeScore(file: GraphFile): string {
  const { overall } = file.score;
  if (overall.total === 0) return '0 edges — nothing to resolve.';
  const share = (value: number): string => `${Math.round((value / overall.total) * 100)}%`;
  return (
    `${overall.total} edges — ${share(overall.semantic)} semantic, ` +
    `${share(overall.heuristic)} heuristic, ${share(overall.ambiguous)} ambiguous, ` +
    `${share(overall.unresolved)} unresolved`
  );
}
