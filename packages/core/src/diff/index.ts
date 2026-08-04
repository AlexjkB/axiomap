/**
 * The diff engine (§8).
 *
 * `match.ts` decides what is the same node across two revisions, `classify.ts`
 * says what changed about it, and `findings.ts` turns that into the
 * audit-relevant list §8 calls the actual product. `diffGraphs` is all three,
 * and is what `axiomap diff` and the webview both consume.
 *
 * Composed here rather than inside `classify.ts` so that the classification
 * stays independently testable and the two files do not have to import each
 * other.
 */

import type { AxiomapGraph } from '../graph/build.js';
import { classifyChanges, type DiffOptions, type GraphDiff } from './classify.js';
import { deriveFindings, type DiffFinding } from './findings.js';

export * from './match.js';
export * from './classify.js';
export * from './findings.js';

export interface AxiomapDiff extends GraphDiff {
  /** Sorted by severity, then kind, then node. */
  findings: DiffFinding[];
}

export function diffGraphs(
  before: AxiomapGraph,
  after: AxiomapGraph,
  options: DiffOptions = {},
): AxiomapDiff {
  const diff = classifyChanges(before, after, options);
  return { ...diff, findings: deriveFindings(diff) };
}
