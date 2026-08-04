/**
 * Node matching across two revisions (§8).
 *
 * Stable ids are path + scope + canonical signature, which makes them stable
 * across recompiles and *unstable* across exactly the two edits an upgrade
 * audit cares about most: renames and moves. So a diff cannot be a set
 * difference over ids. §8 specifies four tiers, and this file is them:
 *
 * 1. **Exact id.** The same node.
 * 2. **Body hash, different id.** Moved or renamed — the body survived intact,
 *    so whatever else happened, this is the same code.
 * 3. **Same container, same name, different signature.** A parameter was added,
 *    removed or retyped. The id changes because the id carries the signature.
 * 4. **Fuzzy.** Signature similarity plus call-neighbourhood overlap, reported
 *    with a confidence so the caller can decide whether to believe it.
 *
 * The tiers run in order and each one only sees what the previous left over, so
 * a confident answer is never displaced by a speculative one.
 *
 * ### Two rules that are easy to get wrong
 *
 * **A bodyless declaration has no body hash.** Phase 2 made it the empty string
 * rather than the hash of nothing, precisely so tier 2 cannot fire on it — ten
 * of `defi/`'s thirty-nine functions are interface declarations, and hashing
 * them identically would make them all mutual rename candidates. Tier 2 skips
 * empty hashes.
 *
 * **A hash shared by more than one pair is not evidence.** Tier 2 only accepts
 * a bucket it can resolve unambiguously: same name (a move), then same scope (a
 * rename), then a lone remaining pair. Anything left over falls through to the
 * later tiers rather than being paired arbitrarily. §6 — an unmatched node is a
 * correct answer, and inventing a match to make the diff look tidy is the same
 * mistake as inventing an edge resolution.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { GraphNode } from '../graph/schema.js';

export type MatchTier = 'exact' | 'body' | 'signature' | 'fuzzy';

/** What the fuzzy tier weighed, kept so a UI can explain a probable rename. */
export interface FuzzyEvidence {
  /** Params, returns, visibility and mutability. */
  signature: number;
  /** Dice coefficient over name bigrams. */
  name: number;
  /** Jaccard overlap of callers and callees, in before-space. */
  neighbourhood: number;
}

export interface NodeMatch {
  before: string;
  after: string;
  tier: MatchTier;
  /** 1 for an exact id match; below it for every inferred tier. */
  confidence: number;
  evidence?: FuzzyEvidence;
}

export interface NodeMatching {
  /** Sorted by before id. */
  matches: NodeMatch[];
  byBefore: Map<string, NodeMatch>;
  byAfter: Map<string, NodeMatch>;
  /** Unmatched ids in the before graph, sorted. */
  removed: string[];
  /** Unmatched ids in the after graph, sorted. */
  added: string[];
}

export interface MatchOptions {
  /**
   * Minimum fuzzy score to report a probable rename. Default 0.55.
   *
   * Set from the `defi/` fixture pair: `Router.getAmountOut` →
   * `Router.amountOutFor` scores well above it, and the nearest wrong answer in
   * the same contract — `Router.sweep`, which happens to take the same three
   * parameter types — scores well below. §16 records the knob's own trigger.
   */
  fuzzyThreshold?: number;
}

export const DEFAULT_FUZZY_THRESHOLD = 0.55;

const TIER_CONFIDENCE: Record<Exclude<MatchTier, 'fuzzy'>, number> = {
  exact: 1,
  body: 0.95,
  signature: 0.8,
};

/** Bigram Dice coefficient, lowercased. 1 for identical, 0 for disjoint. */
export function nameSimilarity(a: string, b: string): number {
  const bigrams = (s: string): string[] => {
    const lower = s.toLowerCase();
    const out: string[] = [];
    for (let i = 0; i + 1 < lower.length; i += 1) out.push(lower.slice(i, i + 2));
    return out;
  };
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return 0;

  const pool = new Map<string, number>();
  for (const gram of left) pool.set(gram, (pool.get(gram) ?? 0) + 1);
  let shared = 0;
  for (const gram of right) {
    const seen = pool.get(gram) ?? 0;
    if (seen > 0) {
      shared += 1;
      pool.set(gram, seen - 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function typeList(params: readonly { type: string }[]): string {
  return params.map((param) => param.type).join(',');
}

/**
 * Signature agreement, weighted the way an auditor reads one: the parameters
 * carry half, the returns and the visibility/mutability pair a quarter each.
 */
function signatureSimilarity(before: GraphNode, after: GraphNode): number {
  if (before.kind !== 'Function' || after.kind !== 'Function') return 0;
  let score = 0;
  if (typeList(before.params) === typeList(after.params)) score += 0.5;
  if (typeList(before.returns) === typeList(after.returns)) score += 0.25;
  if (
    before.visibility === after.visibility &&
    before.stateMutability === after.stateMutability &&
    before.subkind === after.subkind
  ) {
    score += 0.25;
  }
  return score;
}

/** Neighbours over every edge kind except containment, which is not evidence. */
function neighbours(graph: AxiomapGraph, id: string): Set<string> {
  const out = new Set<string>();
  graph.forEachEdge(id, (_key, edge, source, target) => {
    if (edge.kind === 'declares') return;
    out.add(source === id ? target : source);
  });
  out.delete(id);
  return out;
}

function nodesOf(graph: AxiomapGraph): Map<string, GraphNode> {
  const out = new Map<string, GraphNode>();
  graph.forEachNode((id, node) => out.set(id, node));
  return out;
}

/**
 * Match the nodes of two graphs.
 *
 * Pure: neither graph is read for anything but attributes and edges, and
 * nothing is written back.
 */
export function matchNodes(
  before: AxiomapGraph,
  after: AxiomapGraph,
  options: MatchOptions = {},
): NodeMatching {
  const threshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  const beforeNodes = nodesOf(before);
  const afterNodes = nodesOf(after);

  const byBefore = new Map<string, NodeMatch>();
  const byAfter = new Map<string, NodeMatch>();

  const pair = (match: NodeMatch): void => {
    byBefore.set(match.before, match);
    byAfter.set(match.after, match);
  };

  // --- tier 1: exact id -------------------------------------------------
  //
  // The kind has to agree too. Ids are namespaced by declaration kind so a
  // collision should be impossible, but "should be impossible" is how a
  // recovered parse produces a function and a state variable with one id, and
  // the failure would be a diff comparing two unrelated declarations.
  for (const [id, node] of beforeNodes) {
    const other = afterNodes.get(id);
    if (other !== undefined && other.kind === node.kind) {
      pair({ before: id, after: id, tier: 'exact', confidence: TIER_CONFIDENCE.exact });
    }
  }

  const unmatchedBefore = (): string[] =>
    [...beforeNodes.keys()].filter((id) => !byBefore.has(id)).sort();
  const unmatchedAfter = (): string[] =>
    [...afterNodes.keys()].filter((id) => !byAfter.has(id)).sort();

  // --- tier 2: body hash, different id ----------------------------------
  const buckets = new Map<string, { before: string[]; after: string[] }>();
  const bucket = (hash: string): { before: string[]; after: string[] } => {
    let found = buckets.get(hash);
    if (found === undefined) {
      found = { before: [], after: [] };
      buckets.set(hash, found);
    }
    return found;
  };
  for (const id of unmatchedBefore()) {
    const node = beforeNodes.get(id);
    if (node?.kind === 'Function' && node.bodyHash !== '') bucket(node.bodyHash).before.push(id);
  }
  for (const id of unmatchedAfter()) {
    const node = afterNodes.get(id);
    if (node?.kind === 'Function' && node.bodyHash !== '') bucket(node.bodyHash).after.push(id);
  }

  for (const group of buckets.values()) {
    const left = group.before.filter((id) => !byBefore.has(id));
    const right = group.after.filter((id) => !byAfter.has(id));
    if (left.length === 0 || right.length === 0) continue;

    // Same name first (a move), then same scope (a rename), then a lone
    // remaining pair. A bucket that stays ambiguous after all three is left
    // alone for the later tiers rather than paired on ordering.
    const take = (key: (node: GraphNode) => string | null): void => {
      for (const beforeId of left) {
        if (byBefore.has(beforeId)) continue;
        const beforeNode = beforeNodes.get(beforeId);
        if (beforeNode === undefined) continue;
        const beforeKey = key(beforeNode);
        if (beforeKey === null) continue;
        const candidates = right.filter((afterId) => {
          if (byAfter.has(afterId)) return false;
          const afterNode = afterNodes.get(afterId);
          return afterNode !== undefined && key(afterNode) === beforeKey;
        });
        const only = candidates.length === 1 ? candidates[0] : undefined;
        if (only !== undefined) {
          pair({ before: beforeId, after: only, tier: 'body', confidence: TIER_CONFIDENCE.body });
        }
      }
    };
    take((node) => node.name);
    take((node) => node.scope);

    const restLeft = left.filter((id) => !byBefore.has(id));
    const restRight = right.filter((id) => !byAfter.has(id));
    const onlyLeft = restLeft.length === 1 ? restLeft[0] : undefined;
    const onlyRight = restRight.length === 1 ? restRight[0] : undefined;
    if (onlyLeft !== undefined && onlyRight !== undefined) {
      pair({
        before: onlyLeft,
        after: onlyRight,
        tier: 'body',
        confidence: TIER_CONFIDENCE.body,
      });
    }
  }

  /**
   * An after-graph scope in before-space. Contracts match at tier 1 in almost
   * every real diff, so by the time the later tiers run this is a lookup; when
   * a contract itself was renamed it is what keeps its members comparable.
   */
  const projectScope = (scope: string | null): string | null =>
    scope === null ? null : (byAfter.get(scope)?.before ?? scope);

  // --- tier 3: same container, same name, different signature -----------
  //
  // Unique on both sides or nothing: an overload set shares a container and a
  // name by definition, and picking one of `f(uint)` / `f(address)` to pair
  // with is a guess.
  const keyOf = (node: GraphNode, scope: string | null): string =>
    `${node.kind} ${scope ?? ''} ${node.name}`;

  const leftByKey = new Map<string, string[]>();
  const rightByKey = new Map<string, string[]>();
  for (const id of unmatchedBefore()) {
    const node = beforeNodes.get(id);
    if (node === undefined) continue;
    const key = keyOf(node, node.scope);
    leftByKey.set(key, [...(leftByKey.get(key) ?? []), id]);
  }
  for (const id of unmatchedAfter()) {
    const node = afterNodes.get(id);
    if (node === undefined) continue;
    const key = keyOf(node, projectScope(node.scope));
    rightByKey.set(key, [...(rightByKey.get(key) ?? []), id]);
  }
  for (const [key, left] of leftByKey) {
    const right = rightByKey.get(key);
    const beforeId = left.length === 1 ? left[0] : undefined;
    const afterId = right?.length === 1 ? right[0] : undefined;
    if (beforeId !== undefined && afterId !== undefined) {
      pair({
        before: beforeId,
        after: afterId,
        tier: 'signature',
        confidence: TIER_CONFIDENCE.signature,
      });
    }
  }

  // --- tier 4: fuzzy ----------------------------------------------------
  //
  // Functions only, and only within one container: a function that moved
  // *and* was rewritten is beyond what this can claim honestly, and §8 asks
  // for a confidence rather than an answer here.
  interface Candidate extends NodeMatch {
    score: number;
  }
  const candidates: Candidate[] = [];
  const leftFns = unmatchedBefore().filter((id) => beforeNodes.get(id)?.kind === 'Function');
  const rightFns = unmatchedAfter().filter((id) => afterNodes.get(id)?.kind === 'Function');

  const beforeNeighbours = new Map<string, Set<string>>();
  const afterNeighbours = new Map<string, Set<string>>();
  for (const id of leftFns) beforeNeighbours.set(id, neighbours(before, id));
  for (const id of rightFns) {
    // Projected into before-space so an already-matched neighbour counts as
    // the same neighbour on both sides.
    const projected = new Set<string>();
    for (const neighbour of neighbours(after, id)) {
      projected.add(byAfter.get(neighbour)?.before ?? neighbour);
    }
    afterNeighbours.set(id, projected);
  }

  for (const beforeId of leftFns) {
    const beforeNode = beforeNodes.get(beforeId);
    if (beforeNode === undefined) continue;
    for (const afterId of rightFns) {
      const afterNode = afterNodes.get(afterId);
      if (afterNode === undefined) continue;
      if (beforeNode.scope !== projectScope(afterNode.scope)) continue;

      const evidence: FuzzyEvidence = {
        signature: signatureSimilarity(beforeNode, afterNode),
        name: nameSimilarity(beforeNode.name, afterNode.name),
        neighbourhood: jaccard(
          beforeNeighbours.get(beforeId) ?? new Set(),
          afterNeighbours.get(afterId) ?? new Set(),
        ),
      };
      const score =
        0.4 * evidence.signature + 0.3 * evidence.name + 0.3 * evidence.neighbourhood;
      if (score < threshold) continue;
      candidates.push({
        before: beforeId,
        after: afterId,
        tier: 'fuzzy',
        confidence: Number(score.toFixed(4)),
        evidence,
        score,
      });
    }
  }

  // Greedy by descending score, ties broken by id so the result does not
  // depend on iteration order.
  candidates.sort(
    (a, b) =>
      b.score - a.score || a.before.localeCompare(b.before) || a.after.localeCompare(b.after),
  );
  for (const candidate of candidates) {
    if (byBefore.has(candidate.before) || byAfter.has(candidate.after)) continue;
    pair({
      before: candidate.before,
      after: candidate.after,
      tier: candidate.tier,
      confidence: candidate.confidence,
      ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
    });
  }

  const matches = [...byBefore.values()].sort(
    (a, b) => a.before.localeCompare(b.before) || a.after.localeCompare(b.after),
  );

  return { matches, byBefore, byAfter, removed: unmatchedBefore(), added: unmatchedAfter() };
}
