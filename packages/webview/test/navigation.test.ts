/**
 * What a click does. Pure, so it is checkable without a browser — and it is the
 * part of the UI where a wrong answer looks like a broken graph rather than a
 * broken control.
 */

import { describe, expect, it } from 'vitest';

import { initialState, ready, reduce, toRequest, type NavState } from '../src/ui/navigation.js';

const start: NavState = initialState({ up: 2, down: 3 });

describe('navigation', () => {
  it('starts on the protocol map with §9 rule 4’s hop defaults', () => {
    expect(start.view).toBe('protocol');
    expect(start.focus).toBeNull();
    expect(toRequest(start)).toEqual({ view: 'protocol' });
    expect(ready(start)).toBe(true);
  });

  it('refuses the call graph until something is focused (§9 rule 4)', () => {
    const call = reduce(start, { type: 'view', view: 'call' });
    expect(ready(call)).toBe(false);
    const focused = reduce(call, { type: 'focus', focus: 'src/Vault.sol:Vault.deposit(uint256)' });
    expect(ready(focused)).toBe(true);
    expect(toRequest(focused)).toEqual({
      view: 'call',
      focus: 'src/Vault.sol:Vault.deposit(uint256)',
      up: 2,
      down: 3,
    });
  });

  it('drills down: a contract opens its members, a function opens its call graph', () => {
    const opened = reduce(start, { type: 'pick', kind: 'Contract', id: 'src/Vault.sol:Vault' });
    expect(opened).toMatchObject({ view: 'contract', focus: 'src/Vault.sol:Vault' });

    const called = reduce(opened, {
      type: 'pick',
      kind: 'Function',
      id: 'src/Vault.sol:Vault.deposit(uint256)',
    });
    expect(called).toMatchObject({ view: 'call', focus: 'src/Vault.sol:Vault.deposit(uint256)' });
  });

  it('does nothing for a node no view is about, rather than opening an empty one', () => {
    for (const kind of ['StateVariable', 'Event', 'Error', 'Unresolved']) {
      expect(reduce(start, { type: 'pick', kind, id: 'x' })).toBe(start);
    }
  });

  it('toggles a directory, and closing one closes what is inside it', () => {
    const open = reduce(start, { type: 'pick', kind: 'Cluster', id: 'dir:src', path: 'src' });
    const deeper = reduce(open, {
      type: 'pick',
      kind: 'Cluster',
      id: 'dir:src/tokens',
      path: 'src/tokens',
    });
    expect(deeper.expand).toEqual(['src', 'src/tokens']);

    const closed = reduce(deeper, { type: 'pick', kind: 'Cluster', id: 'dir:src', path: 'src' });
    // Leaving `src/tokens` behind would reopen `src`: `aggregate` closes the
    // expansion set under its ancestors.
    expect(closed.expand).toEqual([]);
  });

  it('drops the expansion set when the view changes', () => {
    const open = reduce(start, { type: 'pick', kind: 'Cluster', id: 'dir:src', path: 'src' });
    expect(toRequest(open)).toEqual({ view: 'protocol', expand: ['src'] });
    const moved = reduce(open, { type: 'view', view: 'inheritance' });
    expect(moved.expand).toEqual([]);
    expect(toRequest(moved)).toEqual({ view: 'inheritance' });
  });

  it('sends hop limits for the call view only', () => {
    const call = reduce(
      reduce(start, { type: 'focus', focus: 'f' }),
      { type: 'view', view: 'call' },
    );
    expect(toRequest(reduce(call, { type: 'hops', up: 1, down: 5 }))).toMatchObject({
      up: 1,
      down: 5,
    });
    expect(toRequest(reduce(call, { type: 'view', view: 'contract' }))).toEqual({
      view: 'contract',
      focus: 'f',
    });
  });

  it('clamps a negative hop count rather than sending it', () => {
    expect(reduce(start, { type: 'hops', up: -3, down: 0 }).up).toBe(0);
  });
});
