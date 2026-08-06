/**
 * §11's back/forward history (Phase 7d).
 *
 * `navigation.test.ts` covers what a click *means*; this covers where you have
 * been. They are separate modules for that reason, and the property worth
 * asserting here is that the history is a wrapper and not a second navigation
 * reducer: every entry in it came out of `reduce`, so a rule about what a click
 * does — §9 rule 4's focus requirement, the drill-down-only rule — cannot be
 * broken by going back to a state that was never reachable forwards.
 */

import { describe, expect, it } from 'vitest';

import { crumbLabel } from '../src/ui/Breadcrumb.js';
import {
  canGoBack,
  canGoForward,
  current,
  HISTORY_LIMIT,
  initialHistory,
  reduceHistory,
  shortName,
} from '../src/ui/history.js';
import { initialState } from '../src/ui/navigation.js';

const start = initialState({ up: 2, down: 3 });
const PAIR = 'src/Pair.sol:Pair';
const SWAP = 'src/Pair.sol:Pair.swap(uint256,uint256,address)';

function drillDown(): ReturnType<typeof initialHistory> {
  let history = initialHistory(start);
  history = reduceHistory(history, { type: 'pick', kind: 'Contract', id: PAIR });
  history = reduceHistory(history, { type: 'pick', kind: 'Function', id: SWAP });
  return history;
}

describe('history', () => {
  it('records a place per navigation and nothing at the start but where you are', () => {
    expect(initialHistory(start).entries).toHaveLength(1);
    expect(canGoBack(initialHistory(start))).toBe(false);
    expect(canGoForward(initialHistory(start))).toBe(false);

    const history = drillDown();
    expect(history.entries.map((entry) => entry.view)).toEqual(['protocol', 'contract', 'call']);
    expect(current(history).focus).toBe(SWAP);
  });

  it('goes back and forward over the same trail', () => {
    let history = drillDown();

    history = reduceHistory(history, { type: 'back' });
    expect(current(history).view).toBe('contract');
    expect(current(history).focus).toBe(PAIR);
    expect(canGoForward(history)).toBe(true);

    history = reduceHistory(history, { type: 'back' });
    expect(current(history).view).toBe('protocol');
    expect(canGoBack(history)).toBe(false);
    // Refused rather than clamped into a wrong state.
    expect(reduceHistory(history, { type: 'back' })).toBe(history);

    history = reduceHistory(history, { type: 'forward' });
    expect(current(history).view).toBe('contract');
  });

  it('jumps to any crumb, which is what the breadcrumb clicks do', () => {
    const history = reduceHistory(drillDown(), { type: 'jump', index: 0 });
    expect(current(history).view).toBe('protocol');
    // Out of range is refused, not clamped: a crumb that is not there is a bug
    // in the caller, and silently showing a different place hides it.
    expect(reduceHistory(history, { type: 'jump', index: 9 })).toBe(history);
    expect(reduceHistory(history, { type: 'jump', index: -1 })).toBe(history);
  });

  /**
   * The rule every back/forward stack has: going back and then somewhere new
   * abandons the forward entries. Keeping them would make "forward" mean a
   * branch the user cannot see.
   */
  it('drops the forward entries when you go back and then elsewhere', () => {
    let history = reduceHistory(drillDown(), { type: 'back' });
    expect(canGoForward(history)).toBe(true);

    history = reduceHistory(history, { type: 'view', view: 'inheritance' });
    expect(canGoForward(history)).toBe(false);
    expect(history.entries.map((entry) => entry.view)).toEqual([
      'protocol',
      'contract',
      'inheritance',
    ]);
  });

  it('does not record a click that changed nothing', () => {
    const history = drillDown();
    // Clicking the function you are already focused on. `reduce` returns the
    // same object, and that is not a place you have been to twice.
    const again = reduceHistory(history, { type: 'pick', kind: 'Function', id: SWAP });
    expect(again).toBe(history);
  });

  /**
   * Hop limits change what the call graph draws but not *where you are*. One
   * entry per click of a stepper would bury the contract you came from under
   * three identical-looking crumbs.
   */
  it('amends the current entry when only the hop limits change', () => {
    let history = drillDown();
    const before = history.entries.length;

    history = reduceHistory(history, { type: 'hops', up: 2, down: 4 });
    history = reduceHistory(history, { type: 'hops', up: 2, down: 5 });

    expect(history.entries).toHaveLength(before);
    expect(current(history).down).toBe(5);
    // And going back still lands on the contract, not on a previous hop count.
    expect(current(reduceHistory(history, { type: 'back' })).view).toBe('contract');
  });

  it('is bounded, because this panel stays open for an afternoon', () => {
    let history = initialHistory(start);
    for (let step = 0; step < HISTORY_LIMIT + 20; step += 1) {
      history = reduceHistory(history, {
        type: 'pick',
        kind: 'Contract',
        id: `src/C${String(step)}.sol:C${String(step)}`,
      });
    }
    expect(history.entries).toHaveLength(HISTORY_LIMIT);
    // The newest is still current after the oldest were dropped.
    expect(current(history).focus).toContain(`C${String(HISTORY_LIMIT + 19)}`);
  });
});

describe('crumb labels', () => {
  it('names a place by its view and what it is looking at', () => {
    expect(crumbLabel(start)).toBe('Protocol map');
    expect(crumbLabel(current(drillDown()))).toBe('Call graph: swap');
    expect(crumbLabel({ ...start, expand: ['src', 'src/libraries'] })).toBe(
      'Protocol map: src/libraries',
    );
  });

  it('shortens an id the way a human reads it', () => {
    expect(shortName(SWAP)).toBe('swap');
    expect(shortName(PAIR)).toBe('Pair');
    expect(shortName('src/Vault.sol:Vault#onlyOwner')).toBe('onlyOwner');
    expect(shortName('?low-level:call')).toBe('call');
  });
});
