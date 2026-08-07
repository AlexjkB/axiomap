/**
 * §11's CodeLens line, as data: `3 callers · 2 external calls · writes 4 vars ·
 * reviewed`.
 *
 * A lens is a whole-file question — an editor asks once per open document and
 * re-asks on every change — so this is one pass over the graph for every
 * function in a file, rather than `inspectNode` called n times, which walks
 * every edge in the project per call to find virtual arms.
 *
 * ### Counts, not sentences
 *
 * The wording is the extension's: §11 writes the line in UI copy and this file
 * is in `core`, which has no UI (§6). What it owes the host is the four numbers
 * and the review verdict, each defined once so a lens and the inspector cannot
 * disagree about how many callers a function has.
 *
 * ### What each number means, stated because each has a plausible wrong reading
 *
 * - **callers** — distinct nodes with a `calls` edge into this function,
 *   including the ones that reach it only as a `possibleTargets` arm (§10's
 *   virtual dispatch). Excluding those would report an interface implementation
 *   as having no callers, which is exactly the misreading §11's reachability
 *   dimming was fixed for in Phase 4.
 * - **external calls** — outgoing `calls` whose subkind leaves this contract:
 *   `external`, `delegatecall` or `lowlevel`. `library` is a `delegatecall` in
 *   the EVM but not a trust boundary, and counting it would put a number
 *   against every function that uses SafeMath.
 * - **writes** — distinct state variables written, which is what "writes 4
 *   vars" says. Not call sites: two assignments to the same variable are one
 *   variable.
 * - **review** — the status and whether it still stands (§8). A stale
 *   `reviewed` is the one thing this feature exists to surface, so the two
 *   travel separately here as they do in `audit-state.ts`.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { FunctionNode, GraphNode, SourceRefRecord } from '../graph/schema.js';
import type { AuditState, AuditReview } from './audit-state.js';

/** Call subkinds that leave the contract (§10). */
const EXTERNAL_SUBKINDS = new Set(['external', 'delegatecall', 'lowlevel']);

export interface FileLens {
  id: string;
  name: string;
  /** The containing contract, or null at file scope. */
  scope: string | null;
  src: SourceRefRecord;
  subkind: FunctionNode['subkind'];
  visibility: FunctionNode['visibility'];
  /** Distinct callers, virtual arms included. */
  callers: number;
  /** Outgoing calls that cross the contract boundary. */
  externalCalls: number;
  /** Distinct state variables written. */
  writes: number;
  /** Distinct state variables read. */
  reads: number;
  /** §4's transitive answer, as the analysis pass computed it. */
  externallyReachable: boolean;
  accessControl: FunctionNode['accessControl'];
  /** This node's review state, when a `review.json` was loaded. */
  review: AuditReview | null;
  /** How many imported findings land on it (decision #4). */
  findings: number;
}

export interface FileLensOptions {
  /**
   * The two audit-state files, already projected (`auditState`). Absent means
   * no review state was loaded, which a lens says nothing about — an absent
   * file and an unreviewed function are different facts (§11).
   */
  auditState?: AuditState | null;
}

function isFunction(node: GraphNode): node is FunctionNode {
  return node.kind === 'Function';
}

/**
 * Every function declared in one file, with its lens counts, in declaration
 * order.
 *
 * One pass over the project's edges, bucketed by node id. The pass over *every*
 * edge is what the virtual arms cost: a node reached only as a `possibleTarget`
 * has no in-edge to find, the same reason `inspectNode` pays for it.
 */
export function fileLenses(
  graph: AxiomapGraph,
  file: string,
  options: FileLensOptions = {},
): FileLens[] {
  const wanted = new Map<string, FunctionNode>();
  graph.forEachNode((_id, node) => {
    if (node.file === file && isFunction(node)) wanted.set(node.id, node);
  });
  if (wanted.size === 0) return [];

  const callers = new Map<string, Set<string>>();
  const externalCalls = new Map<string, number>();
  const writes = new Map<string, Set<string>>();
  const reads = new Map<string, Set<string>>();

  const add = (into: Map<string, Set<string>>, key: string, value: string): void => {
    const set = into.get(key);
    if (set === undefined) into.set(key, new Set([value]));
    else set.add(value);
  };

  graph.forEachEdge((_key, edge) => {
    if (edge.kind === 'calls') {
      if (wanted.has(edge.to)) add(callers, edge.to, edge.from);
      for (const target of edge.possibleTargets) {
        if (wanted.has(target)) add(callers, target, edge.from);
      }
      if (wanted.has(edge.from) && edge.subkind !== undefined && EXTERNAL_SUBKINDS.has(edge.subkind)) {
        // Call *sites*, not distinct callees: "2 external calls" in a body
        // means two places to look at, and §10 collapses repeats into `count`.
        externalCalls.set(edge.from, (externalCalls.get(edge.from) ?? 0) + edge.count);
      }
      return;
    }
    if (edge.kind === 'writes' && wanted.has(edge.from)) add(writes, edge.from, edge.to);
    if (edge.kind === 'reads' && wanted.has(edge.from)) add(reads, edge.from, edge.to);
  });

  const state = options.auditState ?? null;

  return [...wanted.values()]
    .map((node) => ({
      id: node.id,
      name: node.name,
      scope: node.scope,
      src: node.src,
      subkind: node.subkind,
      visibility: node.visibility,
      callers: callers.get(node.id)?.size ?? 0,
      externalCalls: externalCalls.get(node.id) ?? 0,
      writes: writes.get(node.id)?.size ?? 0,
      reads: reads.get(node.id)?.size ?? 0,
      externallyReachable: node.externallyReachable,
      accessControl: node.accessControl,
      review: state?.review[node.id] ?? null,
      findings: state?.findings[node.id]?.length ?? 0,
    }))
    .sort((a, b) => a.src.offset - b.src.offset || a.id.localeCompare(b.id));
}
