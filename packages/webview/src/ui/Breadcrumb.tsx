/**
 * §11's breadcrumb, and the back/forward controls it belongs with.
 *
 * The trail is `history.entries` — see `history.ts` for why a trail rather than
 * a containment path — so the crumbs and the arrows cannot disagree: they are
 * two renderings of one index into one array.
 *
 * Crumbs behind the current one are the way back; crumbs ahead of it are where
 * you were before going back, and they are drawn dimmed rather than hidden. A
 * forward arrow that lights up with nothing visible to explain it is the kind
 * of chrome that teaches a user nothing.
 */

import type { HistoryState } from './history.js';
import { canGoBack, canGoForward, shortName } from './history.js';
import { PRESETS } from './presets.js';

export interface BreadcrumbProps {
  history: HistoryState;
  onBack: () => void;
  onForward: () => void;
  onJump: (index: number) => void;
}

/** What one visited place is called. The view, plus what it was looking at. */
export function crumbLabel(state: HistoryState['entries'][number]): string {
  const label = PRESETS[state.view].label;
  if (state.focus !== null) return `${label}: ${shortName(state.focus)}`;
  if (state.expand.length > 0) {
    // The protocol map with directories open is a different place from the
    // protocol map without them, and the deepest one is the one you drilled to.
    const deepest = [...state.expand].sort((a, b) => b.split('/').length - a.split('/').length)[0];
    return `${label}: ${String(deepest)}`;
  }
  return label;
}

export function Breadcrumb({ history, onBack, onForward, onJump }: BreadcrumbProps): JSX.Element {
  return (
    <nav className="ax-crumbs" aria-label="History">
      <button
        type="button"
        className="ax-chip"
        disabled={!canGoBack(history)}
        title="Back (Alt+←)"
        onClick={onBack}
      >
        ←
      </button>
      <button
        type="button"
        className="ax-chip"
        disabled={!canGoForward(history)}
        title="Forward (Alt+→)"
        onClick={onForward}
      >
        →
      </button>

      <ol className="ax-crumb-list">
        {history.entries.map((entry, index) => {
          const state =
            index === history.index ? 'current' : index < history.index ? 'past' : 'ahead';
          return (
            <li key={`${String(index)}:${entry.view}:${entry.focus ?? ''}`}>
              <button
                type="button"
                className={`ax-crumb ax-crumb-${state}`}
                aria-current={index === history.index ? 'page' : undefined}
                onClick={() => {
                  onJump(index);
                }}
              >
                {crumbLabel(entry)}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
