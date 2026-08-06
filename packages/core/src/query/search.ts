/**
 * §11's `/` fuzzy search palette, as a query.
 *
 * ### The thing this must not become
 *
 * §9 rule 1: the webview never receives the full graph. A search palette is the
 * most natural way in the world to break that — ship every node id to the
 * client once, filter in the browser, and the UI is now holding the node set of
 * a 300-contract protocol. Phase 7b's navigation note says the same thing from
 * the other side: a list of every function *is* the full graph wearing a
 * different hat.
 *
 * So the match runs on the host and the answer is **capped there**, not
 * capped by whatever the UI decides to render. `HARD_LIMIT` is the ceiling a
 * caller cannot raise. `total` reports how many nodes actually matched, so a
 * query that is too broad can say "412 matches, narrow it" rather than
 * pretending the twenty it returned are the answer — the same shape as §9 rule
 * 2's render cap, which is a refusal with the way out rather than a silent
 * truncation.
 *
 * ### Generous here, narrow in `resolveNodeRef`
 *
 * `refs.ts` matches a reference the user *typed as an identifier* and refuses
 * to guess between candidates, because its answer selects a node and being
 * silently wrong misleads an auditor (§6). A palette has the opposite
 * obligation: it never picks, it offers, and the user reads the list before
 * clicking. That is what makes subsequence matching safe here and wrong there.
 *
 * `resolveNodeRef` is still consulted first: a reference that resolves exactly
 * is pinned to the top, so pasting a full id from `axiomap query --json` lands
 * on that node rather than on whatever sorted best.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { GraphNode, NodeKind } from '../graph/schema.js';
import { resolveNodeRef } from './refs.js';

/** What a caller gets if it asks for nothing in particular. */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * The most this will ever return, whatever a caller asks for.
 *
 * Not a performance number — it is §9 rule 1 expressed as an integer. The
 * palette is a way to reach one node, and a client that could request ten
 * thousand results would have found a route to the node set the rule exists to
 * keep on this side.
 */
export const HARD_LIMIT = 50;

export interface SearchOptions {
  limit?: number;
  /** Restrict to these kinds, the way `NodeRefOptions` does. */
  kinds?: readonly NodeKind[];
}

export interface SearchHit {
  id: string;
  name: string;
  kind: NodeKind;
  /** Containing contract id, or null at file scope — the palette's second line. */
  scope: string | null;
  file: string;
  line: number;
  /** Which tier matched, so a UI can explain the ordering rather than assert it. */
  match: 'exact' | 'name' | 'prefix' | 'contains' | 'path' | 'fuzzy';
}

export interface SearchResults {
  query: string;
  hits: SearchHit[];
  /** How many nodes matched, which may be far more than were returned. */
  total: number;
  /** True when `total` exceeded the cap and the list is the head of it. */
  capped: boolean;
  /** The cap actually applied, so a UI can name it. */
  limit: number;
}

/** `src/Vault.sol:Vault.deposit(uint256)` → `deposit`. */
function bareName(node: GraphNode): string {
  return node.name;
}

/**
 * Is `needle` a subsequence of `haystack`, and a *tight* one?
 *
 * The fuzzy tier — `prswp` finds `Pair.swap`, which is the whole reason a
 * palette beats Ctrl-F. Returns the span the match covers, or `null`.
 *
 * Leftmost-greedy: each letter takes its first available position. That makes
 * the answer deterministic and the span an honest measure of how spread out the
 * match is, which is what {@link SPREAD} then bounds.
 */
function subsequenceSpan(haystack: string, needle: string): number | null {
  let at = 0;
  let start = -1;
  for (const character of needle) {
    at = haystack.indexOf(character, at);
    if (at === -1) return null;
    if (start === -1) start = at;
    at += 1;
  }
  return at - start;
}

/**
 * How far apart a fuzzy match's letters may be, as a multiple of the query.
 *
 * Without this, `mint` matches `AmmMath.FEE_DENOMINATOR` — the four letters are
 * genuinely there in order, spread across eighteen characters. A subsequence
 * over a long enough string is nearly always satisfiable, so the unbounded tier
 * matched most of a nine-contract fixture and ranked the noise above half the
 * real answers.
 *
 * The rule a user can predict from this is "the letters have to be near each
 * other", which is what people mean by fuzzy matching anyway. The additive
 * floor keeps short queries usable: `psw` finding `Pair.swap` spans seven
 * characters for three letters, and a pure multiple would refuse it.
 */
const SPREAD = 2.5;
const SPREAD_FLOOR = 4;

function tightSubsequence(haystack: string, needle: string): boolean {
  const span = subsequenceSpan(haystack, needle);
  if (span === null) return false;
  return span <= Math.max(needle.length + SPREAD_FLOOR, needle.length * SPREAD);
}

const TIERS: SearchHit['match'][] = ['exact', 'name', 'prefix', 'contains', 'path', 'fuzzy'];

/**
 * `src/Pair.sol:Pair.swap(uint256,...)` → `pair.swap`.
 *
 * The scope and the member, without the directory and without the parameter
 * list — which is what a person means when they say they are looking for
 * `Pair.swap`.
 */
function qualified(id: string): string {
  return id
    .slice(id.lastIndexOf(':') + 1)
    .replace(/\(.*$/, '')
    .toLowerCase();
}

function tierOf(node: GraphNode, needle: string): SearchHit['match'] | null {
  const name = bareName(node).toLowerCase();
  const id = node.id.toLowerCase();
  if (name === needle) return 'name';
  if (name.startsWith(needle)) return 'prefix';
  if (name.includes(needle)) return 'contains';
  // Substring over the whole id, so a directory is searchable: `libraries/`
  // finds what is in it. Exact substring, so it stays precise.
  if (id.includes(needle)) return 'path';
  /*
   * The fuzzy tier runs over the **qualified name**, not over the whole id.
   *
   * Running it over the id was the first version and it was measured in a
   * browser: `mint` returned 23 matches on the nine-contract `defi/` fixture,
   * among them `sqrt`, `Sync`, `quote` and `FEE_DENOMINATOR` — because
   * `src/libraries/AmmMath.sol:AmmMath.sqrt(uint256)` does contain m, i, n, t
   * in that order, as does almost any path deep enough. A subsequence over a
   * long string is nearly always satisfiable, so the tier matched everything
   * and ranked the noise above half the real answers.
   *
   * Over `pair.swap` it does the job it exists for — `prswp` finds
   * `Pair.swap` — and stops matching things that merely share letters with a
   * directory name. {@link SPREAD} is the other half of the same fix.
   */
  if (tightSubsequence(qualified(node.id), needle)) return 'fuzzy';
  return null;
}

/**
 * §11's palette, ranked and capped.
 *
 * An empty query returns nothing rather than the first twenty nodes in id
 * order: an arbitrary slice of a protocol looks like a ranked answer, and there
 * is no question it is the answer to.
 *
 * The synthetic `Unresolved` placeholders (§10) are excluded unless the query
 * starts with `?`, which is the prefix their ids carry. They are real graph
 * nodes and "show me every unresolved external call" is a query this tool is
 * proud of — but they are not declarations, and forty `?call` rows between a
 * user and the function they are looking for is a palette that has stopped
 * being useful.
 */
export function searchNodes(
  graph: AxiomapGraph,
  query: string,
  options: SearchOptions = {},
): SearchResults {
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT), HARD_LIMIT);
  const trimmed = query.trim();

  if (trimmed === '') {
    return { query: trimmed, hits: [], total: 0, capped: false, limit };
  }

  const needle = trimmed.toLowerCase();
  const kinds = options.kinds === undefined ? null : new Set<NodeKind>(options.kinds);
  const wantsSynthetic = trimmed.startsWith('?');

  // An exact reference wins outright, so a pasted id lands where it names.
  const exact = resolveNodeRef(graph, trimmed, options.kinds === undefined ? {} : { kinds: options.kinds });
  const pinned = exact.found ? exact.id : null;

  const matched: { node: GraphNode; tier: number }[] = [];
  graph.forEachNode((_id, node) => {
    if (kinds !== null && !kinds.has(node.kind)) return;
    if (node.kind === 'Unresolved' && !wantsSynthetic) return;
    if (node.id === pinned) {
      matched.push({ node, tier: 0 });
      return;
    }
    const tier = tierOf(node, needle);
    if (tier === null) return;
    matched.push({ node, tier: TIERS.indexOf(tier) });
  });

  matched.sort(
    (a, b) =>
      a.tier - b.tier ||
      // Within a tier, the shorter id is the more specific match: `Vault.mint`
      // before `VaultFactoryMock.mintForTesting`.
      a.node.id.length - b.node.id.length ||
      a.node.id.localeCompare(b.node.id),
  );

  const hits = matched.slice(0, limit).map(({ node, tier }) => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    scope: node.scope,
    file: node.file,
    line: node.src.line,
    match: TIERS[tier] ?? 'fuzzy',
  }));

  return {
    query: trimmed,
    hits,
    total: matched.length,
    capped: matched.length > hits.length,
    limit,
  };
}
