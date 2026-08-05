/**
 * Cytoscape, and §9 rule 6's two-step render.
 *
 * Rule 6: "Render nodes unlaid-out immediately, animate into position when ELK
 * returns. Never block on layout." That is literally what this component does,
 * in order:
 *
 * 1. Elements go in with a cheap `grid` layout, which is O(n) and instant. The
 *    graph is on screen, pannable and zoomable, before ELK has been asked
 *    anything.
 * 2. The measured sizes go to the worker.
 * 3. Positions come back and the nodes animate into them.
 *
 * A stale answer never lands: `LayoutClient` drops the response to any request
 * the caller has moved on from, and the effect below re-runs per elements
 * change.
 *
 * Sizes are read off cytoscape after step 1 rather than estimated, because ELK
 * cannot measure text and a layout against guessed sizes overlaps the labels
 * §11 wants legible.
 */

import cytoscape from 'cytoscape';
import { useEffect, useRef } from 'react';

import type { CyElements } from './elements.js';
import { toElkGraph } from './layout/elk-graph.js';
import type { LayoutClient } from './layout/client.js';
import type { ViewPreset } from './presets.js';
import { readPalette, stylesheet } from './style.js';

/**
 * How far `fit` may zoom in on a graph too small to fill the viewport.
 *
 * Unbounded fit turns nine contracts into nine billboards, which is the
 * opposite of §11's "information density over whitespace"; clamping to 1
 * leaves a nine-contract map as a postage stamp in the middle of a 1400px
 * screen. This is the middle, chosen by looking at both.
 */
const MAX_FIT_ZOOM = 1.75;

export interface GraphCanvasProps {
  elements: CyElements;
  preset: ViewPreset;
  layoutClient: LayoutClient;
  /** A node was clicked: a cluster path to toggle, or a graph node to focus. */
  onPick: (pick: { kind: string; id: string; path?: string; expanded?: boolean }) => void;
  /** Layout finished (ms), is pending (null), or failed (a message). */
  onLayout: (result: number | null | { failed: string }) => void;
}

export function GraphCanvas({
  elements,
  preset,
  layoutClient,
  onPick,
  onLayout,
}: GraphCanvasProps): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const cy = useRef<cytoscape.Core | null>(null);
  const handlers = useRef({ onPick, onLayout });
  handlers.current = { onPick, onLayout };

  useEffect(() => {
    const element = container.current;
    if (element === null) return;

    const instance = cytoscape({
      container: element,
      elements: [],
      style: stylesheet(
        readPalette((variable) => getComputedStyle(document.documentElement).getPropertyValue(variable)),
        preset,
      ),
      wheelSensitivity: 0.2,
      // §11: no animation except functional layout transitions.
      textureOnViewport: true,
      pixelRatio: 1,
    });

    instance.on('tap', 'node', (event) => {
      const node = event.target as cytoscape.NodeSingular;
      handlers.current.onPick({
        kind: String(node.data('kind')),
        id: node.id(),
        ...(node.data('path') === undefined ? {} : { path: String(node.data('path')) }),
        ...(node.data('expanded') === undefined ? {} : { expanded: Boolean(node.data('expanded')) }),
      });
    });

    cy.current = instance;
    return () => {
      instance.destroy();
      cy.current = null;
    };
    // Mount once. The instance outlives every prop: elements and stylesheet are
    // both refreshed by the effect below, and rebuilding cytoscape per view
    // would throw away the viewport the user just panned.
  }, []);

  useEffect(() => {
    const instance = cy.current;
    if (instance === null) return;
    let abandoned = false;

    instance.batch(() => {
      instance.elements().remove();
      instance.style(
        stylesheet(
          readPalette((variable) =>
            getComputedStyle(document.documentElement).getPropertyValue(variable),
          ),
          preset,
        ),
      );
      instance.add([
        ...elements.nodes.map((node) => ({ group: 'nodes' as const, data: node.data, classes: node.classes })),
        ...elements.edges.map((edge) => ({ group: 'edges' as const, data: edge.data, classes: edge.classes })),
      ]);
    });

    // Step 1: on screen now, laid out badly, at no cost.
    instance.layout({ name: 'grid', fit: true, animate: false }).run();
    handlers.current.onLayout(null);

    if (elements.nodes.length === 0) return;

    // Step 2: the real layout, off the main thread.
    const graph = toElkGraph(elements, preset, (id) => {
      const node = instance.getElementById(id);
      if (node.empty()) return { width: 120, height: 40 };
      return { width: Math.max(40, node.width()), height: Math.max(24, node.height()) };
    });

    void layoutClient
      .layout(graph)
      .then((result) => {
        if (abandoned) return;
        // Step 3: animate into position.
        const applied = instance.layout({
          name: 'preset',
          positions: result.positions,
          fit: true,
          padding: 24,
          animate: true,
          animationDuration: 250,
        });
        /*
         * Fit again once it has stopped. A compound node's box is fitted around
         * its children by cytoscape *after* their positions change, so the fit
         * that runs with the layout measures a graph whose cluster boxes are
         * still the old size — and the result is a viewport cropped by however
         * much the boxes grew. It cost the right-hand edge of the protocol map.
         */
        applied.on('layoutstop', () => {
          instance.fit(undefined, 24);
          /*
           * Fit zooms *in* on a small graph until it fills the viewport, which
           * turns nine contracts into nine billboards — the opposite of §11's
           * "information density over whitespace", and of its density target,
           * which is about what is legible at *default* zoom rather than at
           * whatever zoom makes one node fill a third of the screen.
           */
          if (instance.zoom() > MAX_FIT_ZOOM) {
            instance.zoom({
              level: MAX_FIT_ZOOM,
              position: { x: instance.width() / 2, y: instance.height() / 2 },
            });
            instance.center();
          }
        });
        applied.run();
        handlers.current.onLayout(result.ms);
      })
      .catch((error: unknown) => {
        // "superseded" is the normal case: the user moved on mid-layout.
        if (abandoned || (error instanceof Error && error.message === 'superseded')) return;
        /*
         * Anything else is the layout engine failing, and it must say so. The
         * elements are still on screen in their placeholder positions (§9 rule
         * 6), which means a dead worker looks exactly like a graph that is
         * merely ugly — and a tool whose job is honesty about what it knows
         * should not have a failure mode that is indistinguishable from a bad
         * layout. This one shipped: a bundler interop bug left `new ELK()`
         * throwing in the worker, and nothing on screen said anything.
         */
        handlers.current.onLayout({
          failed: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      abandoned = true;
    };
  }, [elements, preset, layoutClient]);

  return <div className="ax-canvas" ref={container} />;
}
