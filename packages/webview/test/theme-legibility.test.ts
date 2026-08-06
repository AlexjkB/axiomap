/**
 * Phase 8's third exit criterion: "the graph is legible in Dark+, Light+, and
 * one high-contrast theme."
 *
 * ### Legible, as a number
 *
 * §6 says exit criteria are tests rather than vibes, so "legible" is spelled out
 * as contrast ratios against the theme's own background, computed from the
 * palette `style.ts` resolves. Two thresholds, both from WCAG 2.1 because they
 * are the only widely-agreed numbers for this and because a graph node is
 * exactly what 1.4.11 means by a non-text object:
 *
 * - **4.5:1** for text on the editor background (1.4.3, normal text). Node
 *   labels are code identifiers at small sizes, which is the case that rule is
 *   about.
 * - **3:1** for every hue the graph draws a node or an edge with (1.4.11).
 *
 * And one that is not WCAG's: the hues that carry *meaning* must be
 * distinguishable **from each other**, because §11's channel budget spends node
 * hue on what a node is and edge hue on what an edge is. A theme where `reads`
 * and `writes` resolve to the same blue has an overlay that says nothing, and
 * every ratio above would still pass.
 *
 * ### The values are dumped from a real editor, not transcribed
 *
 * `packages/webview/test/themes/*.json` is written by the extension-host suite
 * (`pnpm test:host`) out of a running VS Code, one file per theme. That matters:
 * this file's whole claim is about what real themes do, and the previous version
 * of these values lived in a screenshot script as a hand-typed table — a guess
 * about the thing under test. It also found the one thing nobody would have
 * guessed, recorded below.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PALETTE_VARIABLES, readPalette, type Palette } from '../src/ui/style.js';

const THEMES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'themes');

interface ThemeDump {
  theme: string;
  values: Record<string, string>;
}

function load(id: string): ThemeDump {
  return JSON.parse(fs.readFileSync(path.join(THEMES_DIR, `${id}.json`), 'utf8')) as ThemeDump;
}

const DUMPS = ['dark-plus', 'light-plus', 'hc-dark'] as const;

// ---------------------------------------------------------------- colour maths

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb`, `#rrggbb`, `rgb(…)` and `rgba(…)` — every form a theme was seen to use. */
export function parseColour(value: string): Rgb | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hex !== null) {
    const digits = hex[1] as string;
    const full =
      digits.length === 3
        ? [...digits].map((d) => d + d).join('')
        : digits.slice(0, 6);
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
  if (rgb !== null) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return null;
}

/**
 * A translucent colour is composited over the background before it is measured.
 *
 * Dark+ and the high-contrast theme both spell `descriptionForeground` as
 * `rgba(255,255,255,0.7)`, and measuring that as opaque white would report a
 * contrast the user never sees.
 */
function over(value: string, background: Rgb): Rgb | null {
  const base = parseColour(value);
  if (base === null) return null;
  const alpha = /^rgba\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+[,\s/]+([\d.]+)\s*\)$/i.exec(value.trim());
  const a = alpha === null ? 1 : Number(alpha[1]);
  return {
    r: base.r * a + background.r * (1 - a),
    g: base.g * a + background.g * (1 - a),
    b: base.b * a + background.b * (1 - a),
  };
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 1:1 to 21:1. */
export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** CIE76 ΔE — "are these two the same colour to a person". */
export function deltaE(a: Rgb, b: Rgb): number {
  const lab = ({ r, g, b: blue }: Rgb): [number, number, number] => {
    const lin = (v: number): number => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [R, G, B] = [lin(r), lin(g), lin(blue)];
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// ------------------------------------------------------------------ the tests

/** Palette entries that are drawn as a shape and must stand off the canvas. */
const SHAPE_HUES: (keyof Palette)[] = [
  'contract',
  'interface',
  'library',
  'fn',
  'state',
  'unresolved',
  'calls',
  'inherits',
  'reads',
  'writes',
  'warning',
  'error',
  'selection',
  'border',
];

/** Hues that carry meaning and must not be confusable with each other (§11). */
const NODE_KIND_HUES: (keyof Palette)[] = [
  'contract',
  'interface',
  'library',
  'fn',
  'state',
  'unresolved',
];
const EDGE_KIND_HUES: (keyof Palette)[] = ['calls', 'inherits', 'reads', 'writes'];

describe('the palette this repo ships against the themes VS Code ships', () => {
  it('dumps every variable style.ts reads', () => {
    // The written-twice pair: the list in `packages/vscode/test-host/suite.ts`
    // decides what gets dumped, and `PALETTE_VARIABLES` decides what gets read.
    // A variable added to the palette and not to the dump list is a hole nobody
    // else would notice — the theme would simply fall back, silently.
    //
    // A superset rather than an equality: the dump also carries
    // `--vscode-font-family`, which `styles.css` uses for UI chrome (§11's "UI
    // chrome uses the theme's UI font") and no TypeScript reads.
    const named = Object.values(PALETTE_VARIABLES)
      .flatMap((entry) => entry.slice(0, -1))
      .filter((value) => value.startsWith('--vscode-'));

    for (const id of DUMPS) {
      const dumped = new Set(Object.keys(load(id).values));
      for (const variable of named) {
        expect(dumped.has(variable), `${id} does not dump ${variable}`).toBe(true);
      }
    }
  });

  describe.each(DUMPS)('%s', (id) => {
    const dump = load(id);
    const palette = readPalette((variable) => dump.values[variable] ?? '');
    const background = parseColour(palette.background);

    it('resolves every entry to a colour the browser can parse', () => {
      expect(background, `${palette.background} is not a colour`).not.toBeNull();
      for (const key of SHAPE_HUES) {
        expect(parseColour(palette[key]), `${key} = ${palette[key]}`).not.toBeNull();
      }
    });

    it('puts labels on the background at 4.5:1 or better (WCAG 1.4.3)', () => {
      const bg = background as Rgb;
      for (const key of ['foreground', 'dim'] as const) {
        const colour = over(palette[key], bg) as Rgb;
        expect(contrast(colour, bg), `${key} = ${palette[key]}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('draws every node and edge hue at 3:1 or better (WCAG 1.4.11)', () => {
      const bg = background as Rgb;
      for (const key of SHAPE_HUES) {
        const colour = over(palette[key], bg) as Rgb;
        expect(contrast(colour, bg), `${key} = ${palette[key]}`).toBeGreaterThanOrEqual(3);
      }
    });

    it('keeps the meaning-carrying hues apart from each other (§11)', () => {
      const bg = background as Rgb;
      // The measured minimum across the three themes is **ΔE 21.7**
      // (`state` vs `unresolved` in high contrast, where `state` falls back to
      // the literal because that theme sets no `--vscode-charts-orange`); the
      // two Plus themes sit at 33–35. The threshold is 12, deliberately well
      // under the data: this is here to catch two roles *collapsing onto one
      // colour*, not to track a theme's palette drifting a few units.
      const apart = (group: (keyof Palette)[]): void => {
        for (let i = 0; i < group.length; i += 1) {
          for (let j = i + 1; j < group.length; j += 1) {
            const a = group[i] as keyof Palette;
            const b = group[j] as keyof Palette;
            const distance = deltaE(over(palette[a], bg) as Rgb, over(palette[b], bg) as Rgb);
            expect(distance, `${a} (${palette[a]}) vs ${b} (${palette[b]})`).toBeGreaterThan(12);
          }
        }
      };
      apart(NODE_KIND_HUES);
      apart(EDGE_KIND_HUES);
    });
  });
});
