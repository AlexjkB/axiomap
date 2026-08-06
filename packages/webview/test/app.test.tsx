/**
 * The application, mounted.
 *
 * What this covers is the wiring the pure modules cannot: that the UI asks the
 * bridge for what the navigation state says (§9 rule 1 — and there is no other
 * source it could ask), that §4's mode and score reach the toolbar, and that a
 * render-cap refusal becomes a notice rather than an empty canvas.
 *
 * `GraphCanvas` is replaced by a probe. Cytoscape needs a real canvas and jsdom
 * has none, and the thing worth asserting here is *what the canvas is handed*,
 * which the probe records exactly. The canvas's own behaviour — elements, ELK
 * graph, positions, staleness — is covered by `elements.test.ts`, `layout.test.ts`
 * and `scale.test.ts` on the pure side of it.
 */

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AggregatedView,
  AggregatedViewOptions,
  NodeInspection,
  OverlayData,
  ProjectMeta,
  SearchResults,
  SourceSlice,
} from '@axiomap/core';

const canvasProps: Record<string, unknown>[] = [];

vi.mock('../src/ui/GraphCanvas.js', () => ({
  GraphCanvas: (props: Record<string, unknown>) => {
    canvasProps.push(props);
    return null;
  },
}));

import { App } from '../src/ui/App.js';
import { BridgeError, type HostBridge } from '../src/bridge.js';
import { LayoutClient } from '../src/ui/layout/client.js';
import { contract, fn, sliceOf, view } from './support.js';

const meta: ProjectMeta = {
  schemaVersion: 4,
  generator: { name: 'axiomap', parser: 'treesitter', hashVersion: 1, compilers: [] },
  project: { kind: 'foundry', sources: ['src'], files: 5 },
  mode: 'heuristic',
  modeReason: 'No build artifacts. 98% of call edges resolved confidently.',
  score: {
    overall: { semantic: 0, heuristic: 137, ambiguous: 1, unresolved: 1, total: 139, confident: 0.99 },
    calls: { semantic: 0, heuristic: 42, ambiguous: 0, unresolved: 1, total: 43, confident: 0.98 },
    excludedFiles: 0,
  },
  diagnostics: [],
  root: '/tmp/defi',
  renderCap: 1500,
  views: ['protocol', 'contract', 'call', 'state-access', 'inheritance'],
  callDefaults: { up: 2, down: 3 },
};

const vault = contract('src/Vault.sol:Vault');

function bridgeOf(
  answer: (request: AggregatedViewOptions) => Promise<AggregatedView>,
  extra: {
    inspect?: (id: string) => Promise<NodeInspection>;
    overlays?: () => Promise<OverlayData>;
    search?: (query: string, limit?: number) => Promise<SearchResults>;
    source?: (id: string) => Promise<SourceSlice>;
  } = {},
): { bridge: HostBridge; asked: AggregatedViewOptions[]; inspected: string[]; sliced: string[] } {
  const asked: AggregatedViewOptions[] = [];
  const inspected: string[] = [];
  const sliced: string[] = [];
  return {
    asked,
    inspected,
    sliced,
    bridge: {
      meta: () => Promise.resolve(meta),
      view: (request) => {
        asked.push(request);
        return answer(request);
      },
      inspect: (id) => {
        inspected.push(id);
        return (
          extra.inspect?.(id) ??
          Promise.resolve({
            id,
            node: vault,
            scope: null,
            members: [],
            incoming: [],
            outgoing: [],
          })
        );
      },
      overlays: () => extra.overlays?.() ?? Promise.resolve(emptyOverlays),
      search: (query, limit) =>
        extra.search?.(query, limit) ??
        Promise.resolve({ query, hits: [], total: 0, capped: false, limit: limit ?? 20 }),
      source: (id) => {
        sliced.push(id);
        return extra.source?.(id) ?? Promise.resolve(sliceOf(id));
      },
    },
  };
}

const emptyOverlays: OverlayData = {
  review: {},
  findings: {},
  summary: {
    reviewed: 0,
    flagged: 0,
    followUp: 0,
    ignored: 0,
    stale: 0,
    orphaned: 0,
    findings: 0,
    findingsStale: 0,
  },
  sources: { review: false, findings: false },
};

/** An ELK that never answers: the canvas is a probe here, not a renderer. */
const idleEngine = { layout: () => new Promise<never>(() => {}) };

afterEach(() => {
  // Vitest is not running with globals, so testing-library's automatic cleanup
  // never registers and each render would stack on the last one's DOM.
  cleanup();
  canvasProps.length = 0;
});

describe('App', () => {
  it('opens on the protocol map and states §4’s mode and score', async () => {
    const { bridge, asked } = bridgeOf(() =>
      Promise.resolve(
        view({
          nodes: [{ type: 'node', id: vault.id, node: vault, parent: null }],
          elements: 1,
          note: '9 contracts, inheritance plus cross-contract calls',
        }),
      ),
    );

    render(<App bridge={bridge} layoutClient={new LayoutClient(idleEngine)} />);

    await waitFor(() => {
      expect(screen.getByText('heuristic')).toBeDefined();
    });
    expect(asked[0]).toEqual({ view: 'protocol' });
    expect(screen.getByText(/139 edges — 0% semantic, 99% heuristic/)).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText(/9 contracts/)).toBeDefined();
    });
    expect(screen.getByText(/1 \/ 1,?500 elements|1 \/ 1500 elements/)).toBeDefined();

    // The canvas was handed the drawn contract, translated.
    const last = canvasProps.at(-1) as { elements: { nodes: { data: { label: string } }[] } };
    expect(last.elements.nodes.map((node) => node.data.label)).toEqual(['Vault']);
  });

  it('shows a render-cap refusal as the notice §9 rule 2 requires', async () => {
    const { bridge } = bridgeOf(() =>
      Promise.reject(
        new BridgeError({
          name: 'RenderCapError',
          message: '2,847 elements exceeds the render cap of 1,500 — collapse a directory.',
          elements: 2847,
          cap: 1500,
        }),
      ),
    );

    render(<App bridge={bridge} layoutClient={new LayoutClient(idleEngine)} />);

    await waitFor(() => {
      expect(screen.getByText('Too much to draw')).toBeDefined();
    });
    expect(screen.getByText(/collapse a directory/)).toBeDefined();
  });

  it('will not request a view that needs a focus it does not have (§9 rule 4)', async () => {
    const { bridge, asked } = bridgeOf(() => Promise.resolve(view()));
    render(<App bridge={bridge} layoutClient={new LayoutClient(idleEngine)} />);

    await waitFor(() => {
      expect(asked.length).toBeGreaterThan(0);
    });

    const callTab = screen.getByRole('button', { name: 'Call graph' }) as HTMLButtonElement;
    expect(callTab.disabled).toBe(true);
    // No focus, no request: the refusal is the UI's, before the host's.
    expect(asked.every((request) => request.view !== 'call')).toBe(true);
  });

  it('asks the host about a clicked node rather than reading the drawn view', async () => {
    const withdraw = fn('src/Vault.sol:Vault.withdraw(uint256)');
    const { bridge, inspected } = bridgeOf(
      () =>
        Promise.resolve(
          view({ nodes: [{ type: 'node', id: vault.id, node: vault, parent: null }], elements: 1 }),
        ),
      {
        inspect: (id) =>
          Promise.resolve({
            id,
            node: vault,
            scope: null,
            members: [],
            incoming: [],
            outgoing: [
              {
                id: withdraw.id,
                name: 'withdraw',
                kind: 'Function',
                edgeKind: 'calls',
                subkind: 'internal',
                resolution: 'heuristic',
                count: 1,
                src: withdraw.src,
                virtual: false,
                crossTrustBoundary: false,
              },
            ],
          }),
      },
    );

    render(<App bridge={bridge} layoutClient={new LayoutClient(idleEngine)} />);
    await waitFor(() => {
      expect(canvasProps.length).toBeGreaterThan(0);
    });

    // The click a mouse would make, through the same handler the canvas calls.
    const onPick = (canvasProps.at(-1) as { onPick: (pick: { kind: string; id: string }) => void })
      .onPick;
    act(() => {
      onPick({ kind: 'Contract', id: vault.id });
    });

    // §11's inspector reaches the graph only through the bridge — a relation
    // outside the drawn view is exactly what it has to be able to show.
    await waitFor(() => {
      expect(inspected).toEqual([vault.id]);
    });
    expect(screen.getByText('withdraw')).toBeDefined();
  });

  it('turns an overlay on and off, and prints its legend while it is on', async () => {
    const sweep = fn('src/Vault.sol:Vault.sweep()', {
      flags: { ...fn('x').flags, hasDelegatecall: true },
    });
    const { bridge } = bridgeOf(() =>
      Promise.resolve(
        view({
          view: 'contract',
          nodes: [{ type: 'node', id: sweep.id, node: sweep, parent: null }],
          elements: 1,
        }),
      ),
    );

    render(<App bridge={bridge} layoutClient={new LayoutClient(idleEngine)} />);
    await waitFor(() => {
      expect(canvasProps.length).toBeGreaterThan(0);
    });

    const toggle = screen.getByRole('button', { name: 'Danger ops' });
    expect(screen.queryByText('delegatecall')).toBeNull();
    act(() => {
      toggle.click();
    });
    // A glyph nobody can decode is the same as no glyph, so the legend is part
    // of the overlay rather than a nicety beside it.
    expect(screen.getByText('delegatecall')).toBeDefined();
    act(() => {
      toggle.click();
    });
    expect(screen.queryByText('delegatecall')).toBeNull();
  });

  it('says so when an active overlay has nothing to mark in this view', async () => {
    // The protocol map draws contracts and six of the eight overlays are about
    // functions, so an overlay can be on and silent — which looked exactly like
    // a clean result until it said this.
    const { bridge } = bridgeOf(() =>
      Promise.resolve(
        view({ nodes: [{ type: 'node', id: vault.id, node: vault, parent: null }], elements: 1 }),
      ),
    );

    render(
      <App
        bridge={bridge}
        layoutClient={new LayoutClient(idleEngine)}
        initialOverlays={['danger-ops']}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/nothing in this view/)).toBeDefined();
    });
    expect(screen.queryByText('delegatecall')).toBeNull();
  });

  it('says so when a view has nothing in it, rather than showing a blank canvas', async () => {
    const { bridge } = bridgeOf(() =>
      Promise.resolve(view({ elements: 0, note: '0 reads/writes involving src/Vault.sol:Vault' })),
    );
    render(<App bridge={bridge} layoutClient={new LayoutClient(idleEngine)} />);

    await waitFor(() => {
      expect(screen.getByText('Nothing to draw')).toBeDefined();
    });
    // Twice: in the notice, and in the status bar's `view.note`.
    expect(screen.getAllByText(/0 reads\/writes/).length).toBe(2);
  });

  it('says which audit-state file is missing rather than showing an empty overlay', async () => {
    const { bridge } = bridgeOf(() => Promise.resolve(view()));
    render(
      <App
        bridge={bridge}
        layoutClient={new LayoutClient(idleEngine)}
        initialOverlays={['review', 'findings']}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/no \.axiomap\/review\.json/)).toBeDefined();
    });
    expect(screen.getByText(/axiomap import-findings/)).toBeDefined();
  });

  /**
   * §11's code preview, at the wiring level: the panel is filled from a second
   * bridge call rather than from anything the view carried, because the view
   * carries no source and never will (§9 rule 1).
   */
  it('asks the host for a clicked node’s source', async () => {
    const { bridge, sliced } = bridgeOf(() =>
      Promise.resolve(
        view({ nodes: [{ type: 'node', id: vault.id, node: vault, parent: null }], elements: 1 }),
      ),
    );
    render(<App bridge={bridge} layoutClient={new LayoutClient(idleEngine)} />);

    await waitFor(() => {
      expect(canvasProps.length).toBeGreaterThan(0);
    });
    const onPick = canvasProps.at(-1)?.['onPick'] as (pick: { kind: string; id: string }) => void;
    act(() => {
      onPick({ kind: 'Contract', id: vault.id });
    });

    await waitFor(() => {
      expect(sliced).toContain(vault.id);
    });
    await waitFor(() => {
      expect(screen.getByText(/total \+= amount/)).toBeDefined();
    });
  });

  /**
   * §11's `/`. The palette is reached by a keystroke on the document, because
   * the thing the user is looking at is a canvas that cannot hold focus — and
   * choosing a row does the same two things a click on that canvas does.
   */
  it('opens the search palette on “/” and navigates to what is chosen', async () => {
    const swap = fn('src/Pair.sol:Pair.swap(uint256)');
    const { bridge, asked, inspected } = bridgeOf(() => Promise.resolve(view()), {
      search: (query) =>
        Promise.resolve({
          query,
          hits: [
            {
              id: swap.id,
              name: 'swap',
              kind: 'Function',
              scope: 'src/Pair.sol:Pair',
              file: 'src/Pair.sol',
              line: 88,
              match: 'name',
            },
          ],
          total: 1,
          capped: false,
          limit: 20,
        }),
    });

    render(<App bridge={bridge} layoutClient={new LayoutClient(idleEngine)} />);
    await waitFor(() => {
      expect(asked.length).toBeGreaterThan(0);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    const input = await screen.findByRole('textbox');
    act(() => {
      fireEvent.change(input, { target: { value: 'swap' } });
    });

    await waitFor(() => {
      expect(screen.getByText('swap')).toBeDefined();
    });
    fireEvent.keyDown(input, { key: 'Enter' });

    // §9 rule 4 still decides which view a Function opens; the palette only
    // supplied the node.
    await waitFor(() => {
      expect(asked.some((request) => request.view === 'call' && request.focus === swap.id)).toBe(true);
    });
    expect(inspected).toContain(swap.id);
  });

  /**
   * §11: "auditors get lost; give them undo." The breadcrumb and the arrows are
   * one index into one trail, so this checks the trail exists and that going
   * back re-requests the view you came from.
   */
  it('keeps a breadcrumb of where you have been, and goes back', async () => {
    const { bridge, asked } = bridgeOf(() =>
      Promise.resolve(
        view({ nodes: [{ type: 'node', id: vault.id, node: vault, parent: null }], elements: 1 }),
      ),
    );
    render(<App bridge={bridge} layoutClient={new LayoutClient(idleEngine)} />);

    await waitFor(() => {
      expect(canvasProps.length).toBeGreaterThan(0);
    });
    const onPick = canvasProps.at(-1)?.['onPick'] as (pick: { kind: string; id: string }) => void;
    act(() => {
      onPick({ kind: 'Contract', id: vault.id });
    });

    // Scoped to the trail: "Protocol map" is also the name of a view tab, and
    // the crumb and the tab are different controls that happen to agree.
    const trail = await screen.findByLabelText('History');
    await waitFor(() => {
      expect(trail.textContent).toContain('Contract detail: Vault');
    });
    expect(trail.textContent).toContain('Protocol map');

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }),
      );
    });

    await waitFor(() => {
      expect(asked.at(-1)).toEqual({ view: 'protocol' });
    });
  });
});
