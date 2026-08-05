/**
 * The application: one bridge, one navigation state, one canvas.
 *
 * Everything it knows about the graph arrived through `HostBridge.view`, which
 * is `selectAggregatedView` on the other side of a transport (§9 rule 1). There
 * is no second door — no full graph in memory, no client-side filtering of one,
 * no second copy of the query API. When this component needs a different
 * subgraph it asks for one.
 *
 * The status bar is the honest half of §9: it prints what was aggregated and
 * why (`view.note`), and when the host refuses a request because it would not
 * be legible, it prints the refusal with the way out rather than drawing a
 * hairball (rule 2).
 */

import type { AggregatedView, ProjectMeta } from '@axiomap/core';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { BridgeError, type HostBridge } from '../bridge.js';
import { GraphCanvas } from './GraphCanvas.js';
import { toElements } from './elements.js';
import { LayoutClient, browserWorker } from './layout/client.js';
import { initialState, reduce, ready, toRequest } from './navigation.js';
import { PRESETS } from './presets.js';
import { Toolbar } from './Toolbar.js';

export interface AppProps {
  bridge: HostBridge;
  /** Injected in a test; the browser gets the real ELK worker. */
  layoutClient?: LayoutClient;
}

export function App({ bridge, layoutClient }: AppProps): JSX.Element {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [view, setView] = useState<AggregatedView | null>(null);
  const [error, setError] = useState<BridgeError | null>(null);
  const [busy, setBusy] = useState(true);
  const [layoutMs, setLayoutMs] = useState<number | null>(null);
  const [state, dispatch] = useReducer(reduce, initialState({ up: 2, down: 3 }));

  const client = useMemo(() => layoutClient ?? new LayoutClient(browserWorker()), [layoutClient]);
  useEffect(() => () => { client.dispose(); }, [client]);

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

  const preset = PRESETS[state.view];
  const elements = useMemo(
    () => (view === null || view.view !== state.view ? { nodes: [], edges: [] } : toElements(view, preset)),
    [view, preset, state.view],
  );

  const onPick = useCallback((pick: { kind: string; id: string; path?: string; expanded?: boolean }) => {
    dispatch({ type: 'pick', ...pick });
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

      <main className="ax-main">
        <GraphCanvas
          elements={elements}
          preset={preset}
          layoutClient={client}
          onPick={onPick}
          onLayout={setLayoutMs}
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

        {error === null ? null : (
          <div className={error.isRenderCap ? 'ax-notice ax-notice-cap' : 'ax-notice ax-notice-error'}>
            <strong>{error.isRenderCap ? 'Too much to draw' : error.name}</strong>
            <p>{error.message}</p>
          </div>
        )}
      </main>

      <footer className="ax-status">
        <span className="ax-note">{view === null ? 'loading…' : view.note}</span>
        <span className="ax-metrics">
          {view === null ? '' : `${String(view.elements)} / ${String(view.cap)} elements`}
          {layoutMs === null ? '' : ` · layout ${String(layoutMs)} ms (worker)`}
          {busy ? ' · …' : ''}
        </span>
      </footer>
    </div>
  );
}
