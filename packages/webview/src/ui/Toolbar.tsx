/**
 * The chrome: which view, what it is focused on, and how certain the graph is.
 *
 * §11's direction is "dense and technical — Bloomberg terminal, Datadog, htop",
 * so this is a two-row strip of controls and facts rather than a sidebar. The
 * mode and score are on it permanently and not behind a panel, because §4 wants
 * the tool to "see honestly how much of the graph is certain vs. inferred"
 * without being asked (§15's second item).
 *
 * Views a focus is required for (§9 rule 4) are disabled rather than hidden, and
 * they say what they need — a hidden control teaches the user nothing about why.
 */

import type { ProjectMeta, ViewName } from '@axiomap/core';

import { PRESET_ORDER, PRESETS } from './presets.js';
import { TRAITS, type Trait } from './filter.js';

export interface ToolbarProps {
  meta: ProjectMeta | null;
  view: ViewName;
  focus: string | null;
  up: number;
  down: number;
  busy: boolean;
  onView: (view: ViewName) => void;
  onHops: (hops: { up: number; down: number }) => void;
  onClearFocus: () => void;
  /**
   * The function traits currently being shown, and the toggle for one.
   *
   * `showTraits` is false on a view that draws no functions. The row is still
   * rendered then, with its chips disabled and saying why — this file's own
   * rule for the focus-dependent tabs, for the same two reasons. A hidden
   * control teaches nobody what it was for, and a row that comes and goes
   * changes the toolbar's height between views, which resizes the canvas under
   * the graph.
   *
   * Empty set means everything, which is the state the row starts in.
   */
  showTraits: boolean;
  traits: ReadonlySet<Trait>;
  onTrait: (trait: Trait) => void;
}

/**
 * §4's score, in §4's own words.
 *
 * The same sentence `describeScore` prints on every build — deliberately, since
 * an auditor who has read it in the terminal should not have to learn a second
 * phrasing for the same number. It is rebuilt here rather than imported because
 * §5 lets this package have core's types and not its functions.
 */
export function scoreLine(score: ProjectMeta['score']): string {
  const overall = score.overall;
  if (overall.total === 0) return '0 edges — nothing to resolve.';
  const share = (value: number): string =>
    `${String(Math.round((value / overall.total) * 100))}%`;
  return (
    `${overall.total.toLocaleString('en-US')} edges — ${share(overall.semantic)} semantic, ` +
    `${share(overall.heuristic)} heuristic, ${share(overall.ambiguous)} ambiguous, ` +
    `${share(overall.unresolved)} unresolved`
  );
}

export function Toolbar({
  meta,
  view,
  focus,
  up,
  down,
  busy,
  onView,
  onHops,
  onClearFocus,
  showTraits,
  traits,
  onTrait,
}: ToolbarProps): JSX.Element {
  const preset = PRESETS[view];

  return (
    <header className="ax-toolbar">
      <div className="ax-toolbar-row">
        <nav className="ax-views">
          {PRESET_ORDER.map((name) => {
            const blocked = PRESETS[name].needsFocus && focus === null;
            /*
             * §4's other half: the call graph does not survive structural mode,
             * and the view is *disabled with an explanation* rather than left
             * live to answer with an empty canvas. `modeReason` is the sentence
             * the engine already wrote about this project, so the tooltip says
             * why this project rather than why in general.
             */
            const withheld = name === 'call' && meta?.mode === 'structural';
            return (
              <button
                key={name}
                type="button"
                className={name === view ? 'ax-view ax-view-current' : 'ax-view'}
                disabled={blocked || withheld || busy}
                title={
                  withheld
                    ? `No call graph in structural mode. ${meta?.modeReason ?? ''}`
                    : blocked
                      ? 'Click a node first — this view needs a focus (§9 rule 4)'
                      : PRESETS[name].hint
                }
                onClick={() => {
                  onView(name);
                }}
              >
                {PRESETS[name].label}
              </button>
            );
          })}
        </nav>

        {focus === null ? null : (
          <span className="ax-focus" title={focus}>
            <span className="ax-label">focus</span>
            <code>{focus}</code>
            {/* The way *out* of a focus, and the only one on screen.
                Deliberately louder than a plain chip: the focus arrives by
                clicking a contract, which a first-time user does within
                seconds, and until it is cleared two of the five tabs behave
                differently and the graph is dimmed. A control that undoes a
                state the user did not knowingly enter has to be findable
                without being looked for — the ✕ and the noun are what make it
                read as "get rid of this" rather than as another chip. */}
            <button
              type="button"
              className="ax-chip ax-clear"
              title="Clear the focus — back to the whole protocol map, undimmed"
              onClick={onClearFocus}
            >
              <span aria-hidden="true">✕</span> clear focus
            </button>
          </span>
        )}

        {view === 'call' ? (
          <span className="ax-hops">
            <span className="ax-label">hops</span>
            <label>
              up
              <input
                type="number"
                min={0}
                max={6}
                value={up}
                onChange={(event) => {
                  onHops({ up: Number(event.target.value), down });
                }}
              />
            </label>
            <label>
              down
              <input
                type="number"
                min={0}
                max={6}
                value={down}
                onChange={(event) => {
                  onHops({ up, down: Number(event.target.value) });
                }}
              />
            </label>
          </span>
        ) : null}

        {meta === null ? null : (
          <span className={`ax-mode ax-mode-${meta.mode}`} title={meta.modeReason}>
            {meta.mode}
          </span>
        )}
      </div>

      <div className="ax-toolbar-row ax-subrow ax-filters">
        <span className="ax-label">show</span>
        {TRAITS.map((trait) => {
          const on = showTraits && traits.has(trait);
          return (
            <button
              key={trait}
              type="button"
              className="ax-chip"
              aria-pressed={on}
              disabled={!showTraits}
              title={
                !showTraits
                  ? `${PRESETS[view].label} draws no functions, so there is nothing to narrow`
                  : on
                    ? `Stop singling out ${trait} functions`
                    : `Show only ${trait} functions (with any others ticked)`
              }
              onClick={() => {
                onTrait(trait);
              }}
            >
              {trait}
            </button>
          );
        })}
        {/* The way back to the whole graph, and the only thing on the row that
            says the graph is currently narrowed. */}
        {!showTraits || traits.size === 0 ? (
          <span className="ax-label ax-filter-all">all</span>
        ) : (
          <button
            type="button"
            className="ax-chip ax-clear"
            title="Show every function again"
            onClick={() => {
              for (const trait of TRAITS) if (traits.has(trait)) onTrait(trait);
            }}
          >
            <span aria-hidden="true">✕</span> show all
          </button>
        )}
      </div>

      <div className="ax-toolbar-row ax-subrow">
        {/* Ellipsized when the panel is narrow, so the full sentence has to be
            reachable somehow — a hint nobody can finish reading is not a hint. */}
        <span className="ax-hint" title={preset.hint}>
          {preset.hint}
        </span>
        {meta === null ? null : <span className="ax-score">{scoreLine(meta.score)}</span>}
      </div>
    </header>
  );
}
