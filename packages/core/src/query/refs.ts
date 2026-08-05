/**
 * Turning what a human types into a node id.
 *
 * §8's ids are precise and long — `src/Vault.sol:Vault.deposit(uint256)` — which
 * is right for an artifact two programs join on and wrong for something an
 * auditor types forty times an hour. Every §12 query takes a node, so this is
 * the difference between a usable terminal tool and one people write shell
 * wrappers around.
 *
 * The rule is **narrow, then refuse**. A reference is matched against
 * progressively looser forms, and the first form that matches anything decides
 * the answer. If that form matches more than one node, the result is
 * `ambiguous` with every candidate listed — never the first one, and never a
 * best guess. §6's "do not guess and proceed" is about the resolver, but the
 * reasoning carries: an auditor who asks about `Vault.deposit` and silently
 * gets told about `MockVault.deposit` has been misled by a convenience.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { GraphNode, NodeKind } from '../graph/schema.js';

export interface NodeRefOptions {
  /** Only consider these kinds. A `writers-of <var>` wants a StateVariable. */
  kinds?: readonly NodeKind[];
}

export type NodeRefResult =
  | { found: true; id: string; node: GraphNode }
  | { found: false; reason: 'not-found'; candidates: [] }
  | { found: false; reason: 'ambiguous'; candidates: string[] };

/**
 * `src/Vault.sol:Vault.deposit(uint256)` → the parts a shorter reference can
 * name. Parsing rather than substring matching, so `deposit` cannot match
 * `_predeposit` and `Vault` cannot match `MockVault`.
 */
function parts(id: string): { file: string; qualified: string; member: string; bare: string } {
  const colon = id.lastIndexOf(':');
  const file = colon === -1 ? '' : id.slice(0, colon);
  const qualified = colon === -1 ? id : id.slice(colon + 1);
  const paren = qualified.indexOf('(');
  const withoutParams = paren === -1 ? qualified : qualified.slice(0, paren);
  const dot = withoutParams.lastIndexOf('.');
  const hash = withoutParams.lastIndexOf('#');
  const cut = Math.max(dot, hash);
  return {
    file,
    qualified,
    member: withoutParams,
    bare: cut === -1 ? withoutParams : withoutParams.slice(cut + 1),
  };
}

/**
 * The forms a reference may take, loosest last. Each is a total function from a
 * node to the string that form would match, so a tier is one map lookup.
 */
const FORMS: ((id: string) => string)[] = [
  (id) => id,
  // `Vault.deposit(uint256)` — dropped the file, kept the signature.
  (id) => parts(id).qualified,
  // `Vault.deposit` / `Vault#onlyOwner` — dropped the parameter list.
  (id) => parts(id).member,
  // `deposit` — the bare name.
  (id) => parts(id).bare,
];

export function resolveNodeRef(
  graph: AxiomapGraph,
  ref: string,
  options: NodeRefOptions = {},
): NodeRefResult {
  const kinds = options.kinds === undefined ? null : new Set<NodeKind>(options.kinds);

  const eligible: GraphNode[] = [];
  graph.forEachNode((_id, node) => {
    if (kinds !== null && !kinds.has(node.kind)) return;
    eligible.push(node);
  });

  for (const form of FORMS) {
    const hits = eligible.filter((node) => form(node.id) === ref);
    if (hits.length === 1) {
      const [node] = hits;
      if (node !== undefined) return { found: true, id: node.id, node };
    }
    if (hits.length > 1) {
      return {
        found: false,
        reason: 'ambiguous',
        candidates: hits.map((node) => node.id).sort(),
      };
    }
  }

  return { found: false, reason: 'not-found', candidates: [] };
}

/**
 * Ids whose bare name is close to `ref`, for a "did you mean" list.
 *
 * Case-insensitive containment rather than an edit distance: the failure this
 * serves is a half-remembered name, not a typo, and a substring test cannot
 * produce a confidently wrong suggestion the way a distance threshold can.
 */
export function suggestNodes(
  graph: AxiomapGraph,
  ref: string,
  options: NodeRefOptions & { limit?: number } = {},
): string[] {
  const kinds = options.kinds === undefined ? null : new Set<NodeKind>(options.kinds);
  const needle = ref.toLowerCase();
  const hits: string[] = [];
  graph.forEachNode((_id, node) => {
    if (kinds !== null && !kinds.has(node.kind)) return;
    if (node.id.toLowerCase().includes(needle) || needle.includes(node.name.toLowerCase())) {
      hits.push(node.id);
    }
  });
  return hits.sort().slice(0, options.limit ?? 8);
}

/**
 * Resolve or throw with a message an auditor can act on (§6: errors carry
 * actionable context).
 */
export class NodeRefError extends Error {
  readonly candidates: string[];

  constructor(message: string, candidates: string[]) {
    super(message);
    this.name = 'NodeRefError';
    this.candidates = candidates;
  }
}

export function requireNode(
  graph: AxiomapGraph,
  ref: string,
  options: NodeRefOptions = {},
): GraphNode {
  const result = resolveNodeRef(graph, ref, options);
  if (result.found) return result.node;

  if (result.reason === 'ambiguous') {
    throw new NodeRefError(
      `"${ref}" matches ${result.candidates.length} nodes. Name one of them exactly:\n` +
        result.candidates.map((id) => `  ${id}`).join('\n'),
      result.candidates,
    );
  }

  const suggestions = suggestNodes(graph, ref, options);
  const kinds = options.kinds === undefined ? '' : ` of kind ${options.kinds.join('/')}`;
  throw new NodeRefError(
    `No node${kinds} matches "${ref}".` +
      (suggestions.length === 0
        ? ' Run "axiomap stats" to see what the graph contains.'
        : `\nDid you mean:\n${suggestions.map((id) => `  ${id}`).join('\n')}`),
    suggestions,
  );
}
