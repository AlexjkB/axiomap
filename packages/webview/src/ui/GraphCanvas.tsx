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
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CyElements } from './elements.js';
import { toElkGraph } from './layout/elk-graph.js';
import type { LayoutClient } from './layout/client.js';
import type { ViewPreset } from './presets.js';
import { DIMMED, stylesheet, type Palette } from './style.js';

/**
 * How far `fit` may zoom in on a graph too small to fill the viewport.
 *
 * Unbounded fit turns nine contracts into nine billboards, which is the
 * opposite of §11's "information density over whitespace"; clamping to 1
 * leaves a nine-contract map as a postage stamp in the middle of a 1400px
 * screen. This is the middle, chosen by looking at both.
 */
const MAX_FIT_ZOOM = 1.75;

/**
 * How far `fit` may zoom *out* before the graph stops being readable.
 *
 * The other end of the same argument. A contract with twenty members lays out
 * several thousand pixels wide, and fitting all of it into the canvas puts the
 * whole view at about a quarter zoom — labels three pixels tall, and a node's
 * kind no longer readable from its border. §11's density target is what is
 * legible "at default zoom", so the honest default is a legible part of the
 * graph rather than an illegible whole of it: below this the view is clamped
 * and anchored at the graph's top-left corner, and panning reaches the rest.
 */
const MIN_FIT_ZOOM = 0.6;

/**
 * Telling a mouse wheel from a trackpad, which the platform will not do for us.
 *
 * `WheelEvent` carries no device. What it carries is a shape: a wheel notch is
 * one large quantised delta — 100 or 120 pixels, or a line count — while a
 * trackpad streams many small fractional ones, and a pinch arrives as a wheel
 * event with `ctrlKey` set. So the threshold is the discriminator, and it is
 * deliberately well above any per-frame trackpad delta rather than close to it.
 *
 * A misread in either direction is a nuisance and not a fault: a trackpad
 * mistaken for a wheel zooms one step too eagerly, a wheel mistaken for a
 * trackpad zooms as it did before this existed.
 */
const WHEEL_NOTCH_DELTA = 50;

/**
 * How much of a zoom one wheel notch is worth.
 *
 * Separate from cytoscape's own `wheelSensitivity`, which applies to every
 * device at once and therefore cannot be raised for a wheel without making a
 * trackpad unusable.
 *
 * Tuned by hand against a real mouse rather than derived: 0.003 measured at
 * 1.39x per notch and overshot — two notches crossed a doubling, which is more
 * than a graph you are reading wants. This is about 1.25x, or three notches per
 * doubling. The harness asserts the band so it cannot drift back.
 */
const WHEEL_ZOOM_RATE = 0.002;

/** Padding used by every fit here, so the clamp and the fit agree. */
const FIT_PADDING = 24;

/**
 * Whether a node can be dragged out of the position ELK gave it — and why the
 * answer starts as "no".
 *
 * Cytoscape's default is grabbable, so before this existed every click on a
 * contract or a function was also a potential drag: a few pixels of travel
 * while pressing, and the node is somewhere ELK did not put it. That is easy to
 * do by accident and impossible to undo, because the layout is only recomputed
 * when the elements change — there is no "put it back". Panning is the gesture
 * people actually want from a press-and-drag on this canvas, and it is what
 * they get on the background already.
 *
 * The laid-out graph is the product here: §9 rule 6 spends a worker and a
 * two-step render getting the positions right, and a stray drag quietly makes
 * the picture wrong in a way that still looks deliberate. So the default
 * protects the layout and moving nodes is the thing you opt into.
 */
const LOCKED_BY_DEFAULT = true;

/**
 * The padlock on the lock chip: a shackle that closes, and one that does not.
 *
 * Drawn here rather than pulled from an icon package. `lucide-react` is the
 * obvious way to get this glyph and it would be the *only* thing that
 * dependency is used for — against a repo that checks its dependencies for
 * network access, generates a notices file from them, and ships them inside a
 * VSIX. Two paths on Lucide's own 24-unit grid, at its 2px round-capped stroke,
 * cost none of that and are indistinguishable at 13px.
 *
 * `currentColor` is the point of using an SVG at all: the icon takes the chip's
 * colour, so it follows §11's palette into every host theme — including the
 * high-contrast ones — and picks up the engaged state for free. An emoji
 * padlock would have been a fixed-colour bitmap that ignores all of it, and
 * would render differently on each of the three platforms the extension ships
 * to (or not at all, on a box with no emoji font).
 */
function LockIcon({ locked }: { locked: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      // The button carries the accessible name; the drawing is decoration.
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      {/* Closed: the shackle lands back on the body. Open: it swings clear to
          the right, which is the state difference read at a glance. */}
      <path d={locked ? 'M7 11V7a5 5 0 0 1 10 0v4' : 'M7 11V7a5 5 0 0 1 9.9-1'} />
    </svg>
  );
}

export interface GraphCanvasProps {
  elements: CyElements;
  preset: ViewPreset;
  layoutClient: LayoutClient;
  /**
   * The resolved host palette (§11).
   *
   * Passed in rather than read here, so there is exactly one palette in the
   * app. Two `readDocumentPalette()` call sites can disagree — and would, the
   * moment a host changes its theme while the view is open: the canvas repaints
   * from the new one on its next update and the code preview, which the app
   * highlighted against the old one, does not.
   */
  palette: Palette;
  /** A node was clicked: a cluster path to toggle, or a graph node to focus. */
  onPick: (pick: { kind: string; id: string; path?: string; expanded?: boolean }) => void;
  /**
   * An edge was clicked, with its **call site** (§11: "click edge → reveal the
   * call site"). Null for an aggregated edge, which stands for many sites and
   * carries none.
   */
  onPickEdge?: (site: { file: string; line: number; column: number } | null) => void;
  /**
   * The node the app considers selected, which is not always one that was
   * clicked here: §11's inverse navigation selects from the *editor's* cursor.
   * Applied to cytoscape's own selection so both routes light the same box.
   */
  selected?: string | null;
  /** Layout finished (ms), is pending (null), or failed (a message). */
  onLayout: (result: number | null | { failed: string }) => void;
}

export function GraphCanvas({
  elements,
  preset,
  layoutClient,
  palette,
  onPick,
  onPickEdge,
  selected = null,
  onLayout,
}: GraphCanvasProps): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const cy = useRef<cytoscape.Core | null>(null);
  const [locked, setLocked] = useState(LOCKED_BY_DEFAULT);
  const handlers = useRef({ onPick, onPickEdge, onLayout });
  handlers.current = { onPick, onPickEdge, onLayout };
  // The mount effect runs once and must not re-run when the theme changes; the
  // stylesheet is reapplied by the element effect below, which does.
  const current = useRef(palette);
  current.current = palette;

  useEffect(() => {
    const element = container.current;
    if (element === null) return;

    const instance = cytoscape({
      container: element,
      elements: [],
      style: stylesheet(current.current, preset),
      /*
       * This now applies to the trackpad and the pinch gesture only — a mouse
       * wheel is intercepted below and zoomed at its own rate, because one
       * sensitivity cannot serve both. Kept calmer than cytoscape's default of
       * 1 for the reason it always was: a trackpad in a webview streams many
       * more events per gesture than a wheel does.
       */
      wheelSensitivity: 0.6,
      /*
       * Set at construction as well as by the effect below, so there is no
       * frame between mount and the first effect in which a node is grabbable.
       * The effect is what tracks the toggle; this is what makes the initial
       * state true of the instance rather than only of the button.
       */
      autoungrabify: LOCKED_BY_DEFAULT,
      /*
       * Off, and it shipped on.
       *
       * It renders a texture of the *current viewport* and moves that around
       * while panning, so everything you pan toward is blank until you let go
       * and the real elements are drawn — the opposite of what panning is for.
       * Reported as having to release the mouse before the graph could be seen.
       *
       * **It was a throughput hedge that bought nothing.** Measured on
       * `fixtures/large` at 1,478 drawn elements, near §9 rule 2's cap of
       * 1,500, panning every frame: **5.4 fps with it on, 5.7 fps with it off**
       * — the same, and if anything slightly worse for keeping it. So the blank
       * viewport was the entire cost of the option.
       *
       * (Both numbers are from headless Chrome with software rendering, so they
       * are a comparison and not a report on real hardware. The comparison is
       * the part that decides this.)
       */
      textureOnViewport: false,
      /*
       * `pixelRatio` is deliberately left at cytoscape's default, which is the
       * device's. Pinning it to 1 renders half-resolution on any HiDPI display
       * — permanently, not only while moving — and §11's density argument is
       * about labels being legible at default zoom. Soft text at every zoom
       * costs more than it saves.
       */
    });

    /*
     * A mouse wheel zooms further per notch than a trackpad does per frame.
     *
     * Capture phase and `stopPropagation`, so cytoscape's own handler never
     * sees the events we take over — and *only* those. Anything that does not
     * look like a notch is left alone and reaches cytoscape with its own
     * `wheelSensitivity`, which is what a trackpad and a pinch still get.
     */
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) return;
      const notch = event.deltaMode !== 0 || Math.abs(event.deltaY) >= WHEEL_NOTCH_DELTA;
      if (!notch) return;

      event.preventDefault();
      event.stopPropagation();

      const box = element.getBoundingClientRect();
      instance.zoom({
        level: instance.zoom() * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE),
        // About the pointer, not the centre: zooming toward what you are
        // looking at is the whole reason a wheel beats the +/- buttons.
        renderedPosition: { x: event.clientX - box.left, y: event.clientY - box.top },
      });
    };
    element.addEventListener('wheel', onWheel, { capture: true, passive: false });

    /*
     * Ending a drag whose end the page never saw.
     *
     * Cytoscape decides a drag is over when it gets a `mouseup`, and it listens
     * for that on the window — which covers every release inside the page and
     * none outside it. Let go over another application, over the editor beside
     * the panel, or off the top of the screen, and no event is delivered at
     * all: `hoverData.dragging` stays true, and the graph pans along with the
     * pointer the next time it comes back, under a button nobody is holding.
     * Measured on `fixtures/defi` before this existed — two hover moves after a
     * lost release panned the viewport from 550,154 to 810,374.
     *
     * A webview is where this bites hardest. A top-level page usually keeps an
     * implicit grab on the pointer for the length of a drag; a panel in an
     * editor is a small target inside someone else's window, and leaving it
     * mid-drag is ordinary rather than exceptional.
     *
     * So the release is reconstructed from the two moments it can be:
     *
     *   - the pointer leaves the window (`mouseout` with no `relatedTarget`),
     *     which is where the press is lifted rather than followed out, and
     *   - the pointer comes back with nothing held (`buttons === 0`), which is
     *     the backstop for every route that skips the first — alt-tab, a
     *     window manager stealing the drag, a leave event that never fires.
     *
     * `blur` covers the same ground as the second for a page that is switched
     * away from entirely.
     *
     * What is dispatched is a real `mouseup` on the window, so cytoscape runs
     * its own end-of-drag cleanup — its state machine is left to itself rather
     * than reached into, which is the difference between this surviving a
     * cytoscape upgrade and quietly breaking on one.
     */
    let pressed = false;

    const release = (event: MouseEvent | Event): void => {
      if (!pressed) return;
      pressed = false;
      const at = event instanceof MouseEvent ? event : undefined;
      window.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 0,
          // Where the pointer was last seen. Cytoscape reads the position off
          // the event to decide whether the gesture was a tap or a drag, and a
          // release invented at 0,0 would be a drag across the whole graph.
          clientX: at?.clientX ?? 0,
          clientY: at?.clientY ?? 0,
        }),
      );
    };

    const onDown = (event: MouseEvent): void => {
      if (event.button === 0) pressed = true;
    };
    const onUp = (): void => {
      pressed = false;
    };
    // `relatedTarget === null` is the window boundary specifically. Leaving one
    // element for another inside the page reports where it went, and those must
    // not lift the press — a drag across the canvas crosses them constantly.
    const onOut = (event: MouseEvent): void => {
      if (event.relatedTarget === null) release(event);
    };
    const onMove = (event: MouseEvent): void => {
      if (event.buttons === 0) release(event);
    };

    element.addEventListener('mousedown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
    // Capture, so the stuck drag is ended before cytoscape's own `mousemove`
    // handler runs on the same event and pans one more frame with it.
    window.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseout', onOut, true);
    window.addEventListener('blur', release);

    instance.on('tap', 'node', (event) => {
      const node = event.target as cytoscape.NodeSingular;
      handlers.current.onPick({
        kind: String(node.data('kind')),
        id: node.id(),
        ...(node.data('path') === undefined ? {} : { path: String(node.data('path')) }),
        ...(node.data('expanded') === undefined ? {} : { expanded: Boolean(node.data('expanded')) }),
      });
    });

    instance.on('tap', 'edge', (event) => {
      const edge = event.target as cytoscape.EdgeSingular;
      const file = edge.data('file') as string | undefined;
      handlers.current.onPickEdge?.(
        file === undefined
          ? null
          : {
              file,
              line: Number(edge.data('line')),
              column: Number(edge.data('column')),
            },
      );
    });

    cy.current = instance;
    return () => {
      element.removeEventListener('wheel', onWheel, { capture: true });
      element.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseout', onOut, true);
      window.removeEventListener('blur', release);
      instance.destroy();
      cy.current = null;
    };
    // Mount once. The instance outlives every prop: elements and stylesheet are
    // both refreshed by the effect below, and rebuilding cytoscape per view
    // would throw away the viewport the user just panned.
  }, []);

  useEffect(() => {
    const instance = cy.current;
    const element = container.current;
    if (instance === null || element === null) return;
    let abandoned = false;

    instance.batch(() => {
      instance.elements().remove();
      instance.style(stylesheet(palette, preset));
      instance.add([
        ...elements.nodes.map((node) => ({ group: 'nodes' as const, data: node.data, classes: node.classes })),
        ...elements.edges.map((edge) => ({ group: 'edges' as const, data: edge.data, classes: edge.classes })),
      ]);
    });

    /*
     * Step 1: positioned badly, and not shown yet.
     *
     * The grid is still run because ELK needs every node measured — its sizes
     * come from cytoscape below — and because it is the fallback if the worker
     * never answers. What changed is that it is not *watched*: the canvas is
     * held blank until real positions arrive, so a view opens with its graph
     * already in place instead of assembling itself from a grid.
     *
     * §9 rule 6 says to "render nodes unlaid-out immediately, animate into
     * position when ELK returns". The half that matters is the rest of that
     * rule — never block on layout — and nothing here does: the layout is in a
     * worker, the main thread is free, the status bar says it is working. What
     * is given up is watching the graph arrive, which reads as the tool being
     * unsure where things go rather than as feedback. Measured layouts on real
     * fixtures are 13-366 ms, so the blank is brief.
     */
    element.style.visibility = 'hidden';
    instance.layout({ name: 'grid', fit: true, animate: false }).run();
    handlers.current.onLayout(null);

    // Nothing to lay out, so nothing to wait for.
    if (elements.nodes.length === 0) {
      element.style.visibility = 'visible';
      return;
    }

    // Step 2: the real layout, off the main thread.
    const graph = toElkGraph(elements, preset, (id) => {
      const node = instance.getElementById(id);
      if (node.empty()) return { width: 120, height: 40 };
      /*
       * Padded, not bare. `width()`/`height()` are the label box and exclude
       * the padding cytoscape draws around it — which is where §11's complexity
       * heatmap lives, so a laid-out graph would have spaced the nodes for a
       * size they are not drawn at and the biggest, most complex functions
       * would be the ones overlapping their neighbours.
       */
      // `paddedWidth()` is the same sum and is missing from cytoscape's own
      // type declarations, so the padding is read and added here instead.
      const padding = Number(node.numericStyle('padding')) || 0;
      return {
        width: Math.max(40, node.width() + 2 * padding),
        height: Math.max(24, node.height() + 2 * padding),
      };
    });

    void layoutClient
      .layout(graph)
      .then((result) => {
        if (abandoned) return;
        // Step 3: into position, in one paint. Not animated — see step 1.
        const applied = instance.layout({
          name: 'preset',
          positions: result.positions,
          fit: true,
          padding: 24,
          animate: false,
        });
        /*
         * Fit again once it has stopped. A compound node's box is fitted around
         * its children by cytoscape *after* their positions change, so the fit
         * that runs with the layout measures a graph whose cluster boxes are
         * still the old size — and the result is a viewport cropped by however
         * much the boxes grew. It cost the right-hand edge of the protocol map.
         */
        applied.on('layoutstop', () => {
          instance.fit(undefined, FIT_PADDING);
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
          } else if (instance.zoom() < MIN_FIT_ZOOM) {
            // Anchored top-left rather than centred: the middle of a graph too
            // big to fit is an arbitrary place to be put down, and the corner
            // is where reading starts.
            instance.zoom(MIN_FIT_ZOOM);
            const box = instance.elements().boundingBox();
            instance.pan({
              x: FIT_PADDING - box.x1 * MIN_FIT_ZOOM,
              y: FIT_PADDING - box.y1 * MIN_FIT_ZOOM,
            });
          }
        });
        applied.run();
        // Revealed only now, with everything where it belongs. `layoutstop`
        // fires synchronously for an unanimated layout, so the fit above has
        // already run by this point.
        element.style.visibility = 'visible';
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
         *
         * So the grid is revealed rather than left hidden: a blank canvas would
         * be a worse version of the same failure, and the status bar carries the
         * reason either way.
         */
        element.style.visibility = 'visible';
        handlers.current.onLayout({
          failed: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      abandoned = true;
    };
  }, [elements, preset, layoutClient, palette]);

  /*
   * §11's inverse navigation, at the end that draws.
   *
   * The app's selection is the authority — a click here and a cursor move in
   * the editor both end up in it — so cytoscape's own selection is made to
   * follow it rather than the two being kept in step. A selected node that this
   * view does not draw is not an error: the inspector is showing it, and the
   * canvas has nothing to light.
   */
  useEffect(() => {
    const instance = cy.current;
    if (instance === null) return;
    instance.batch(() => {
      instance.elements(':selected').unselect();
      instance.elements().removeClass(DIMMED);
      if (selected === null) return;
      const node = instance.getElementById(selected);
      if (node.empty()) return;
      node.select();

      /*
       * Everything unrelated to the selection, faded back.
       *
       * The state-access map of a real contract is the case that asks for this:
       * fifteen functions against fifteen storage variables is a couple of
       * hundred crossing edges, and finding the four that belong to the one
       * function you clicked is a tracing exercise done with a fingertip on the
       * screen. Dimming answers it in one glance, and it answers the reverse
       * question — *who else writes this variable* — the same way.
       *
       * One hop, both directions. `closedNeighborhood` is the selection plus
       * the edges touching it plus what is on their far end, which is exactly
       * "related to what is selected" for every view here: callers and callees
       * in the call graph, the storage a function touches in the state map, the
       * contracts a contract inherits from. Going transitive would light most
       * of a connected graph and dim nothing worth dimming.
       *
       * Ancestors are kept lit so a cluster or contract box does not fade out
       * from around a node that stayed: the container is not "unrelated", it is
       * where the related thing lives. Descendants likewise, so selecting a
       * collapsed contract does not grey out its own members.
       */
      const near = node.closedNeighborhood();
      const lit = near.union(near.ancestors()).union(near.descendants());
      instance.elements().difference(lit).addClass(DIMMED);
    });
  }, [selected, elements]);

  /*
   * The lock, applied to the instance.
   *
   * `autoungrabify` is core-level rather than per-node, which is why the
   * element effect can wipe and re-add everything without this having to run
   * again: nodes added while it is on arrive ungrabbable. It blocks the drag
   * and nothing else — pan, zoom, tap-to-focus, edge clicks and selection all
   * work locked, so §11's inverse navigation is unaffected either way.
   *
   * Deliberately not in `NavState` and not in the URL protocol. Those describe
   * *which graph* is on screen and are shared and restored as such; this is how
   * the mouse behaves over it, closer to the zoom level than to the view.
   */
  useEffect(() => {
    cy.current?.autoungrabify(locked);
  }, [locked]);

  /*
   * Zoom that does not depend on a wheel.
   *
   * The wheel is the only way to change zoom otherwise, and a webview panel is
   * exactly where a wheel is least predictable — trackpad, tiling, a host that
   * may claim the gesture. These are deterministic steps and a way back to a
   * known state, which is what "I cannot zoom" actually asks for.
   */
  const step = useCallback((factor: number) => {
    const instance = cy.current;
    if (instance === null) return;
    instance.zoom({
      level: instance.zoom() * factor,
      position: { x: instance.width() / 2, y: instance.height() / 2 },
    });
  }, []);

  const refit = useCallback(() => {
    const instance = cy.current;
    if (instance === null || instance.elements().empty()) return;
    instance.fit(undefined, FIT_PADDING);
    if (instance.zoom() > MAX_FIT_ZOOM) {
      instance.zoom({
        level: MAX_FIT_ZOOM,
        position: { x: instance.width() / 2, y: instance.height() / 2 },
      });
      instance.center();
    }
  }, []);

  return (
    <div className="ax-stage-inner">
      <div className="ax-canvas" ref={container} />
      {/* Not "Zoom" any more: the group holds the lock too, and a screen reader
          announcing a lock button as part of a zoom group is a small lie. */}
      <div className="ax-zoom" role="group" aria-label="Canvas controls">
        <button type="button" className="ax-chip" title="Zoom in" onClick={() => { step(1.3); }}>
          +
        </button>
        <button type="button" className="ax-chip" title="Zoom out" onClick={() => { step(1 / 1.3); }}>
          −
        </button>
        <button type="button" className="ax-chip" title="Fit the graph to the viewport" onClick={refit}>
          fit
        </button>
        {/* The glyph flips where the word could not: an open and a closed
            padlock are the same width and unambiguous about which state is
            current, whereas the label "unlock" reads as both the state and the
            action. `aria-pressed` still carries it for a screen reader, and the
            `aria-label` is the name the icon cannot be. */}
        <button
          type="button"
          className="ax-chip ax-chip-icon"
          aria-pressed={locked}
          aria-label="Lock node positions"
          title={
            locked
              ? 'Nodes are locked in place — click to allow dragging them'
              : 'Nodes can be dragged — click to lock them in place'
          }
          onClick={() => {
            setLocked((value) => !value);
          }}
        >
          <LockIcon locked={locked} />
        </button>
      </div>
    </div>
  );
}
