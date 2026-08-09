/**
 * Narrowing a view to the functions worth looking at.
 *
 * §11 calls a view "a filter + layout + styling preset over one graph". Four of
 * the five draw functions, and on a real contract that is thirty boxes when the
 * question is usually about five of them: which entry points are `external`,
 * what can be reached from outside, what takes value.
 *
 * ### Faded, not removed
 *
 * This shipped once as a filter that hid what it excluded and re-laid-out the
 * rest, which makes a smaller graph and a worse one. Two reasons it went:
 *
 * **The graph stopped being true.** An `external` function that reaches storage
 * through two `internal` hops reads as reaching nothing once the hops are gone,
 * and a tool whose §4 argument is never pretending to more certainty than it
 * has should not answer a narrower question than the one it appears to. Fading
 * keeps every edge and every path on screen.
 *
 * **A filter is not a navigation.** Hiding changed the element set, so ELK ran
 * again and the graph rearranged itself under the pointer on every tick of a
 * checkbox. Fading is a class on the nodes that are already placed: instant,
 * and the arrangement and the camera do not move at all.
 *
 * ### Why this is here and not in the engine
 *
 * `selectAggregatedView` already filters — by view, by focus, by directory —
 * and this could have been another request field. It is not, because it would
 * be the first filter whose answer the user changes several times a second
 * while looking at one graph, and a round trip per checkbox is a different feel
 * from a toggle. Everything it needs is on the drawn view already, and now that
 * nothing is removed there is no element count for the engine to disagree with.
 */

import type { AggregatedView, DisplayNode } from '@axiomap/core';

/**
 * The traits a function can be filtered on.
 *
 * Four visibilities and one mutability, which is the set an auditor names out
 * loud. `default` visibility — a pre-0.5 function with none written — is not
 * offered: it does not appear in any Solidity anyone is auditing today, and a
 * checkbox nobody can explain is worse than one fewer.
 */
export const TRAITS = ['external', 'public', 'internal', 'private', 'payable'] as const;

export type Trait = (typeof TRAITS)[number];

/**
 * A function matches when it has **any** selected trait, and an empty selection
 * means everything.
 *
 * Union rather than intersection, because that is what the control looks like:
 * five checkboxes, tick the ones you want to see. Intersection would make
 * `external` + `payable` mean "payable external functions", which is a useful
 * question but not the one a list of checkboxes asks — and it makes ticking a
 * second box shrink the graph, which no checklist anywhere does.
 */
export function matches(node: DisplayNode, traits: ReadonlySet<Trait>): boolean {
  if (traits.size === 0) return true;
  // Only functions are filtered. Contracts, storage, events and clusters are
  // the structure the functions hang off; fading a contract because it is not
  // `payable` would be a category error.
  if (node.type !== 'node' || node.node.kind !== 'Function') return true;
  const fn = node.node;
  if (traits.has('payable') && fn.stateMutability === 'payable') return true;
  return TRAITS.some(
    (trait) => trait !== 'payable' && traits.has(trait) && fn.visibility === trait,
  );
}

/** Whether this view draws anything the filter could act on. */
export function filterable(view: AggregatedView | null): boolean {
  return (
    view !== null &&
    view.nodes.some((node) => node.type === 'node' && node.node.kind === 'Function')
  );
}

/**
 * The ids to fade: every drawn function the selection does not name.
 *
 * Ids rather than a filtered view, because nothing is being removed — the
 * canvas takes this set and puts a class on those nodes, leaving the elements,
 * the layout and the viewport exactly as they were.
 */
export function fadedIds(view: AggregatedView | null, traits: ReadonlySet<Trait>): Set<string> {
  const faded = new Set<string>();
  if (view === null || traits.size === 0) return faded;
  for (const node of view.nodes) if (!matches(node, traits)) faded.add(node.id);
  return faded;
}

/**
 * What the status bar says about what is faded.
 *
 * Softer than the note this replaced, and deliberately: nothing is missing any
 * more, so the sentence reports a state of the view rather than warning about
 * an omission. It is still there whenever anything is faded, because a graph
 * that is quietly answering a narrower question than the one you think you
 * asked is what §4 refuses to ship elsewhere.
 */
export function fadedNote(faded: number, traits: ReadonlySet<Trait>): string {
  if (faded === 0) return '';
  const shown = TRAITS.filter((trait) => traits.has(trait)).join(', ');
  return `${String(faded)} function${faded === 1 ? '' : 's'} faded — highlighting ${shown}`;
}
