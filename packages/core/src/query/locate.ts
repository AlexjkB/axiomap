/**
 * The graph, indexed by where in the source it came from.
 *
 * Every query before this one starts from a node id. §11's VS Code inverse
 * navigation starts from the opposite end — "editor cursor highlights the
 * corresponding graph node" — so it needs the map from a position in a file
 * back to the node whose declaration contains it. That is a question about the
 * graph and it takes no `fs`, so it lives here rather than in the extension:
 * Phase 7b's rule about the inspector holds for this too, and a version of it
 * written in `packages/vscode` would be the second implementation of a query
 * API this project keeps refusing to grow.
 *
 * ### Offsets are bytes, and the caller converts
 *
 * §10 is emphatic that `SourceRef.offset` is a byte offset, and a host holding
 * an editor buffer has UTF-16 indices. The conversion belongs to whoever has
 * the text — `PositionIndex` does it — so this file compares bytes to bytes and
 * has no opinion about the buffer.
 *
 * ### Innermost wins, and a tie is broken by containment
 *
 * A cursor inside `Vault.deposit` is inside `Vault` and inside
 * `src/Vault.sol`'s SourceUnit as well; all three are real answers and only the
 * narrowest is useful. So the smallest containing range wins. Ranges that are
 * genuinely equal — a contract whose only member spans the same bytes cannot
 * happen, but a recovered parse can produce surprising things — are broken by
 * kind depth, so the member beats its container rather than the answer
 * depending on node insertion order.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { GraphNode, NodeKind } from '../graph/schema.js';

/**
 * How deeply nested a kind is, for the tie-break above. Larger is deeper.
 *
 * `Unresolved` is synthetic (§10) and has no source of its own, so it is
 * excluded entirely rather than ranked — a placeholder carries its *caller's*
 * file and would otherwise answer for a byte range it does not occupy.
 */
const DEPTH: Record<NodeKind, number> = {
  SourceUnit: 0,
  Contract: 1,
  Function: 2,
  StateVariable: 2,
  Event: 2,
  Error: 2,
  Struct: 2,
  Enum: 2,
  UserDefinedValueType: 2,
  Unresolved: -1,
};

function locatable(node: GraphNode): boolean {
  return DEPTH[node.kind] >= 0 && node.src.file === node.file;
}

/**
 * Every node declared in one file, outermost first.
 *
 * Sorted by offset and then by *decreasing* length, which is declaration order
 * with each container immediately before its members — the order a CodeLens
 * provider and an outline both want.
 */
export function nodesInFile(graph: AxiomapGraph, file: string): GraphNode[] {
  const found: GraphNode[] = [];
  graph.forEachNode((_id, node) => {
    if (node.file === file && locatable(node)) found.push(node);
  });
  return found.sort(
    (a, b) => a.src.offset - b.src.offset || b.src.length - a.src.length || a.id.localeCompare(b.id),
  );
}

/**
 * The narrowest node whose declaration contains this byte offset, or null.
 *
 * The range is half-open: a cursor sitting on the closing brace of `deposit` is
 * in `deposit`, and one sitting on the byte after it is not. That is the same
 * convention `PositionIndex.ref` produces, and disagreeing with it here would
 * make the last character of every declaration select its container.
 */
export function nodeAtOffset(graph: AxiomapGraph, file: string, offset: number): GraphNode | null {
  let best: GraphNode | null = null;
  graph.forEachNode((_id, node) => {
    if (node.file !== file || !locatable(node)) return;
    const { offset: start, length } = node.src;
    if (offset < start || offset >= start + length) return;
    if (best === null) {
      best = node;
      return;
    }
    const current: GraphNode = best;
    if (
      length < current.src.length ||
      (length === current.src.length && DEPTH[node.kind] > DEPTH[current.kind])
    ) {
      best = node;
    }
  });
  return best;
}
