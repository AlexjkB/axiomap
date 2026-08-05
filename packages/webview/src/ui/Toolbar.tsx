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
}: ToolbarProps): JSX.Element {
  const preset = PRESETS[view];

  return (
    <header className="ax-toolbar">
      <div className="ax-toolbar-row">
        <span className="ax-brand">axiomap</span>
        <nav className="ax-views">
          {PRESET_ORDER.map((name) => {
            const blocked = PRESETS[name].needsFocus && focus === null;
            return (
              <button
                key={name}
                type="button"
                className={name === view ? 'ax-view ax-view-current' : 'ax-view'}
                disabled={blocked || busy}
                title={blocked ? 'Click a node first — this view needs a focus (§9 rule 4)' : PRESETS[name].hint}
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
            <button type="button" className="ax-chip" onClick={onClearFocus}>
              clear
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

      <div className="ax-toolbar-row ax-subrow">
        <span className="ax-hint">{preset.hint}</span>
        {meta === null ? null : <span className="ax-score">{scoreLine(meta.score)}</span>}
      </div>
    </header>
  );
}
