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
  /**
   * Is the engine still choosing what to open?
   *
   * 7a's auto-expansion opens directories breadth-first for as long as the
   * result fits under the cap, so a fresh protocol map has clusters open that
   * are in nobody's `expand` set. True until the user touches a cluster, after
   * which `expand` is the whole truth and the engine is told to stop deciding.
   */
  autoExpand: boolean;
}

export type NavEvent =
  | { type: 'view'; view: ViewName }
  | { type: 'focus'; focus: string | null }
  | { type: 'hops'; up: number; down: number }
  | {
      type: 'pick';
      kind: string;
      id: string;
      path?: string;
      /** Whether the clicked cluster is currently drawn open. */
      expanded?: boolean;
      /** Every cluster currently drawn open, from the view (`AggregatedView.expanded`). */
      open?: readonly string[];
    };

export function initialState(defaults: { up: number; down: number }): NavState {
  return {
    view: 'protocol',
    focus: null,
    up: defaults.up,
    down: defaults.down,
    expand: [],
    autoExpand: true,
  };
}

function close(expand: readonly string[], path: string): string[] {
  // Closing a directory closes what is inside it: leaving a descendant in the
  // set would reopen the parent on the next request, since `aggregate` closes
  // the expansion set under its ancestors.
  return expand.filter((entry) => entry !== path && !entry.startsWith(`${path}/`));
}

export function reduce(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case 'view': {
      if (event.view === state.view) return state;
      // The focus is carried across the switch, deliberately. It used to be
      // the case that the contract view refused a Function and this comment
      // claimed the focus was dropped to avoid that — neither was true: the
      // code always carried it, and the refusal reached the user as an error
      // for clicking a tab. `contractView` now opens a member's own contract,
      // so carrying it is what makes the two views agree about where you are.
      return { ...state, view: event.view, expand: [], autoExpand: true };
    }
    case 'focus': {
      /*
       * Clearing the focus on a view that requires one leaves the user looking
       * at §9 rule 4's "this view needs a focus node" notice instead of a
       * graph — a dead end reached by pressing a button labelled `clear`.
       *
       * The protocol map is where a focus comes from in the first place (the
       * whole of navigation is drill-down, per this file's header), and it is
       * one of the three views that never needs one. So clearing goes back to
       * it, and behaves exactly as clicking its tab does — including dropping
       * `expand`, since the directories that were open belong to a map the
       * user has not been looking at.
       *
       * Views that take an *optional* focus are left alone: clearing it on the
       * state-access map widens it from one contract to the whole project,
       * which is a useful thing to have asked for rather than a dead end.
       */
      if (event.focus === null && PRESETS[state.view].needsFocus) {
        return { ...state, focus: null, view: 'protocol', expand: [], autoExpand: true };
      }
      return { ...state, focus: event.focus };
    }
    case 'hops':
      return { ...state, up: Math.max(0, event.up), down: Math.max(0, event.down) };
    case 'pick': {
      if (event.kind === 'Cluster') {
        if (event.path === undefined) return state;
        /*
         * Toggle what is *drawn*, not what is in the explicit set.
         *
         * These differ, and the difference was a real defect found by opening a
         * 298-contract project: 7a's auto-expansion opens directories the user
         * never asked for, so `src` is on screen wide open and absent from
         * `expand`. Toggling set membership therefore *added* it — no visible
         * change — and only a second click closed it. A directory you cannot
         * shut is the drill-down half of §9 rule 3 not working.
         *
         * `expanded` comes from the element the click landed on, and `open` is
         * the view's own list, so the first click takes over from the engine
         * with the state that is actually on screen.
         */
        const base = state.autoExpand ? (event.open ?? state.expand) : state.expand;
        const expand =
          event.expanded === true ? close(base, event.path) : [...base, event.path];
        // From here the UI owns the expansion set: leaving auto-expansion on
        // would let the engine re-open the directory that was just closed.
        return { ...state, expand, autoExpand: false };
      }
      // A node opens the view that is *about* it: a contract its members, a
      // function its call graph. Clicking one that already is the focus does
      // nothing rather than re-requesting the same view.
      if (event.kind === 'Contract') {
        if (state.view === 'contract' && state.focus === event.id) return state;
        return { ...state, view: 'contract', focus: event.id, expand: [], autoExpand: true };
      }
      if (event.kind === 'Function') {
        if (state.view === 'call' && state.focus === event.id) return state;
        return { ...state, view: 'call', focus: event.id, expand: [], autoExpand: true };
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
  autoExpand?: boolean;
} {
  const preset = PRESETS[state.view];
  return {
    view: state.view,
    ...(state.focus === null ? {} : { focus: state.focus }),
    ...(state.view === 'call' ? { up: state.up, down: state.down } : {}),
    ...(preset.clustered && state.expand.length > 0 ? { expand: state.expand } : {}),
    // Sent only once the user has taken over, so an untouched map still gets
    // 7a's "expand as far as it fits" and the request stays the short one.
    ...(preset.clustered && !state.autoExpand ? { autoExpand: false } : {}),
  };
}

/** Can this view be requested as things stand? §9 rule 4 in one line. */
export function ready(state: NavState): boolean {
  return !PRESETS[state.view].needsFocus || state.focus !== null;
}
