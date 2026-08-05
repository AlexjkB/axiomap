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

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AggregatedView, AggregatedViewOptions, ProjectMeta } from '@axiomap/core';

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
import { contract, view } from './support.js';

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
): { bridge: HostBridge; asked: AggregatedViewOptions[] } {
  const asked: AggregatedViewOptions[] = [];
  return {
    asked,
    bridge: {
      meta: () => Promise.resolve(meta),
      view: (request) => {
        asked.push(request);
        return answer(request);
      },
    },
  };
}

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
});
