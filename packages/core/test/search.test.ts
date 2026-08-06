/**
 * §11's `/` fuzzy search palette, as a query (Phase 7d).
 *
 * The property this suite exists for is the one in `search.ts`'s header: a
 * palette is the easiest possible way to break §9 rule 1, because "let the
 * client filter the node list" is both the obvious implementation and the full
 * graph wearing a different hat. So the cap is tested as a *contract* — a
 * caller cannot raise it, and a query broad enough to match everything comes
 * back with a count and a refusal to enumerate rather than with the node set.
 *
 * Expectations are hand-derived from `defi/`'s five files, the way Phases 4, 6,
 * 7a and 7c established.
 */

import { describe, expect, it } from 'vitest';

import { HARD_LIMIT, searchNodes } from '../src/index.js';
import { graphOf } from './graphs.js';

describe('searchNodes', () => {
  it('ranks an exact name above a longer one that contains it', async () => {
    const { graph } = await graphOf('defi');
    const results = searchNodes(graph, 'mint');

    const first = results.hits[0];
    expect(first).toBeDefined();
    expect(first?.name).toBe('mint');
    expect(first?.match).toBe('name');

    // `_mintShares` matches too, and is below rather than absent: a palette
    // offers, it does not choose (that is `resolveNodeRef`'s job and its rules).
    expect(results.hits.map((hit) => hit.name)).toContain('_mintShares');
  });

  it('pins a pasted full id to the top', async () => {
    const { graph } = await graphOf('defi');
    const id = 'src/Pair.sol:Pair.swap(uint256,uint256,address)';
    const results = searchNodes(graph, id);

    expect(results.hits[0]?.id).toBe(id);
    expect(results.hits[0]?.match).toBe('exact');
  });

  it('matches a subsequence, which is what makes it a palette', async () => {
    const { graph } = await graphOf('defi');
    // Nothing contains "prswp" as a substring; `Pair.swap` contains it in order.
    const results = searchNodes(graph, 'prswp');

    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.hits.every((hit) => hit.match === 'fuzzy')).toBe(true);
    expect(results.hits.map((hit) => hit.id)).toContain(
      'src/Pair.sol:Pair.swap(uint256,uint256,address)',
    );

    // Short queries still work: the spread bound has an additive floor for
    // exactly this, since `psw` over `Pair.swap` is seven characters of span
    // for three letters and a pure multiple would refuse it.
    expect(searchNodes(graph, 'psw').hits.map((hit) => hit.name)).toContain('swap');
  });

  /**
   * Found by looking at the palette in a browser rather than by a failing
   * assertion: with the fuzzy tier running over the whole id, `mint` returned
   * 23 rows on a nine-contract fixture — `sqrt`, `Sync`, `quote`,
   * `FEE_DENOMINATOR` — because any path deep enough contains any four letters
   * in some order. A palette where three quarters of the rows are noise is not
   * a palette.
   */
  it('does not match a name through the directory it happens to live in', async () => {
    const { graph } = await graphOf('defi');
    const names = searchNodes(graph, 'mint', { limit: HARD_LIMIT }).hits.map((hit) => hit.name);

    expect(names).toContain('mint');
    expect(names).toContain('_mintShares');
    for (const noise of ['sqrt', 'Sync', 'quote', 'FEE_DENOMINATOR', 'initialize']) {
      expect(names).not.toContain(noise);
    }
    // Nine contracts. Before the fix this was 23.
    expect(names.length).toBeLessThan(8);
  });

  it('still searches by directory, because that is a real question', async () => {
    const { graph } = await graphOf('defi');
    const results = searchNodes(graph, 'libraries/', { limit: HARD_LIMIT });

    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.hits.every((hit) => hit.file.includes('libraries/'))).toBe(true);
  });

  it('carries what a row needs to be drawn without a second request', async () => {
    const { graph } = await graphOf('defi');
    const hit = searchNodes(graph, 'getReserves').hits[0];

    expect(hit).toMatchObject({
      name: 'getReserves',
      kind: 'Function',
      file: 'src/Pair.sol',
      scope: 'src/Pair.sol:Pair',
    });
    expect(hit?.line).toBeGreaterThan(0);
  });

  /**
   * §9 rule 1 as an integer. A caller asking for more than the ceiling gets the
   * ceiling — the cap belongs to the query API, not to whichever transport or
   * UI is in front of it, because it has to hold over `postMessage` in Phase 8
   * as well as over HTTP now.
   */
  it('caps the result set at a limit a caller cannot raise', async () => {
    const { graph } = await graphOf('defi');
    const everything = searchNodes(graph, 'a', { limit: 10_000 });

    expect(everything.hits.length).toBeLessThanOrEqual(HARD_LIMIT);
    expect(everything.limit).toBe(HARD_LIMIT);
  });

  it('reports how many matched, so a broad query can say so', async () => {
    const { graph } = await graphOf('defi');
    const results = searchNodes(graph, 'a', { limit: 5 });

    expect(results.hits).toHaveLength(5);
    expect(results.total).toBeGreaterThan(5);
    expect(results.capped).toBe(true);
  });

  /**
   * An arbitrary slice of a protocol looks exactly like a ranked answer, and
   * there is no question it is the answer to.
   */
  it('answers an empty query with nothing rather than with a slice of the graph', async () => {
    const { graph } = await graphOf('defi');
    const results = searchNodes(graph, '   ');

    expect(results.hits).toEqual([]);
    expect(results.total).toBe(0);
    expect(results.capped).toBe(false);
  });

  /**
   * §10's synthetic placeholders are real nodes and a query this tool is proud
   * of, but they are not declarations. They stay out of the way until asked for
   * by the prefix their ids carry.
   */
  it('hides the synthetic placeholders unless the query asks for them', async () => {
    const { graph } = await graphOf('minimal');
    const kinds = (query: string): string[] =>
      searchNodes(graph, query, { limit: HARD_LIMIT }).hits.map((hit) => hit.kind);

    expect(kinds('call')).not.toContain('Unresolved');
    expect(kinds('?')).toContain('Unresolved');
  });

  it('honours a kind filter, as every other node reference does', async () => {
    const { graph } = await graphOf('defi');
    const results = searchNodes(graph, 'token', { kinds: ['StateVariable'] });

    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.hits.every((hit) => hit.kind === 'StateVariable')).toBe(true);
  });
});
