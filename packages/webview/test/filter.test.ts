/**
 * The function filter: what it keeps, what it drops, and what it says.
 *
 * Unit-tested rather than driven through a browser because it is a pure
 * function over a view — the browser test covers that the chips are wired to
 * it, which is the part a unit test cannot see.
 */

import { describe, expect, it } from 'vitest';

import type { AggregatedView } from '@axiomap/core';

import { fadedIds, fadedNote, filterable, matches, TRAITS } from '../src/ui/filter.js';

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

  it('fades nothing when nothing is ticked', () => {
    expect(fadedIds(view, set()).size).toBe(0);
    expect(fadedIds(null, set('external')).size).toBe(0);
  });

  /**
   * Union, not intersection: ticking a second box shows *more*, which is what a
   * list of checkboxes means everywhere else.
   */
  it('unions the ticked traits rather than intersecting them', () => {
    expect([...fadedIds(view, set('external'))]).toEqual([settle.id, owner.id, secret.id]);
    // Ticking a second box fades fewer, not more.
    expect([...fadedIds(view, set('external', 'public'))]).toEqual([settle.id, secret.id]);
  });

  it('matches payable across visibilities', () => {
    expect(matches(deposit, set('payable'))).toBe(true);
    expect(matches(owner, set('payable'))).toBe(false);
    // `deposit` is external *and* payable: either box shows it, and both
    // together must not show it twice or hide it.
    expect(fadedIds(view, set('payable')).has(deposit.id)).toBe(false);
  });

  it('never fades what is not a function', () => {
    for (const trait of TRAITS) expect(matches(total, set(trait))).toBe(true);
    expect(fadedIds(view, set('private')).has(total.id)).toBe(false);
  });

  /**
   * Nothing leaves the view. This is the whole difference from the version that
   * hid: the path `deposit → _settle → total` is still on screen and still
   * readable when only `external` is ticked, so the graph cannot imply that an
   * external function reaches nothing.
   */
  it('leaves the view itself alone', () => {
    expect(fadedIds(view, set('external')).size).toBe(3);
    expect(view.nodes).toHaveLength(5);
    expect(view.edges).toHaveLength(3);
  });

  it('says what is faded, and says nothing when nothing is', () => {
    expect(fadedNote(0, set('external'))).toBe('');
    expect(fadedNote(3, set('external'))).toBe('3 functions faded — highlighting external');
    // Singular, because "1 functions" is the kind of thing that makes a tool
    // look unfinished.
    expect(fadedNote(1, set('external', 'payable'))).toBe(
      '1 function faded — highlighting external, payable',
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
