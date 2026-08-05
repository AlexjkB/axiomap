/**
 * §11's badge channel, drawn.
 *
 * "Node badges (corner glyphs, stackable)" is the only channel in §11's budget
 * that is not a property cytoscape already has. Cytoscape gives a node one
 * label and one set of background images, so a stack of badges is one image:
 * this builds an SVG strip of glyph chips and hands it over as a data URI,
 * anchored to the node's top-right corner.
 *
 * Why an SVG rather than a second label line: a label is one colour, and these
 * glyphs are the difference between a `delegatecall` and a stale informational
 * finding. Colour is the thing that makes a badge readable at a glance, and §11
 * says colour is semantic, never decorative.
 *
 * The strip is built from a palette that was itself read from the host's theme,
 * so this file hard-codes no colour — only geometry.
 */

import type { Badge, Tone } from './overlays.js';
import type { Palette } from './style.js';

/**
 * One chip, in graph units.
 *
 * Sized by looking: at 13 it was a smudge once the protocol map's fit put the
 * view at 0.6 zoom, which is the zoom a contract of any size is actually read
 * at. §11 wants the label legible, not the badges invisible.
 */
export const BADGE_SIZE = 16;
const BADGE_GAP = 2;

export function badgeStripWidth(count: number): number {
  return count === 0 ? 0 : count * BADGE_SIZE + (count - 1) * BADGE_GAP;
}

export function toneColour(palette: Palette, tone: Tone): string {
  switch (tone) {
    case 'danger':
      return palette.error;
    case 'warn':
      return palette.warning;
    case 'info':
      return palette.contract;
    case 'ok':
      return palette.library;
    case 'dim':
      return palette.dim;
  }
}

/** XML text nodes and attribute values; a glyph is `$` or `!`, never markup. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface BadgeStrip {
  /** A `data:image/svg+xml` URI, ready for cytoscape's `background-image`. */
  image: string;
  width: number;
  height: number;
}

/**
 * The strip, as a data URI.
 *
 * `encodeURIComponent` rather than base64: colours arrive as `#4a9cd6` and a
 * raw `#` inside a data URI truncates it at the fragment — which draws nothing
 * and explains nothing, the failure mode Phase 7b spent an afternoon on.
 */
export function badgeStrip(badges: readonly Badge[], palette: Palette): BadgeStrip | null {
  if (badges.length === 0) return null;

  const width = badgeStripWidth(badges.length);
  const chips = badges
    .map((badge, index) => {
      const x = index * (BADGE_SIZE + BADGE_GAP);
      const colour = toneColour(palette, badge.tone);
      return (
        `<rect x="${String(x + 0.5)}" y="0.5" width="${String(BADGE_SIZE - 1)}" height="${String(BADGE_SIZE - 1)}" ` +
        `rx="2" fill="${escape(palette.panel)}" stroke="${escape(colour)}" stroke-width="1"/>` +
        `<text x="${String(x + BADGE_SIZE / 2)}" y="${String(BADGE_SIZE / 2)}" fill="${escape(colour)}" ` +
        `font-family="${escape(palette.fontFamily)}" font-size="9" font-weight="bold" ` +
        `text-anchor="middle" dominant-baseline="central">${escape(badge.glyph)}</text>`
      );
    })
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(BADGE_SIZE)}" ` +
    `viewBox="0 0 ${String(width)} ${String(BADGE_SIZE)}">${chips}</svg>`;

  return {
    image: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    width,
    height: BADGE_SIZE,
  };
}
