/**
 * The application: one bridge, one navigation state, one canvas, one inspector.
 *
 * Everything it knows about the graph arrived through `HostBridge` — `view` for
 * the drawn subgraph (§9 rule 1), `inspect` for one node's attributes and
 * relations (§11), `overlays` for the two audit-state files the host reads.
 * There is no second door: no full graph in memory, no client-side filtering of
 * one, no second copy of the query API. When this component needs a different
 * subgraph, or anything about a node it is not drawing, it asks.
 *
 * The status bar is the honest half of §9: it prints what was aggregated and
 * why (`view.note`), and when the host refuses a request because it would not
 * be legible, it prints the refusal with the way out rather than drawing a
 * hairball (rule 2).
 */

import type { AggregatedView, NodeInspection, OverlayData, ProjectMeta } from '@axiomap/core';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { BridgeError, type HostBridge } from '../bridge.js';
import { GraphCanvas } from './GraphCanvas.js';
import { Inspector } from './Inspector.js';
import { toElements } from './elements.js';
import { LayoutClient, browserEngine } from './layout/client.js';
import { initialState, reduce, ready, toRequest } from './navigation.js';
import { OverlayBar } from './OverlayBar.js';
import { nodeUncertainty, overlayCoverage, type OverlayName } from './overlays.js';
import { PRESETS } from './presets.js';
import { readDocumentPalette } from './style.js';
import { Toolbar } from './Toolbar.js';

export interface AppProps {
  bridge: HostBridge;
  /** Injected in a test; the browser gets the real ELK worker. */
  layoutClient?: LayoutClient;
  /** Overlays on at startup. Empty by default: §11's overlays are opt-in layers. */
  initialOverlays?: readonly OverlayName[];
}

export function App({ bridge, layoutClient, initialOverlays = [] }: AppProps): JSX.Element {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [view, setView] = useState<AggregatedView | null>(null);
  const [error, setError] = useState<BridgeError | null>(null);
  const [busy, setBusy] = useState(true);
  const [layout, setLayout] = useState<number | null | { failed: string }>(null);
  const [state, dispatch] = useReducer(reduce, initialState({ up: 2, down: 3 }));

  const [overlayData, setOverlayData] = useState<OverlayData | null>(null);
  const [active, setActive] = useState<ReadonlySet<OverlayName>>(() => new Set(initialOverlays));
  const [selected, setSelected] = useState<string | null>(null);
  const [inspection, setInspection] = useState<NodeInspection | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const client = useMemo(() => layoutClient ?? new LayoutClient(browserEngine()), [layoutClient]);
  useEffect(() => () => { client.dispose(); }, [client]);

  // The palette the canvas draws with, so the badge strips are coloured from
  // the same theme the nodes are (§11: no hard-coded hex, either side).
  const palette = useMemo(() => readDocumentPalette(), []);

  // §9 rule 4's hop defaults come from the engine, not from a constant here.
  const applied = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void bridge
      .meta()
      .then((loaded) => {
        if (cancelled) return;
        setMeta(loaded);
        if (!applied.current) {
          applied.current = true;
          dispatch({ type: 'hops', up: loaded.callDefaults.up, down: loaded.callDefaults.down });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled && cause instanceof BridgeError) setError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // Review state and imported findings: two small files, read once. They are
  // not the graph (§9 rule 1) — they are keyed by node id and carry no source.
  useEffect(() => {
    let cancelled = false;
    void bridge
      .overlays()
      .then((loaded) => {
        if (!cancelled) setOverlayData(loaded);
      })
      .catch(() => {
        // An overlay that cannot load is an overlay with nothing to say. The
        // graph is what the user asked for and it is already on screen.
        if (!cancelled) setOverlayData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const request = toRequest(state);
  const key = JSON.stringify(request);

  useEffect(() => {
    if (!ready(state)) {
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void bridge
      .view(request)
      .then((loaded) => {
        if (cancelled) return;
        setView(loaded);
        setError(null);
        setBusy(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof BridgeError ? cause : new BridgeError({ name: 'Error', message: String(cause) }));
        setBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // `key` is the request, serialized: the effect re-runs when what is being
    // asked for changes and not when an unrelated bit of state does.
  }, [bridge, key]);

  useEffect(() => {
    if (selected === null) {
      setInspection(null);
      setInspectError(null);
      return;
    }
    let cancelled = false;
    setInspecting(true);
    void bridge
      .inspect(selected)
      .then((loaded) => {
        if (cancelled) return;
        setInspection(loaded);
        setInspectError(null);
        setInspecting(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setInspection(null);
        setInspectError(cause instanceof Error ? cause.message : String(cause));
        setInspecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, selected]);

  const preset = PRESETS[state.view];
  const elements = useMemo(
    () =>
      view === null || view.view !== state.view
        ? { nodes: [], edges: [] }
        : toElements(view, preset, { active, data: overlayData, palette }),
    [view, preset, state.view, active, overlayData, palette],
  );

  // What each active overlay actually marked in what is on screen. An overlay
  // with nothing to say here says so rather than reading as a clean result.
  const coverage = useMemo(() => {
    if (view === null || active.size === 0) return {};
    const drawn = view.nodes.flatMap((node) => (node.type === 'node' ? [node.node] : []));
    return overlayCoverage(
      drawn,
      active,
      overlayData,
      nodeUncertainty(
        view.edges.map((edge) => ({
          from: edge.from,
          to: edge.to,
          resolution: edge.type === 'aggregate' ? edge.resolution : edge.edge.resolution,
        })),
      ),
    );
  }, [view, active, overlayData]);

  const onPick = useCallback((pick: { kind: string; id: string; path?: string; expanded?: boolean }) => {
    // A click both navigates and selects: §11's inspector is about the thing
    // you just clicked, and a directory is not a node the inspector can answer
    // about — it stands for what is *not* drawn.
    if (pick.kind !== 'Cluster') setSelected(pick.id);
    dispatch({ type: 'pick', ...pick });
  }, []);

  const onFocus = useCallback((id: string, kind: string) => {
    setSelected(id);
    dispatch({ type: 'pick', kind, id });
  }, []);

  const toggleOverlay = useCallback((name: OverlayName) => {
    setActive((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }, []);

  return (
    <div className="ax-app">
      <Toolbar
        meta={meta}
        view={state.view}
        focus={state.focus}
        up={state.up}
        down={state.down}
        busy={busy}
        onView={(next) => {
          dispatch({ type: 'view', view: next });
        }}
        onHops={(hops) => {
          dispatch({ type: 'hops', ...hops });
        }}
        onClearFocus={() => {
          dispatch({ type: 'focus', focus: null });
        }}
      />

      <OverlayBar
        active={active}
        data={overlayData}
        coverage={coverage}
        onToggle={toggleOverlay}
        onClear={() => {
          setActive(new Set());
        }}
      />

      <main className="ax-main">
        <div className="ax-stage">
          <GraphCanvas
            elements={elements}
            preset={preset}
            layoutClient={client}
            onPick={onPick}
            onLayout={setLayout}
          />

          {!ready(state) ? (
            <div className="ax-notice">
              <strong>{preset.label} needs a focus node.</strong>
              <p>
                §9 rule 4: the function-level call graph always requires one. Open the protocol map,
                click a contract, then click one of its functions.
              </p>
            </div>
          ) : null}

          {error === null && ready(state) && view !== null && view.elements === 0 ? (
            // §9 rule 2 gives "too much to draw" a notice and says nothing
            // about "nothing to draw" — but a blank canvas is the one state a
            // user cannot tell from a broken one, and this tool's whole
            // argument is that it says what it found.
            <div className="ax-notice">
              <strong>Nothing to draw</strong>
              <p>{view.note}</p>
            </div>
          ) : null}

          {error === null ? null : (
            <div className={error.isRenderCap ? 'ax-notice ax-notice-cap' : 'ax-notice ax-notice-error'}>
              <strong>{error.isRenderCap ? 'Too much to draw' : error.name}</strong>
              <p>{error.message}</p>
            </div>
          )}
        </div>

        {selected === null ? null : (
          <Inspector
            inspection={inspection}
            busy={inspecting}
            error={inspectError}
            overlays={overlayData}
            onInspect={setSelected}
            onFocus={onFocus}
            onClose={() => {
              setSelected(null);
            }}
          />
        )}
      </main>

      <footer className="ax-status">
        <span className="ax-note">{view === null ? 'loading…' : view.note}</span>
        <span className="ax-metrics">
          {view === null ? '' : `${String(view.elements)} / ${String(view.cap)} elements`}
          {layout === null
            ? ''
            : typeof layout === 'number'
              ? ` · layout ${String(layout)} ms (worker)`
              : ` · layout failed: ${layout.failed}`}
          {busy ? ' · …' : ''}
        </span>
      </footer>
    </div>
  );
}
