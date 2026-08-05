/**
 * What a click does — as a pure function, because it is the part of a UI that
 * is easiest to get subtly wrong and hardest to see wrong.
 *
 * The whole of Phase 7b's navigation is drill-down: §11's "click node → reveal"
 * without the editor on the other end of it yet. A directory opens, a contract
 * opens into its members, a function opens into the call graph rooted on it.
 * That is deliberately the only way a focus gets set: §9 rule 4 requires the
 * call graph to have a focus node, and the alternatives for choosing one — a
 * search palette, an inspector, a list of every function in the project — are
 * either later in §11 or are the full graph by another name.
 *
 * `expand` belongs to the protocol map alone (it is the only clustered view, per
 * `aggregate`'s own default), so switching views drops it rather than carrying a
 * directory set into a graph that has no directories.
 */

import type { ViewName } from '@axiomap/core';

import { PRESETS } from './presets.js';

export interface NavState {
  view: ViewName;
  focus: string | null;
  up: number;
  down: number;
  /** Directory paths open in the protocol map (§9 rule 3's drill-down). */
  expand: readonly string[];
}

export type NavEvent =
  | { type: 'view'; view: ViewName }
  | { type: 'focus'; focus: string | null }
  | { type: 'hops'; up: number; down: number }
  | { type: 'pick'; kind: string; id: string; path?: string; expanded?: boolean };

export function initialState(defaults: { up: number; down: number }): NavState {
  return { view: 'protocol', focus: null, up: defaults.up, down: defaults.down, expand: [] };
}

function toggle(expand: readonly string[], path: string): string[] {
  return expand.includes(path)
    ? // Closing a directory closes what is inside it: leaving a descendant in
      // the set would reopen the parent on the next request, since `aggregate`
      // closes the expansion set under its ancestors.
      expand.filter((entry) => entry !== path && !entry.startsWith(`${path}/`))
    : [...expand, path];
}

export function reduce(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case 'view': {
      if (event.view === state.view) return state;
      // A focus that the new view cannot use is dropped rather than carried:
      // `selectView` would refuse a Function as the contract view's focus, and
      // an error is not what a user clicking a tab asked for.
      return { ...state, view: event.view, expand: [] };
    }
    case 'focus':
      return { ...state, focus: event.focus };
    case 'hops':
      return { ...state, up: Math.max(0, event.up), down: Math.max(0, event.down) };
    case 'pick': {
      if (event.kind === 'Cluster') {
        if (event.path === undefined) return state;
        return { ...state, expand: toggle(state.expand, event.path) };
      }
      // A node opens the view that is *about* it: a contract its members, a
      // function its call graph. Clicking one that already is the focus does
      // nothing rather than re-requesting the same view.
      if (event.kind === 'Contract') {
        if (state.view === 'contract' && state.focus === event.id) return state;
        return { ...state, view: 'contract', focus: event.id, expand: [] };
      }
      if (event.kind === 'Function') {
        if (state.view === 'call' && state.focus === event.id) return state;
        return { ...state, view: 'call', focus: event.id, expand: [] };
      }
      // Storage, events, errors, and the synthetic `Unresolved` placeholders
      // have no view of their own in this phase. Nothing is a better answer
      // than a view that cannot say anything about them.
      return state;
    }
  }
}

/** The request that state describes. Only the fields the view actually uses. */
export function toRequest(state: NavState): {
  view: ViewName;
  focus?: string;
  up?: number;
  down?: number;
  expand?: readonly string[];
} {
  const preset = PRESETS[state.view];
  return {
    view: state.view,
    ...(state.focus === null ? {} : { focus: state.focus }),
    ...(state.view === 'call' ? { up: state.up, down: state.down } : {}),
    ...(preset.clustered && state.expand.length > 0 ? { expand: state.expand } : {}),
  };
}

/** Can this view be requested as things stand? §9 rule 4 in one line. */
export function ready(state: NavState): boolean {
  return !PRESETS[state.view].needsFocus || state.focus !== null;
}
