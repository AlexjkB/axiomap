/**
 * Narrowing a view to the functions worth looking at.
 *
 * §11 calls a view "a filter + layout + styling preset over one graph". Four of
 * the five draw functions, and on a real contract that is thirty boxes when the
 * question is usually about five of them: which entry points are `external`,
 * what can be reached from outside, what takes value.
 *
 * ### Why this is here and not in the engine
 *
 * `selectAggregatedView` already filters — by view, by focus, by directory —
 * and this could have been another request field. It is not, because it would
 * be the first filter whose answer the user changes several times a second
 * while looking at one graph, and a round trip per checkbox is a different
 * feel from a toggle. Everything it needs is on the drawn view already.
 *
 * The one thing that buys the engine is §9 rule 2's element cap, which counts
 * what the *engine* selected. A view refused for being over the cap is still
 * refused however this is set — the filter cannot rescue it. That is the honest
 * behaviour anyway: the cap is about what the tool will draw at all, and it
 * should not depend on a checkbox.
 *
 * ### Hiding, not fading
 *
 * A filtered function leaves the graph and ELK lays out what remains, so "only
 * the external and payable ones" is a small readable graph rather than the same
 * graph with fainter boxes. The cost is real and is why {@link hiddenNote}
 * exists: an `external` function that reaches storage through two `internal`
 * hops looks like it reaches nothing once the hops are hidden. The status bar
 * says how many functions are not being drawn, every time any are missing,
 * because a graph that is quietly answering a narrower question than the one
 * you think you asked is exactly what §4 refuses to ship elsewhere.
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
  // the structure the functions hang off; hiding a contract because it is not
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

export interface FilteredView {
  view: AggregatedView;
  /** How many function nodes the filter removed. */
  hidden: number;
}

/**
 * The view with unselected functions removed, and the edges that touched them.
 *
 * An edge whose endpoint is gone has to go: cytoscape would drop it anyway
 * rather than draw a line to nothing, and leaving it in the view would make
 * `elements` disagree with what is on screen.
 */
export function applyFilter(view: AggregatedView, traits: ReadonlySet<Trait>): FilteredView {
  if (traits.size === 0) return { view, hidden: 0 };

  const kept = view.nodes.filter((node) => matches(node, traits));
  const hidden = view.nodes.length - kept.length;
  if (hidden === 0) return { view, hidden: 0 };

  const drawn = new Set(kept.map((node) => node.id));
  const edges = view.edges.filter((edge) => drawn.has(edge.from) && drawn.has(edge.to));
  return {
    view: {
      ...view,
      nodes: kept,
      edges,
      // `elements` is what the status bar prints against the cap. It has to
      // describe what is drawn, or the count and the canvas disagree.
      elements: kept.length + edges.length,
    },
    hidden,
  };
}

/**
 * What the status bar says about what is missing.
 *
 * Always, whenever anything is hidden. This is the mitigation for the whole
 * design: a call chain through a hidden `internal` function reads as an
 * `external` function that reaches nothing, and the only defence against
 * mistaking a filtered graph for the whole one is that the tool keeps saying
 * so.
 */
export function hiddenNote(hidden: number, traits: ReadonlySet<Trait>): string {
  if (hidden === 0) return '';
  const shown = TRAITS.filter((trait) => traits.has(trait)).join(', ');
  return `${String(hidden)} function${hidden === 1 ? '' : 's'} hidden — showing ${shown} only`;
}
