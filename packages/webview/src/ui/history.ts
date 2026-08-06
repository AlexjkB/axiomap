/**
 * §11: "Breadcrumb + back/forward history. Auditors get lost; give them undo."
 *
 * The navigation reducer in `navigation.ts` is a pure function from one
 * `NavState` to the next, and this wraps it in a trail of those states. Keeping
 * the two separate is deliberate: what a click *means* and where you have
 * *been* are different questions, and the first is the one that was hard to get
 * right (Phase 7b's note on why drill-down is the only way a focus gets set).
 *
 * ### The breadcrumb is the trail, not a containment path
 *
 * There are two things a breadcrumb can be. One is where you are in a hierarchy
 * — `src › Pair › swap` — and the other is how you got here. §11 asks for this
 * one: it names the breadcrumb and back/forward in the same breath and gives
 * the reason as "auditors get lost", which is a statement about a path taken
 * rather than about a containment tree. A containment path would also be a
 * second thing to be wrong about, since the webview does not hold the graph
 * and would have to ask the host for each ancestor.
 *
 * So the breadcrumb is the entries of this history, clickable, and the current
 * one is marked. Back and forward move the index within it, which is why they
 * agree with the breadcrumb by construction rather than by being kept in step.
 *
 * ### Hop changes replace rather than push
 *
 * §9 rule 4's up/down steppers change what the call graph draws, so they are
 * navigation in the sense that matters to the renderer. They are not a *place*:
 * nudging `down` from 3 to 6 one click at a time would otherwise bury the
 * contract you came from under three identical-looking entries, which is the
 * failure mode this exists to prevent. They amend the current entry instead.
 */

import type { NavEvent, NavState } from './navigation.js';
import { reduce } from './navigation.js';

/**
 * How many places are remembered.
 *
 * A bound rather than a tuning knob: this is a long-lived panel in a tool
 * somebody leaves open for an afternoon, and an unbounded array of states is a
 * leak that only shows up in the session where it matters.
 */
export const HISTORY_LIMIT = 50;

export interface HistoryState {
  /** Oldest first. Never empty. */
  entries: readonly NavState[];
  /** Which entry is current. `entries.length - 1` unless you have gone back. */
  index: number;
}

export type HistoryEvent = NavEvent | { type: 'back' } | { type: 'forward' } | { type: 'jump'; index: number };

export function initialHistory(state: NavState): HistoryState {
  return { entries: [state], index: 0 };
}

/** The state the UI should be rendering. */
export function current(history: HistoryState): NavState {
  // The clamp is not defensive noise: `index` is arithmetic over an array that
  // gets truncated, and a breadcrumb pointing past the end would render an
  // empty view rather than throwing anywhere a test would see it.
  const at = Math.min(Math.max(history.index, 0), history.entries.length - 1);
  return history.entries[at] as NavState;
}

export function canGoBack(history: HistoryState): boolean {
  return history.index > 0;
}

export function canGoForward(history: HistoryState): boolean {
  return history.index < history.entries.length - 1;
}

/**
 * Two states that describe the same *place*, differing only in how far the call
 * graph is walked. See the header for why this is not a history entry.
 */
function samePlace(a: NavState, b: NavState): boolean {
  return a.view === b.view && a.focus === b.focus && a.expand.join() === b.expand.join();
}

export function reduceHistory(history: HistoryState, event: HistoryEvent): HistoryState {
  switch (event.type) {
    case 'back':
      return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
    case 'forward':
      return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
    case 'jump': {
      if (event.index < 0 || event.index >= history.entries.length) return history;
      return { ...history, index: event.index };
    }
    default: {
      const from = current(history);
      const next = reduce(from, event);
      // `reduce` returns the same object when a click changes nothing — clicking
      // the node you are already focused on, opening a view you are already in.
      // That is not a place you have been to twice.
      if (next === from) return history;

      // Going back and then somewhere new abandons the forward entries, the way
      // every back/forward stack in every browser does. Keeping them would make
      // "forward" mean a branch the user cannot see.
      const kept = history.entries.slice(0, history.index + 1);

      if (samePlace(from, next)) {
        const amended = [...kept.slice(0, -1), next];
        return { entries: amended, index: amended.length - 1 };
      }

      const entries = [...kept, next];
      const trimmed = entries.length > HISTORY_LIMIT ? entries.slice(entries.length - HISTORY_LIMIT) : entries;
      return { entries: trimmed, index: trimmed.length - 1 };
    }
  }
}

/**
 * The last segment of a node id, for a breadcrumb label.
 *
 * `src/Pair.sol:Pair.swap(uint256,uint256,address)` → `swap`. Core has this
 * logic in `query/refs.ts` and this package may not import it (§5: types only),
 * so it is written again — deliberately as *display* code, which is why it may
 * be approximate where `refs.ts` may not: the worst case here is a crumb that
 * reads oddly, and the worst case there is an auditor told about the wrong
 * function.
 */
export function shortName(id: string): string {
  const afterColon = id.slice(id.lastIndexOf(':') + 1);
  const withoutParams = afterColon.replace(/\(.*$/, '');
  const cut = Math.max(withoutParams.lastIndexOf('.'), withoutParams.lastIndexOf('#'));
  return cut === -1 ? withoutParams : withoutParams.slice(cut + 1);
}
