// @vitest-environment jsdom

/**
 * §11's `/` search palette (Phase 7d).
 *
 * The property this suite is really about is §9 rule 1: the palette must not
 * become a client-side index of the node set. That is asserted the only way a
 * component test can assert it — every query is a call to the host, and the
 * component holds nothing between queries that could answer one.
 *
 * The rest is the honesty half: a capped answer says how many it left out, and
 * an empty one says so rather than looking like a protocol with no functions.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SearchHit, SearchResults } from '@axiomap/core';

import { SearchPalette } from '../src/ui/SearchPalette.js';

afterEach(cleanup);

function hit(name: string, over: Partial<SearchHit> = {}): SearchHit {
  return {
    id: `src/Pair.sol:Pair.${name}(uint256)`,
    name,
    kind: 'Function',
    scope: 'src/Pair.sol:Pair',
    file: 'src/Pair.sol',
    line: 69,
    match: 'name',
    ...over,
  };
}

function results(hits: SearchHit[], over: Partial<SearchResults> = {}): SearchResults {
  return { query: 'q', hits, total: hits.length, capped: false, limit: 20, ...over };
}

describe('SearchPalette', () => {
  it('draws nothing at all when it is closed', () => {
    const { container } = render(
      <SearchPalette open={false} search={() => Promise.resolve(results([]))} onPick={() => {}} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  /**
   * The rule, as a test: the component asks the host per query and keeps no
   * list of its own. If it ever cached the node set to filter locally, the
   * second query would not reach this spy.
   */
  it('asks the host for every query rather than filtering a list it holds', async () => {
    const asked: string[] = [];
    const search = vi.fn((query: string) => {
      asked.push(query);
      return Promise.resolve(results([hit('mint')]));
    });

    render(<SearchPalette open search={search} onPick={() => {}} onClose={() => {}} />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'mint' } });
    await waitFor(() => {
      expect(screen.getByText('mint')).toBeDefined();
    });

    fireEvent.change(input, { target: { value: 'min' } });
    await waitFor(() => {
      expect(asked).toContain('min');
    });
    expect(asked).toContain('mint');
  });

  it('says how many matched when the host capped the answer (§9 rule 2’s shape)', async () => {
    render(
      <SearchPalette
        open
        search={() => Promise.resolve(results([hit('a'), hit('b')], { total: 412, capped: true }))}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a' } });
    await waitFor(() => {
      expect(screen.getByText(/412 matches/)).toBeDefined();
    });
    expect(screen.getByText(/showing the closest 2/)).toBeDefined();
  });

  it('says when nothing matched rather than looking empty', async () => {
    render(
      <SearchPalette open search={() => Promise.resolve(results([]))} onPick={() => {}} onClose={() => {}} />,
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zzz' } });
    await waitFor(() => {
      expect(screen.getByText(/No node matches/)).toBeDefined();
    });
  });

  it('moves through the rows and picks one with Enter', async () => {
    const picked: SearchHit[] = [];
    render(
      <SearchPalette
        open
        search={() => Promise.resolve(results([hit('mint'), hit('burn'), hit('swap')]))}
        onPick={(chosen) => picked.push(chosen)}
        onClose={() => {}}
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'm' } });
    await waitFor(() => {
      expect(screen.getByText('mint')).toBeDefined();
    });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(picked.map((chosen) => chosen.name)).toEqual(['burn']);

    // And it wraps, so a hand on the arrow key cannot get stuck at the end.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(picked.map((chosen) => chosen.name)).toEqual(['burn', 'swap']);
  });

  it('closes on Escape', async () => {
    let open = true;
    render(
      <SearchPalette
        open
        search={() => Promise.resolve(results([]))}
        onPick={() => {}}
        onClose={() => {
          open = false;
        }}
      />,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    await waitFor(() => {
      expect(open).toBe(false);
    });
  });

  /**
   * A host that refuses is a host that said something. Printing its sentence
   * beats an empty list, which is indistinguishable from "no matches" — the
   * distinction §4 insists on everywhere else in this tool.
   */
  it('shows the host’s refusal rather than an empty list', async () => {
    render(
      <SearchPalette
        open
        search={() => Promise.reject(new Error('Could not reach axiomap serve.'))}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mint' } });
    await waitFor(() => {
      expect(screen.getByText(/Could not reach axiomap serve/)).toBeDefined();
    });
  });
});
