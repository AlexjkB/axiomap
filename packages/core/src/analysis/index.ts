/**
 * Phase 4's analysis passes: one file per pass, each a pure function over the
 * graph, named for what it computes (§6).
 *
 * Three items §7 originally listed here are **not** in this directory, because
 * Phase 2 could not resolve anything without them: C3 linearization
 * (`linearizedBases` and `linearizationCertainty` on every Contract node),
 * state access (`reads`/`writes` edges) and cyclomatic complexity
 * (`Function.metrics`). §7 was amended to say so. Phase 4 consumes all three;
 * recomputing any of them here would give a second answer that can disagree
 * with the first.
 *
 * `analyseGraph` runs the passes and `applyAnalysis` writes §10's four fields
 * onto the Function nodes. They are separate so that the passes stay callable
 * on a graph read back from disk — Phase 6's `axiomap query` does exactly that
 * — without a build having to have run.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { GraphNode } from '../graph/schema.js';
import { computeAccessControl, type AccessControlOptions } from './access-control.js';
import { classifyExternalCalls, type ExternalCallOptions } from './external-calls.js';
import { computeReachability, type ReachabilityOptions } from './reachability.js';
import type { ExternalCallResult } from './external-calls.js';
import type { ReachabilityResult } from './reachability.js';
import type { AccessControl } from '../graph/schema.js';

export * from './reachability.js';
export * from './access-control.js';
export * from './external-calls.js';

export type AnalysisOptions = ReachabilityOptions & AccessControlOptions & ExternalCallOptions;

export interface AnalysisResult {
  reachability: ReachabilityResult;
  accessControl: Map<string, AccessControl>;
  externalCalls: ExternalCallResult;
}

export function analyseGraph(graph: AxiomapGraph, options: AnalysisOptions = {}): AnalysisResult {
  return {
    reachability: computeReachability(graph, options),
    accessControl: computeAccessControl(graph, options),
    externalCalls: classifyExternalCalls(graph, options),
  };
}

/**
 * Write the results onto the Function nodes, in place.
 *
 * The nodes handed here are the same objects the graph holds as attributes and
 * the same ones `graph.json` serializes, which is what keeps the two from
 * disagreeing. `graph.test.ts` asserts that identity rather than assuming it.
 */
export function applyAnalysis(nodes: readonly GraphNode[], analysis: AnalysisResult): void {
  for (const node of nodes) {
    if (node.kind !== 'Function') continue;
    const reach = analysis.reachability.byFunction.get(node.id);
    if (reach !== undefined) {
      node.externallyReachable = reach.externallyReachable;
      node.entrypoints = reach.entrypoints;
    }
    const access = analysis.accessControl.get(node.id);
    if (access !== undefined) node.accessControl = access;
    const external = analysis.externalCalls.byFunction.get(node.id);
    if (external !== undefined) node.reentrancy = external.reentrancy;
  }
}
