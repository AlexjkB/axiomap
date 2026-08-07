/**
 * Which functions an external actor can reach, and through which entrypoints
 * (§7 Phase 4, §10's `externallyReachable` and `entrypoints`).
 *
 * This is the pass behind `query externals` and §15's "identify
 * every externally reachable state-mutating function with no access control".
 * It is a pure function over the graph: it reads the edges that are there and
 * derives nothing from the symbol table, the parse, or a compiler.
 *
 * ### What counts as an entrypoint
 *
 * A `public` or `external` function, fallback or receive, **with a body**, on a
 * contract that can be deployed — or on one of its bases, since an inherited
 * public function is callable on the derived contract even though the node for
 * it lives on the base.
 *
 * Three exclusions are deliberate:
 *
 * - **Constructors.** They run once at deployment and no actor can call one on
 *   a live system. A constructor with no access control is not a finding, and
 *   §15's third item would fill with them. Code a constructor calls is still
 *   reached, through the `creates` edge of whoever deploys it.
 * - **Bodyless declarations.** An interface's `transfer` is a declaration, not
 *   executable code. It still becomes *reachable* when something calls it —
 *   it is just never the origin of the traversal.
 * - **`default` visibility.** In 0.8 that only comes out of a recovered parse
 *   (`SyntaxError.sol`'s truncated function). Guessing `public` for a
 *   declaration the parser could not read is the kind of confident-wrong answer
 *   §6 rules out.
 *
 * ### What the traversal follows
 *
 * `calls` edges, plus **`possibleTargets`**: an interface call resolves to the
 * interface's function and fans out to every implementation (§10). Following
 * only the static target would report every implementation reached solely
 * through an interface as unreachable, and §11 *dims* unreachable nodes — so
 * that error hides live code, which is the worse direction.
 *
 * `modifiedBy`, because a modifier's body runs whenever the function it guards
 * does, and modifiers call things. And `creates`, which lands on a Contract
 * node rather than a Function: from there the traversal picks up that
 * contract's constructor and continues.
 *
 * ### In structural mode
 *
 * There are no `calls` or `creates` edges (§4), so nothing propagates and the
 * answer is "the entrypoints, and nothing else". That is the true reachability
 * of the graph as it exists rather than a claim about the code; `mode` on the
 * graph file is how a consumer knows which it is looking at.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { GraphNode } from '../graph/schema.js';

export interface ReachabilityOptions {
  /**
   * Extra entrypoint node ids, from §13's `entrypoints`. A contract id names
   * every externally-callable function declared on it; a function id names one.
   */
  entrypoints?: readonly string[];
}

export interface FunctionReachability {
  externallyReachable: boolean;
  /** Sorted, and includes the function itself when it is an entrypoint. */
  entrypoints: string[];
}

export interface ReachabilityResult {
  /** Every entrypoint in the project, sorted. */
  entrypoints: string[];
  byFunction: Map<string, FunctionReachability>;
}

const ENTRY_SUBKINDS = new Set(['function', 'fallback', 'receive']);
const ENTRY_VISIBILITIES = new Set(['public', 'external']);
const DEPLOYABLE_KINDS = new Set(['contract', 'library']);

/** Contracts that can be deployed, plus every base they inherit from. */
function deployableScopes(graph: AxiomapGraph): Set<string> {
  const scopes = new Set<string>();
  graph.forEachNode((_id, node) => {
    if (node.kind !== 'Contract' || !DEPLOYABLE_KINDS.has(node.contractKind)) return;
    scopes.add(node.id);
    for (const base of node.linearizedBases) scopes.add(base);
  });
  return scopes;
}

function isDeclaredEntrypoint(node: GraphNode, scopes: ReadonlySet<string>): boolean {
  return (
    node.kind === 'Function' &&
    ENTRY_SUBKINDS.has(node.subkind) &&
    ENTRY_VISIBILITIES.has(node.visibility) &&
    node.hasBody &&
    node.scope !== null &&
    scopes.has(node.scope)
  );
}

/**
 * Forward edges for the traversal, keyed by function id.
 *
 * Built once rather than walked per entrypoint: the propagation below visits
 * every edge many times, and `possibleTargets` resolution is the expensive part
 * of each visit.
 */
function successors(graph: AxiomapGraph): Map<string, string[]> {
  const constructors = new Map<string, string>();
  graph.forEachNode((_id, node) => {
    if (node.kind === 'Function' && node.subkind === 'constructor' && node.scope !== null) {
      constructors.set(node.scope, node.id);
    }
  });

  const out = new Map<string, string[]>();
  const add = (from: string, to: string | undefined): void => {
    if (to === undefined || !graph.hasNode(to)) return;
    if (graph.getNodeAttributes(to).kind !== 'Function') return;
    const list = out.get(from);
    if (list === undefined) out.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };

  graph.forEachEdge((_key, edge, source) => {
    if (graph.getNodeAttributes(source).kind !== 'Function') return;
    switch (edge.kind) {
      case 'calls':
        add(source, edge.to);
        for (const target of edge.possibleTargets) add(source, target);
        break;
      case 'modifiedBy':
        add(source, edge.to);
        break;
      case 'creates':
        // The edge lands on the Contract; what runs is its constructor.
        add(source, constructors.get(edge.to));
        break;
      default:
        break;
    }
  });
  return out;
}

/**
 * Entrypoint sets as bitsets, propagated to a fixpoint over a worklist.
 *
 * The obvious implementation — one BFS per entrypoint — is O(entrypoints ×
 * edges), which on the `large/` fixture is a few thousand entrypoints against
 * ~75k edges. A word-parallel union costs one pass per changed node instead,
 * and cycles fall out of the fixpoint rather than needing a visited set per
 * source.
 */
function propagate(
  entrypoints: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Map<string, Uint32Array> {
  const words = Math.max(1, Math.ceil(entrypoints.length / 32));
  const sets = new Map<string, Uint32Array>();
  const setOf = (id: string): Uint32Array => {
    let set = sets.get(id);
    if (set === undefined) {
      set = new Uint32Array(words);
      sets.set(id, set);
    }
    return set;
  };

  entrypoints.forEach((id, index) => {
    const set = setOf(id);
    const word = index >>> 5;
    set[word] = (set[word] as number) | (1 << (index & 31));
  });

  const queue = [...entrypoints];
  const queued = new Set(entrypoints);
  while (queue.length > 0) {
    const current = queue.pop() as string;
    queued.delete(current);
    const source = setOf(current);
    for (const next of edges.get(current) ?? []) {
      const target = setOf(next);
      let changed = false;
      for (let i = 0; i < words; i++) {
        const merged = (target[i] as number) | (source[i] as number);
        if (merged !== target[i]) {
          target[i] = merged;
          changed = true;
        }
      }
      if (changed && !queued.has(next)) {
        queued.add(next);
        queue.push(next);
      }
    }
  }
  return sets;
}

export function computeReachability(
  graph: AxiomapGraph,
  options: ReachabilityOptions = {},
): ReachabilityResult {
  const scopes = deployableScopes(graph);
  const configured = new Set(options.entrypoints ?? []);

  const entrypoints: string[] = [];
  graph.forEachNode((_id, node) => {
    if (node.kind !== 'Function') return;
    if (isDeclaredEntrypoint(node, scopes)) {
      entrypoints.push(node.id);
      return;
    }
    if (!node.hasBody) return;
    // A configured *contract* id names that contract's externally-callable
    // functions — it narrows the surface, it does not invent one, so an
    // internal helper stays internal. A configured *function* id is a
    // deliberate override and is taken at its word.
    if (configured.has(node.id)) entrypoints.push(node.id);
    else if (
      node.scope !== null &&
      configured.has(node.scope) &&
      ENTRY_SUBKINDS.has(node.subkind) &&
      ENTRY_VISIBILITIES.has(node.visibility)
    ) {
      entrypoints.push(node.id);
    }
  });
  entrypoints.sort();

  const sets = propagate(entrypoints, successors(graph));

  const byFunction = new Map<string, FunctionReachability>();
  graph.forEachNode((_id, node) => {
    if (node.kind !== 'Function') return;
    const set = sets.get(node.id);
    const reached: string[] = [];
    if (set !== undefined) {
      // Word-wise, skipping the empty ones. Iterating all `entrypoints` per
      // function instead is a few thousand times a few thousand on `large/`,
      // and it showed up as most of this pass's cost against §9's budget.
      for (let word = 0; word < set.length; word++) {
        let bits = set[word] as number;
        while (bits !== 0) {
          const bit = 31 - Math.clz32(bits & -bits);
          bits &= bits - 1;
          reached.push(entrypoints[(word << 5) + bit] as string);
        }
      }
    }
    byFunction.set(node.id, { externallyReachable: reached.length > 0, entrypoints: reached });
  });

  return { entrypoints, byFunction };
}
