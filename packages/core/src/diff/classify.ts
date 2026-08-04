/**
 * Change classification (§8's diff output model).
 *
 * Per node and per edge: `added | removed | modified | moved | renamed |
 * unchanged`. This is the plumbing — §8 says so itself, and `findings.ts` is
 * the product built on top of it.
 *
 * ### What counts as a change, and what deliberately does not
 *
 * Three groups of fields are excluded from the comparison, each for a reason
 * that would otherwise fill the output with noise:
 *
 * - **Source positions.** `src` on every node and `sites` on every edge move
 *   whenever anything above them in the file does. A function that did not
 *   change is unchanged even if it now starts forty lines lower.
 * - **The semantic tier.** `resolution`, `possibleTargets`, `selector`, `slot`
 *   and `offset` say what a compiler knew, not what the code does. §8's whole
 *   argument is that diffing two revisions is cheap *because* neither has to
 *   compile — so the normal case is one revision with artifacts and one
 *   without, and a tier change must not read as a code change. There is a test
 *   for exactly that: the same revision at both tiers diffs to nothing.
 * - **Derived metrics.** `metrics` is a summary of the body, and `sloc` counts
 *   comment lines. Including it would make a NatSpec typo fix a modification,
 *   which is the case §8's hash rules exist to *not* flag.
 *
 * Phase 4's transitive fields — `externallyReachable`, `entrypoints` and
 * `reentrancy` — are excluded for a sharper reason. One edited leaf helper
 * flips all three on every caller above it, so treating them as ordinary
 * attributes fills the "what must I re-review" list with functions whose source
 * did not change, and that list is the product. They are read by `findings.ts`
 * instead, which labels a finding `direct` or `consequence` according to
 * whether the node it lands on changed itself.
 *
 * `accessControl` is not in that group even though it is also computed: it is
 * derived from the function's own modifiers and its own `checksSender` flag, so
 * it moves only when the function does.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { GraphEdge, GraphNode, NodeKind } from '../graph/schema.js';
import { matchNodes, type MatchOptions, type NodeMatch, type NodeMatching } from './match.js';

export type ChangeStatus = 'added' | 'removed' | 'modified' | 'moved' | 'renamed' | 'unchanged';
export type EdgeChangeStatus = 'added' | 'removed' | 'modified' | 'unchanged';

export interface NodeChange {
  status: ChangeStatus;
  /** The after id where there is one, otherwise the before id. */
  id: string;
  kind: NodeKind;
  before: GraphNode | null;
  after: GraphNode | null;
  /** Null for added and removed nodes. */
  match: NodeMatch | null;
  /** Compared attributes that differ, sorted. Empty unless matched. */
  changes: string[];
}

export interface EdgeChange {
  status: EdgeChangeStatus;
  /** `kind|subkind|from|to`, with both endpoints in before-space. */
  key: string;
  /**
   * Endpoints in before-space — the after graph's ids projected back through
   * the matching. Carried rather than parsed back out of `key` so a caller
   * never has to know that a node id contains no `|`.
   */
  from: string;
  to: string;
  before: GraphEdge | null;
  after: GraphEdge | null;
  changes: string[];
}

export interface GraphDiff {
  matching: NodeMatching;
  /** Every node on either side, sorted by id. Includes `unchanged`. */
  nodes: NodeChange[];
  edges: EdgeChange[];
  nodeSummary: Record<ChangeStatus, number>;
  edgeSummary: Record<EdgeChangeStatus, number>;
}

export type DiffOptions = MatchOptions;

/**
 * The attributes compared, per node kind. Anything not listed here is either a
 * position, a semantic-tier annotation or a derived field — see the header.
 */
const COMPARED: Record<NodeKind, readonly string[]> = {
  SourceUnit: ['name', 'file', 'pragma', 'versionSupport', 'recovered', 'unresolvedImports'],
  Contract: [
    'name',
    'file',
    'scope',
    'contractKind',
    'baseNames',
    'linearizedBases',
    'linearizationCertainty',
    'isFullyImplemented',
    'isTest',
    'isMock',
  ],
  Function: [
    'name',
    'file',
    'scope',
    'subkind',
    'visibility',
    'stateMutability',
    'isVirtual',
    'isOverride',
    'modifiers',
    'params',
    'returns',
    'hasBody',
    'bodyHash',
    'interfaceHash',
    'flags',
    'accessControl',
  ],
  StateVariable: [
    'name',
    'file',
    'scope',
    'type',
    'visibility',
    'isConstant',
    'isImmutable',
    'isTransient',
    'isMapping',
  ],
  Event: ['name', 'file', 'scope', 'params', 'isAnonymous'],
  Error: ['name', 'file', 'scope', 'params'],
  Struct: ['name', 'file', 'scope'],
  Enum: ['name', 'file', 'scope'],
  UserDefinedValueType: ['name', 'file', 'scope'],
  /**
   * No `file` and no `scope`. A synthetic placeholder is project-wide (Phase 2
   * keeps it so deliberately), and the file on it is whichever call site
   * happened to be resolved first — so comparing it reports `?low-level:call`
   * as *moved* every time an unrelated file changes. Its identity is its name
   * and its category, which is what its id is built from.
   */
  Unresolved: ['name', 'category'],
};

const EDGE_COMPARED = ['count', 'crossTrustBoundary', 'linearizationIndex'] as const;

/**
 * Structural equality by serialization. Every compared attribute is a JSON
 * scalar, array or plain object built by `graph/build.ts` with its keys in a
 * fixed order, which is what makes this safe as well as short.
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function differingAttributes(before: GraphNode, after: GraphNode): string[] {
  if (before.kind !== after.kind) return ['kind'];
  const fields = COMPARED[before.kind];
  const left = before as unknown as Record<string, unknown>;
  const right = after as unknown as Record<string, unknown>;
  return fields.filter((field) => !same(left[field], right[field])).sort();
}

/**
 * §8's six statuses from one matched pair.
 *
 * Precedence is moved, then renamed, then modified. A function that was moved
 * to another file *and* rewritten is reported as moved with `bodyHash` in
 * `changes` — one status per node is §8's model, and the location change is the
 * one a reader has to know about first to find the thing at all.
 */
function statusOf(before: GraphNode, after: GraphNode, changes: readonly string[]): ChangeStatus {
  if (changes.length === 0) return 'unchanged';
  if (before.file !== after.file || before.scope !== after.scope) return 'moved';
  if (before.name !== after.name) return 'renamed';
  return 'modified';
}

function edgeKey(edge: GraphEdge, from: string, to: string): string {
  return `${edge.kind}|${edge.subkind ?? ''}|${from}|${to}`;
}

interface ProjectedEdge {
  edge: GraphEdge;
  from: string;
  to: string;
}

function edgesOf(graph: AxiomapGraph, project: (id: string) => string): Map<string, ProjectedEdge> {
  const out = new Map<string, ProjectedEdge>();
  graph.forEachEdge((_key, edge) => {
    const from = project(edge.from);
    const to = project(edge.to);
    out.set(edgeKey(edge, from, to), { edge, from, to });
  });
  return out;
}

export function classifyChanges(
  before: AxiomapGraph,
  after: AxiomapGraph,
  options: DiffOptions = {},
): GraphDiff {
  const matching = matchNodes(before, after, options);

  const nodes: NodeChange[] = [];
  const nodeSummary: Record<ChangeStatus, number> = {
    added: 0,
    removed: 0,
    modified: 0,
    moved: 0,
    renamed: 0,
    unchanged: 0,
  };

  for (const match of matching.matches) {
    const beforeNode = before.getNodeAttributes(match.before);
    const afterNode = after.getNodeAttributes(match.after);
    const changes = differingAttributes(beforeNode, afterNode);
    const status = statusOf(beforeNode, afterNode, changes);
    nodes.push({
      status,
      id: match.after,
      kind: afterNode.kind,
      before: beforeNode,
      after: afterNode,
      match,
      changes,
    });
    nodeSummary[status] += 1;
  }
  for (const id of matching.removed) {
    const node = before.getNodeAttributes(id);
    nodes.push({ status: 'removed', id, kind: node.kind, before: node, after: null, match: null, changes: [] });
    nodeSummary.removed += 1;
  }
  for (const id of matching.added) {
    const node = after.getNodeAttributes(id);
    nodes.push({ status: 'added', id, kind: node.kind, before: null, after: node, match: null, changes: [] });
    nodeSummary.added += 1;
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id) || a.status.localeCompare(b.status));

  // Both sides keyed in before-space, so a renamed function's edges are the
  // same edges rather than a matching pair of additions and removals.
  const beforeEdges = edgesOf(before, (id) => id);
  const afterEdges = edgesOf(after, (id) => matching.byAfter.get(id)?.before ?? id);

  const edges: EdgeChange[] = [];
  const edgeSummary: Record<EdgeChangeStatus, number> = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
  };
  for (const key of new Set([...beforeEdges.keys(), ...afterEdges.keys()])) {
    const beforeEdge = beforeEdges.get(key);
    const afterEdge = afterEdges.get(key);
    const endpoints = beforeEdge ?? afterEdge;
    if (endpoints === undefined) continue;

    let status: EdgeChangeStatus;
    let changes: string[] = [];
    if (beforeEdge === undefined) status = 'added';
    else if (afterEdge === undefined) status = 'removed';
    else {
      const left = beforeEdge.edge as unknown as Record<string, unknown>;
      const right = afterEdge.edge as unknown as Record<string, unknown>;
      changes = EDGE_COMPARED.filter((field) => !same(left[field], right[field]));
      status = changes.length === 0 ? 'unchanged' : 'modified';
    }
    edges.push({
      status,
      key,
      from: endpoints.from,
      to: endpoints.to,
      before: beforeEdge?.edge ?? null,
      after: afterEdge?.edge ?? null,
      changes,
    });
    edgeSummary[status] += 1;
  }
  edges.sort((a, b) => a.key.localeCompare(b.key));

  return { matching, nodes, edges, nodeSummary, edgeSummary };
}
