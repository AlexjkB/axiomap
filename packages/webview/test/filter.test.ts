/**
 * The function filter: what it keeps, what it drops, and what it says.
 *
 * Unit-tested rather than driven through a browser because it is a pure
 * function over a view — the browser test covers that the chips are wired to
 * it, which is the part a unit test cannot see.
 */

import { describe, expect, it } from 'vitest';

import type { AggregatedView } from '@axiomap/core';

import { applyFilter, filterable, hiddenNote, matches, TRAITS } from '../src/ui/filter.js';

function fn(
  name: string,
  visibility: string,
  stateMutability = 'nonpayable',
): AggregatedView['nodes'][number] {
  return {
    type: 'node',
    id: `src/V.sol:V.${name}()`,
    node: {
      kind: 'Function',
      id: `src/V.sol:V.${name}()`,
      name,
      visibility,
      stateMutability,
    },
  } as unknown as AggregatedView['nodes'][number];
}

function storage(name: string): AggregatedView['nodes'][number] {
  return {
    type: 'node',
    id: `src/V.sol:V.${name}`,
    node: { kind: 'StateVariable', id: `src/V.sol:V.${name}`, name },
  } as unknown as AggregatedView['nodes'][number];
}

function edge(from: string, to: string): AggregatedView['edges'][number] {
  return { type: 'edge', id: `${from}->${to}`, from, to } as unknown as
    AggregatedView['edges'][number];
}

const deposit = fn('deposit', 'external', 'payable');
const settle = fn('_settle', 'internal');
const owner = fn('owner', 'public', 'view');
const secret = fn('_secret', 'private');
const total = storage('total');

const view = {
  view: 'contract',
  nodes: [deposit, settle, owner, secret, total],
  edges: [edge(deposit.id, settle.id), edge(settle.id, total.id), edge(owner.id, total.id)],
  elements: 8,
  cap: 1500,
  expanded: [],
  collapsed: [],
  note: 'a contract',
} as unknown as AggregatedView;

const set = (...traits: string[]): ReadonlySet<never> =>
  new Set(traits) as unknown as ReadonlySet<never>;

describe('the function filter', () => {
  it('offers the five traits an auditor names, and not `default`', () => {
    expect([...TRAITS]).toEqual(['external', 'public', 'internal', 'private', 'payable']);
  });

  it('keeps everything when nothing is ticked', () => {
    const result = applyFilter(view, set());
    expect(result.hidden).toBe(0);
    // The same object, so nothing downstream re-renders for a filter that is
    // not filtering.
    expect(result.view).toBe(view);
  });

  /**
   * Union, not intersection: ticking a second box shows *more*, which is what a
   * list of checkboxes means everywhere else.
   */
  it('unions the ticked traits rather than intersecting them', () => {
    const external = applyFilter(view, set('external'));
    expect(external.view.nodes.map((node) => node.id)).toEqual([deposit.id, total.id]);

    const both = applyFilter(view, set('external', 'public'));
    expect(both.view.nodes.map((node) => node.id)).toEqual([deposit.id, owner.id, total.id]);
  });

  it('matches payable across visibilities', () => {
    expect(matches(deposit, set('payable'))).toBe(true);
    expect(matches(owner, set('payable'))).toBe(false);
    // `deposit` is external *and* payable: either box shows it, and both
    // together must not show it twice or hide it.
    expect(applyFilter(view, set('payable')).view.nodes.map((node) => node.id)).toEqual([
      deposit.id,
      total.id,
    ]);
  });

  it('never filters what is not a function', () => {
    for (const trait of TRAITS) expect(matches(total, set(trait))).toBe(true);
    expect(applyFilter(view, set('private')).view.nodes).toContain(total);
  });

  /**
   * An edge to a node that is gone would be a line to nothing. Dropping it in
   * the view keeps `elements` — the number the status bar prints — describing
   * what is actually drawn.
   */
  it('drops the edges that touched a hidden function, and recounts', () => {
    const result = applyFilter(view, set('external'));
    expect(result.view.edges).toEqual([]);
    expect(result.hidden).toBe(3);
    expect(result.view.elements).toBe(2);

    /*
     * Both surviving edges, including `_settle → total`: storage is never
     * filtered, so an edge only goes when the *function* on one end does.
     */
    const withInternal = applyFilter(view, set('external', 'internal'));
    expect(withInternal.view.edges.map((each) => each.id)).toEqual([
      `${deposit.id}->${settle.id}`,
      `${settle.id}->${total.id}`,
    ]);
  });

  it('says what is missing, and says nothing when nothing is', () => {
    expect(hiddenNote(0, set('external'))).toBe('');
    expect(hiddenNote(3, set('external'))).toBe('3 functions hidden — showing external only');
    // Singular, because "1 functions" is the kind of thing that makes a tool
    // look unfinished.
    expect(hiddenNote(1, set('external', 'payable'))).toBe(
      '1 function hidden — showing external, payable only',
    );
  });

  it('is offered only where functions are drawn', () => {
    expect(filterable(view)).toBe(true);
    expect(filterable(null)).toBe(false);
    expect(
      filterable({ ...view, nodes: [total] } as unknown as AggregatedView),
    ).toBe(false);
  });
});
