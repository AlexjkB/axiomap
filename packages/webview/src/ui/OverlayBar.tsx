/**
 * The overlay switches, and the legend that keeps them readable.
 *
 * §11 makes overlays "toggleable styling layers, combinable via badges", and
 * combinable is the hard part: eight of them at once is only legible because
 * each owns a channel. So the strip names the channel next to the switch, and
 * the legend prints the entries of exactly the overlays that are on — a glyph
 * nobody can decode is the same as no glyph.
 *
 * Two overlays read files the host may not have. Rather than disabling those
 * switches, they stay on and say what is missing: "no review state" is a fact
 * about the project worth showing, and a greyed-out control that explains
 * nothing teaches the user less than the empty answer does.
 */

import type { OverlayData } from '@axiomap/core';

import { OVERLAYS, type LegendEntry, type OverlayName } from './overlays.js';

export interface OverlayBarProps {
  active: ReadonlySet<OverlayName>;
  data: OverlayData | null;
  /**
   * Drawn nodes each active overlay decorated, from `overlayCoverage`. Zero is
   * worth printing: six of the eight overlays are about functions, and the
   * protocol map draws contracts, so an overlay can be on and silent.
   */
  coverage: Record<string, number>;
  onToggle: (name: OverlayName) => void;
  onClear: () => void;
}

function Swatch({ entry }: { entry: LegendEntry }): JSX.Element {
  if (entry.glyph !== undefined) {
    return (
      <span
        className={
          `ax-badge ax-tone-${entry.tone ?? 'dim'}` + (entry.faded === true ? ' ax-badge-faded' : '')
        }
      >
        {entry.glyph}
      </span>
    );
  }
  return <span className={`ax-swatch ${entry.swatch ?? ''}`} />;
}

/** What the host actually has, for the two file-backed overlays. */
function sourceNote(name: OverlayName, data: OverlayData | null): string | null {
  if (data === null) return null;
  if (name === 'review') {
    if (!data.sources.review) return 'no .axiomap/review.json — nothing has been reviewed yet';
    const { reviewed, flagged, followUp, stale, orphaned } = data.summary;
    return (
      `${String(reviewed)} reviewed · ${String(flagged)} flagged · ${String(followUp)} follow-up · ` +
      `${String(stale)} stale` +
      (orphaned === 0 ? '' : ` · ${String(orphaned)} orphaned (the node is gone)`)
    );
  }
  if (name === 'findings') {
    if (!data.sources.findings) {
      return 'no .axiomap/findings.json — run "axiomap import-findings <slither.json>"';
    }
    return (
      `${String(data.summary.findings)} imported` +
      (data.summary.findingsStale === 0
        ? ''
        : ` · ${String(data.summary.findingsStale)} stale since the scan`)
    );
  }
  return null;
}

/**
 * What an overlay that decorated nothing should say.
 *
 * Not "no findings" — the honest statement is that this view has nothing for it
 * to mark, and where to look instead. A collapsed directory is the same case
 * for a different reason: the aggregation layer sends counts, not the
 * attributes of what it is hiding.
 */
function silence(name: OverlayName): string {
  if (name === 'review' || name === 'findings') {
    return 'nothing in this view — entries are on functions; open a contract';
  }
  if (name === 'resolution') return 'nothing uncertain in this view';
  return 'nothing in this view — this overlay is about functions; open a contract';
}

export function OverlayBar({
  active,
  data,
  coverage,
  onToggle,
  onClear,
}: OverlayBarProps): JSX.Element {
  const shown = OVERLAYS.filter((overlay) => active.has(overlay.name));

  return (
    <div className="ax-overlays">
      <div className="ax-toolbar-row ax-overlay-row">
        <span className="ax-label">overlays</span>
        {OVERLAYS.map((overlay) => (
          <button
            key={overlay.name}
            type="button"
            className={active.has(overlay.name) ? 'ax-chip ax-chip-on' : 'ax-chip'}
            aria-pressed={active.has(overlay.name)}
            title={`${overlay.hint}\n\nChannel: ${overlay.channel} (AXIOMAP.md §11)`}
            onClick={() => {
              onToggle(overlay.name);
            }}
          >
            {overlay.label}
          </button>
        ))}
        {active.size === 0 ? null : (
          <button type="button" className="ax-chip ax-chip-clear" onClick={onClear}>
            none
          </button>
        )}
      </div>

      {shown.length === 0 ? null : (
        <div className="ax-legend">
          {shown.map((overlay) => {
            const note = sourceNote(overlay.name, data);
            const drew = coverage[overlay.name] ?? 0;
            return (
              <div key={overlay.name} className="ax-legend-group">
                <span className="ax-legend-title">{overlay.label}</span>
                {drew === 0 ? (
                  <span className="ax-legend-silent">{silence(overlay.name)}</span>
                ) : (
                  overlay.legend.map((entry) => (
                    <span key={entry.label} className="ax-legend-entry">
                      <Swatch entry={entry} />
                      {entry.label}
                    </span>
                  ))
                )}
                {note === null ? null : <span className="ax-legend-note">{note}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
