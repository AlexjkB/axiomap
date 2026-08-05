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
 * Emit `preferred` keys first, in that order, then everything else
 * alphabetically.
 *
 * Object key order in JS is insertion order, and `build.ts` inserts optional
 * fields through conditional spreads — so without this, the byte layout of a
 * node depends on which optional fields it happens to have and on the order of
 * statements in the builder. A golden file that reorders itself when someone
 * refactors an object literal is a golden file people learn to regenerate
 * without reading (§6).
 */
function orderKeys(value: Record<string, unknown>, preferred: readonly string[]): unknown {
  const out: Record<string, unknown> = {};
  for (const key of preferred) {
    if (key in value && value[key] !== undefined) out[key] = value[key];
  }
  for (const key of Object.keys(value).sort()) {
    if (preferred.includes(key)) continue;
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

/** §13's order, so a settings block diffs on content rather than on spread order. */
const SETTINGS_KEYS = [
  'include',
  'exclude',
  'entrypoints',
  'accessControlModifiers',
  'reentrancyGuards',
  'trustBoundaries',
  'enrich',
] as const;

const NODE_KEYS = ['id', 'kind', 'name', 'file', 'scope', 'src'] as const;
const EDGE_KEYS = [
  'id',
  'kind',
  'subkind',
  'from',
  'to',
  'resolution',
  'count',
  'sites',
] as const;

/**
 * Fields the file does not store because they can be recomputed exactly.
 *
 * At 200k SLOC this is the difference between a 78 MB artifact and a 42 MB one,
 * with no information lost:
 *
 * - `edge.src` is `sites[0]` for every edge ever produced, by construction.
 * - A flag or param field holding its default carries nothing; the schema
 *   declares the default and restores it on read.
 *
 * `edge.id` is deliberately *not* in this list. It is identity rather than an
 * alias, and this is a public artifact people script against.
 */
function compactParam(param: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: param['name'], type: param['type'] };
  if (param['indexed'] === true) out['indexed'] = true;
  if (param['storageLocation'] != null) out['storageLocation'] = param['storageLocation'];
  return out;
}

function compactNode(node: GraphFile['nodes'][number]): unknown {
  const out: Record<string, unknown> = { ...node };
  if (node.kind === 'Function') {
    out['params'] = node.params.map((p) => compactParam(p as unknown as Record<string, unknown>));
    out['returns'] = node.returns.map((p) => compactParam(p as unknown as Record<string, unknown>));
    const flags: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(node.flags)) if (value) flags[key] = true;
    out['flags'] = flags;

    // Phase 4's fields, dropped when they hold their default — which is most
    // functions for most of them. What survives is the finding: the reachable
    // set, the guards that were recognised, the reentrancy shapes.
    if (!node.externallyReachable) delete out['externallyReachable'];
    if (node.entrypoints.length === 0) delete out['entrypoints'];
    if (node.accessControl.confidence === 'none' && node.accessControl.modifiers.length === 0) {
      delete out['accessControl'];
    }
    if (!node.reentrancy.externalCallThenWrite && !node.reentrancy.guarded) {
      delete out['reentrancy'];
    }
  } else if (node.kind === 'Event' || node.kind === 'Error') {
    out['params'] = node.params.map((p) => compactParam(p as unknown as Record<string, unknown>));
  }
  return orderKeys(out, NODE_KEYS);
}

function compactEdge(edge: GraphFile['edges'][number]): unknown {
  const rest: Record<string, unknown> = { ...edge };
  delete rest['src'];
  return orderKeys(rest, EDGE_KEYS);
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
      // Held at its default — no compiler was involved — so it is not written,
      // like every other defaulted field. An uncompiled project's graph should
      // not carry a line saying so.
      ...(file.generator.compilers.length === 0
        ? {}
        : { compilers: file.generator.compilers }),
      ...(file.generator.settings === undefined
        ? {}
        : { settings: orderKeys(file.generator.settings, SETTINGS_KEYS) }),
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
    nodes: file.nodes.map(compactNode),
    edges: file.edges.map(compactEdge),
  };
}

/**
 * Indented, for golden files and for anyone reading one.
 *
 * The artifact written into a user's repo uses `serializeGraphCompact` instead
 * — indentation is a third of the bytes at scale, and nothing reads
 * `.axiomap/graph.json` by eye. Goldens keep the indentation because their
 * entire purpose is a diff a human reviews (§6).
 */
export function serializeGraph(file: GraphFile): string {
  return `${JSON.stringify(orderedGraph(file), null, 2)}\n`;
}

export function serializeGraphCompact(file: GraphFile): string {
  return `${JSON.stringify(orderedGraph(file))}\n`;
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
  fs.writeFileSync(target, serializeGraphCompact(file), 'utf8');
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
