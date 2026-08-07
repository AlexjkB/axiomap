/**
 * The application: one bridge, one navigation state, one canvas, one inspector.
 *
 * Everything it knows about the graph arrived through `HostBridge` — `view` for
 * the drawn subgraph (§9 rule 1), `inspect` for one node's attributes and
 * relations (§11), `overlays` for the two audit-state files the host reads and
 * the inspector shows.
 * There is no second door: no full graph in memory, no client-side filtering of
 * one, no second copy of the query API. When this component needs a different
 * subgraph, or anything about a node it is not drawing, it asks.
 *
 * The status bar is the honest half of §9: it prints what was aggregated and
 * why (`view.note`), and when the host refuses a request because it would not
 * be legible, it prints the refusal with the way out rather than drawing a
 * hairball (rule 2).
 */

import type {
  AggregatedView,
  NodeInspection,
  OverlayData,
  ProjectMeta,
  SourceSlice,
} from '@axiomap/core';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { BridgeError, type HostBridge } from '../bridge.js';
import type { EditorLink } from '../editor.js';
import { GraphCanvas } from './GraphCanvas.js';
import { Inspector } from './Inspector.js';
import { toElements } from './elements.js';
import { LayoutClient, browserEngine } from './layout/client.js';
import { initialState, ready, reduce, toRequest } from './navigation.js';
import { PRESETS } from './presets.js';
import { SearchPalette } from './SearchPalette.js';
import { readDocumentPalette } from './style.js';
import { Toolbar } from './Toolbar.js';

export interface AppProps {
  bridge: HostBridge;
  /** Injected in a test; the browser gets the real ELK worker. */
  layoutClient?: LayoutClient;
  /**
   * The editor, when the host is one (§11's bidirectional navigation).
   *
   * Optional, and everything below reads as "if there is an editor": browser
   * mode and the HTML export have none, and neither should behave differently
   * for the existence of a host they will never meet.
   */
  editor?: EditorLink;
}

export function App({ bridge, layoutClient, editor }: AppProps): JSX.Element {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [view, setView] = useState<AggregatedView | null>(null);
  const [error, setError] = useState<BridgeError | null>(null);
  const [busy, setBusy] = useState(true);
  const [layout, setLayout] = useState<number | null | { failed: string }>(null);
  // Where the user is. `reduce` is the only thing that decides what a click
  // means (see `navigation.ts`), and this is the state it produces.
  const [state, dispatch] = useReducer(reduce, initialState({ up: 2, down: 3 }));
  const [paletteOpen, setPaletteOpen] = useState(false);
  /*
   * Phase 8's artifact watch, as one number.
   *
   * The host rebuilt the graph, so every answer this component is holding was
   * about the previous one. Rather than invalidating each piece of state by
   * hand, the generation goes into the dependency list of every request effect
   * — which is the same trick `key` already plays for the view request, and it
   * means a request added later is refreshed by construction rather than by
   * somebody remembering to add it here.
   */
  const [refreshed, setRefreshed] = useState<{ at: number; reason: string } | null>(null);
  const generation = refreshed === null ? 0 : refreshed.at;

  const [overlayData, setOverlayData] = useState<OverlayData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspection, setInspection] = useState<NodeInspection | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [slice, setSlice] = useState<SourceSlice | null>(null);
  const [sliceError, setSliceError] = useState<string | null>(null);
  const [slicing, setSlicing] = useState(false);

  const client = useMemo(() => layoutClient ?? new LayoutClient(browserEngine()), [layoutClient]);
  useEffect(() => () => { client.dispose(); }, [client]);

  /*
   * The one palette in the app: the canvas and the code preview's syntax theme
   * both take this (§11: no hard-coded hex, anywhere).
   *
   * It is state rather than a `useMemo([])` because **a host can change its
   * theme while this is open**. Phase 8's exit criterion is legibility in
   * Dark+, Light+ and a high-contrast theme, and switching between them is how
   * anyone would check that — VS Code rewrites the `--vscode-*` variables on
   * the document element and swaps a class on the body, without reloading the
   * webview. Read once, the graph would repaint from the new theme on its next
   * update while the code preview kept the old one: a half-themed UI, which is
   * the same class of defect as 7c's "nobody had ever run this with the
   * variables set" and much harder to spot.
   */
  const [palette, setPalette] = useState(readDocumentPalette);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = readDocumentPalette();
      // Replaced only when something actually changed: every mutation of the
      // document element would otherwise rebuild the stylesheet and the shiki
      // grammar.
      setPalette((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-vscode-theme-kind', 'data-vscode-theme-name'],
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => {
      observer.disconnect();
    };
  }, []);

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
  }, [bridge, generation]);

  // Review state and imported findings: two small files, read once, shown in
  // the inspector. They are not the graph (§9 rule 1) — they are keyed by node
  // id and carry no source.
  useEffect(() => {
    let cancelled = false;
    void bridge
      .overlays()
      .then((loaded) => {
        if (!cancelled) setOverlayData(loaded);
      })
      .catch(() => {
        // Audit state that cannot load is audit state with nothing to say. The
        // graph is what the user asked for and it is already on screen.
        if (!cancelled) setOverlayData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, generation]);

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
  }, [bridge, key, generation]);

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
  }, [bridge, selected, generation]);

  /*
   * §11's code preview. A second request rather than a field on the inspection,
   * because it is a different kind of payload — the first thing across this
   * bridge that is the user's *source* rather than something derived from their
   * graph — and because a panel should be able to show a node's attributes
   * while its body is still being read off disk.
   *
   * Three lines of context, so a function does not open flush against the
   * panel's top edge with no sight of what it sits between.
   */
  useEffect(() => {
    if (selected === null) {
      setSlice(null);
      setSliceError(null);
      return;
    }
    let cancelled = false;
    setSlicing(true);
    void bridge
      .source(selected, 3)
      .then((loaded) => {
        if (cancelled) return;
        setSlice(loaded);
        setSliceError(null);
        setSlicing(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setSlice(null);
        // The host's sentence, verbatim: "this is an unresolved placeholder,
        // there is no source to show" is an answer about the graph, and
        // rewording it here would be a second opinion about what was found.
        setSliceError(cause instanceof Error ? cause.message : String(cause));
        setSlicing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, selected, generation]);

  const preset = PRESETS[state.view];
  const elements = useMemo(
    () =>
      view === null || view.view !== state.view
        ? { nodes: [], edges: [] }
        : toElements(view, preset),
    [view, preset, state.view],
  );

  // The clusters the *engine* opened, which is not the same as the ones the
  // user asked for while auto-expansion is still on. The reducer needs it to
  // close one it never explicitly opened.
  const open = view === null ? undefined : view.expanded;

  const onPick = useCallback(
    (pick: { kind: string; id: string; path?: string; expanded?: boolean }) => {
      // A click both navigates and selects: §11's inspector is about the thing
      // you just clicked, and a directory is not a node the inspector can answer
      // about — it stands for what is *not* drawn.
      if (pick.kind !== 'Cluster') {
        setSelected(pick.id);
        // §11: "Click node → reveal in editor." A cluster is a directory and
        // has no declaration to land on.
        editor?.reveal({ kind: 'node', id: pick.id });
      }
      dispatch({ type: 'pick', ...pick, ...(open === undefined ? {} : { open }) });
    },
    [open, editor],
  );

  /**
   * §11: "Click edge → reveal the **call site**."
   *
   * The site, not either endpoint: §10 puts a `src` on every edge precisely so
   * that clicking `deposit → _mint` lands inside `deposit` at the call rather
   * than at `_mint`'s definition. An aggregated edge stands for many sites and
   * carries none, so it navigates nothing — the way to reach one of them is to
   * open the directory it summarises.
   */
  const onPickEdge = useCallback(
    (site: { file: string; line: number; column: number } | null) => {
      if (site !== null) editor?.reveal({ kind: 'site', ...site });
    },
    [editor],
  );

  const onFocus = useCallback(
    (id: string, kind: string) => {
      setSelected(id);
      editor?.reveal({ kind: 'node', id });
      dispatch({ type: 'pick', kind, id });
    },
    [editor],
  );

  /*
   * §11's inverse navigation, and the artifact watch.
   *
   * A cursor landing on a declaration *selects* it: the inspector opens on it
   * and the canvas highlights it if it is drawn. It deliberately does not
   * navigate, and deliberately does not reveal back — see `editor.ts`.
   */
  useEffect(() => {
    if (editor === undefined) return;
    const offSelect = editor.onSelect((id) => {
      setSelected(id);
    });
    // A command, not a cursor: this one navigates. It does not reveal back —
    // the editor is already where the request came from.
    const offFocus = editor.onFocus((id, kind) => {
      setSelected(id);
      dispatch({ type: 'pick', kind, id });
    });
    const offRefresh = editor.onRefresh((reason) => {
      setRefreshed({ at: Date.now(), reason });
    });
    return () => {
      offSelect();
      offFocus();
      offRefresh();
    };
  }, [editor]);

  const search = useCallback((query: string, limit?: number) => bridge.search(query, limit), [bridge]);

  /*
   * §11's `/`.
   *
   * On `document` rather than on a focused element, because the thing the user
   * is looking at is a canvas that cannot hold focus. Guarded against firing
   * while someone is typing in the palette or in the hop steppers — a `/` in a
   * search box is a slash.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.key === 'Escape' && !typing) {
        setPaletteOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
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
        <div className="ax-stage">
          <GraphCanvas
            elements={elements}
            preset={preset}
            layoutClient={client}
            palette={palette}
            selected={selected}
            onPick={onPick}
            onPickEdge={onPickEdge}
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
            slice={slice}
            sliceBusy={slicing}
            sliceError={sliceError}
            palette={palette}
            onInspect={setSelected}
            onFocus={onFocus}
            onClose={() => {
              setSelected(null);
            }}
          />
        )}
      </main>

      <SearchPalette
        open={paletteOpen}
        search={search}
        onPick={(hit) => {
          setPaletteOpen(false);
          // The same two things a click on the canvas does: navigate to the
          // node, and open the inspector on it. Reached from a palette rather
          // than from a drill-down, but §9 rule 4 still holds — `reduce` decides
          // which view a node opens, and it is the only thing that does.
          setSelected(hit.id);
          dispatch({ type: 'pick', kind: hit.kind, id: hit.id });
        }}
        onClose={() => {
          setPaletteOpen(false);
        }}
      />

      <footer className="ax-status">
        <span className="ax-note">
          {refreshed === null ? '' : `${refreshed.reason} · `}
          {view === null ? 'loading…' : view.note}
        </span>
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
