/**
 * The stylesheet, and the palette it reads.
 *
 * ### Colour comes from the host's theme, always
 *
 * §11: "Palette derives entirely from VS Code CSS variables. No hard-coded
 * hex." §7's Phase 8 adds the reason it has to be designed *now*: "Design the
 * browser-mode palette in Phase 7 as a *fallback* that maps onto these
 * variables, not as a separate design." So there is one palette, every entry of
 * it is a `--vscode-*` variable, and the hex in `FALLBACK_PALETTE` is what a
 * browser with no VS Code around it resolves those variables to. Phase 8 sets
 * the variables and this file does not change.
 *
 * Cytoscape parses colours itself and cannot read `var(--x)`, which is why the
 * palette is resolved once against the document rather than written into the
 * stylesheet as CSS.
 *
 * ### Channels are allocated, not chosen per rule
 *
 * §11's channel budget is a contract, and Phase 7b holds to the part of it the
 * views themselves need: **edge colour is edge kind**, **edge style is
 * resolution confidence**, **edge weight is call-site count**, **node border
 * style is resolution confidence**. The channels the overlays own — node fill
 * (review state), border colour (access control), opacity (reachability),
 * badges, size — are deliberately left neutral here. An overlay that arrives
 * later finds its channel free, which is the entire point of the table.
 *
 * The one exception is §11's own words for the state-access map: "reads blue /
 * writes orange". That is the view, not an overlay, and it is spelled out in
 * §11's numbered list rather than in its overlay list.
 */

import type { StylesheetJson } from 'cytoscape';

import type { ViewPreset } from './presets.js';

export interface Palette {
  background: string;
  foreground: string;
  dim: string;
  border: string;
  panel: string;
  /** Node hues, by what the node is. */
  contract: string;
  interface: string;
  library: string;
  fn: string;
  state: string;
  unresolved: string;
  cluster: string;
  /** Edge hues, by edge kind (§11's channel budget). */
  calls: string;
  inherits: string;
  reads: string;
  writes: string;
  other: string;
  warning: string;
  selection: string;
  fontFamily: string;
}

/**
 * What each palette entry is spelled as in a VS Code theme, and what it falls
 * back to in a browser. The fallback is the browser-mode design; the variable
 * is Phase 8's, and it wins whenever it is set.
 */
export const PALETTE_VARIABLES: Record<keyof Palette, readonly [string, string]> = {
  background: ['--vscode-editor-background', '#0f1319'],
  foreground: ['--vscode-editor-foreground', '#d7dde5'],
  dim: ['--vscode-descriptionForeground', '#8b98a8'],
  border: ['--vscode-panel-border', '#2b333d'],
  panel: ['--vscode-editorWidget-background', '#161b22'],
  contract: ['--vscode-charts-blue', '#4a9cd6'],
  interface: ['--vscode-charts-purple', '#a074c4'],
  library: ['--vscode-charts-green', '#4fae6a'],
  fn: ['--vscode-charts-foreground', '#c3ccd8'],
  state: ['--vscode-charts-orange', '#d19a4c'],
  unresolved: ['--vscode-editorWarning-foreground', '#c9a227'],
  cluster: ['--vscode-editorGroup-border', '#3a4450'],
  calls: ['--vscode-charts-foreground', '#93a1b1'],
  inherits: ['--vscode-charts-purple', '#a074c4'],
  reads: ['--vscode-charts-blue', '#4a9cd6'],
  writes: ['--vscode-charts-orange', '#d19a4c'],
  other: ['--vscode-descriptionForeground', '#6f7c8b'],
  warning: ['--vscode-editorWarning-foreground', '#c9a227'],
  selection: ['--vscode-focusBorder', '#3f8fd0'],
  fontFamily: ['--vscode-editor-font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace'],
};

export const FALLBACK_PALETTE: Palette = readPaletteFrom(() => '');

/**
 * Resolve the palette against whatever the host set.
 *
 * `read` is `getComputedStyle(el).getPropertyValue` in the browser and a stub in
 * a test — the resolution rule is the interesting part and it should not need a
 * DOM to check.
 */
export function readPalette(read: (variable: string) => string): Palette {
  return readPaletteFrom(read);
}

function readPaletteFrom(read: (variable: string) => string): Palette {
  const resolve = (key: keyof Palette): string => {
    const [variable, fallback] = PALETTE_VARIABLES[key];
    const value = read(variable).trim();
    return value === '' ? fallback : value;
  };
  return {
    background: resolve('background'),
    foreground: resolve('foreground'),
    dim: resolve('dim'),
    border: resolve('border'),
    panel: resolve('panel'),
    contract: resolve('contract'),
    interface: resolve('interface'),
    library: resolve('library'),
    fn: resolve('fn'),
    state: resolve('state'),
    unresolved: resolve('unresolved'),
    cluster: resolve('cluster'),
    calls: resolve('calls'),
    inherits: resolve('inherits'),
    reads: resolve('reads'),
    writes: resolve('writes'),
    other: resolve('other'),
    warning: resolve('warning'),
    selection: resolve('selection'),
    fontFamily: resolve('fontFamily'),
  };
}

/**
 * §4's four confidences, as the four line treatments it names: "solid /
 * solid-thin / dashed-fanned / dotted-muted".
 */
export const RESOLUTION_LINE: Record<string, { style: 'solid' | 'dashed' | 'dotted'; opacity: number }> = {
  semantic: { style: 'solid', opacity: 1 },
  heuristic: { style: 'solid', opacity: 0.85 },
  ambiguous: { style: 'dashed', opacity: 0.85 },
  unresolved: { style: 'dotted', opacity: 0.55 },
};

export function stylesheet(palette: Palette, preset: ViewPreset): StylesheetJson {
  const label = {
    'font-family': palette.fontFamily,
    'font-size': 11,
    color: palette.foreground,
    'text-valign': 'center' as const,
    'text-halign': 'center' as const,
    'text-wrap': 'wrap' as const,
  };

  const sheet: StylesheetJson = [
    {
      selector: 'node',
      style: {
        ...label,
        shape: 'round-rectangle',
        'background-color': palette.panel,
        'background-opacity': 1,
        'border-width': 1,
        'border-color': palette.border,
        width: 'label',
        height: 'label',
        padding: '8px',
        // `display` is the two lines already joined (see `elements.ts`): one
        // cytoscape label holds them both, because there is no rich text.
        label: 'data(display)',
      },
    },
    // §11: node labels are code identifiers and should look like code. The
    // second line is chrome, so it is dimmed by the only channel a single
    // cytoscape label has — there is no rich text — which is why `detail` is
    // short enough to read as a subtitle.
    { selector: 'node[kind = "Contract"]', style: { 'border-color': palette.contract, 'border-width': 2 } },
    { selector: 'node.contract-interface', style: { 'border-color': palette.interface } },
    { selector: 'node.contract-library', style: { 'border-color': palette.library } },
    { selector: 'node.contract-abstract', style: { 'border-style': 'dashed' } },
    { selector: 'node[kind = "Function"]', style: { 'border-color': palette.fn } },
    { selector: 'node[kind = "StateVariable"]', style: { 'border-color': palette.state, shape: 'rectangle' } },
    {
      selector: 'node[kind = "Unresolved"]',
      style: {
        'border-color': palette.unresolved,
        'border-style': 'dotted',
        color: palette.dim,
        shape: 'diamond',
      },
    },
    {
      selector: 'node.cluster',
      style: {
        shape: 'round-rectangle',
        'background-color': palette.background,
        'background-opacity': 0.4,
        'border-color': palette.cluster,
        'border-width': 1,
        'text-valign': 'top',
        'text-halign': 'center',
        'font-size': 12,
        color: palette.dim,
        padding: '14px',
      },
    },
    {
      selector: 'node.cluster.collapsed',
      style: {
        'background-opacity': 0.9,
        'background-color': palette.panel,
        'border-width': 2,
        'border-style': 'double',
        'text-valign': 'center',
        color: palette.foreground,
      },
    },
    { selector: 'node.focusable', style: { 'font-weight': 'bold' } },
    {
      selector: 'node:selected',
      style: { 'border-color': palette.selection, 'border-width': 3 },
    },

    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'line-color': palette.calls,
        'target-arrow-color': palette.calls,
        width: 'data(width)',
        label: 'data(label)',
        'font-family': palette.fontFamily,
        'font-size': 9,
        color: palette.dim,
        'text-background-color': palette.background,
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
      },
    },
    { selector: 'edge.edge-inherits', style: { 'line-color': palette.inherits, 'target-arrow-color': palette.inherits, 'target-arrow-shape': 'triangle-tee' } },
    { selector: 'edge.edge-overrides, edge.edge-implements', style: { 'line-color': palette.inherits, 'target-arrow-color': palette.inherits, 'line-style': 'dashed' } },
    { selector: 'edge.edge-reads', style: { 'line-color': palette.reads, 'target-arrow-color': palette.reads } },
    { selector: 'edge.edge-writes', style: { 'line-color': palette.writes, 'target-arrow-color': palette.writes } },
    {
      selector: 'edge.edge-emits, edge.edge-reverts, edge.edge-modifiedBy, edge.edge-declares',
      style: { 'line-color': palette.other, 'target-arrow-color': palette.other },
    },
    { selector: 'edge.aggregate', style: { 'line-style': 'solid', 'arrow-scale': 1.1 } },
    { selector: 'edge.cross-trust', style: { 'line-dash-pattern': [8, 3] } },
  ];

  // §4's confidence, on the channel §11 gives it. Applied last so it wins over
  // the kind rules above, which own colour rather than line style.
  for (const [resolution, line] of Object.entries(RESOLUTION_LINE)) {
    sheet.push({
      selector: `edge.res-${resolution}`,
      style: { 'line-style': line.style, opacity: line.opacity },
    });
  }

  if (preset.partitioned) {
    // §11 names the two hues for this view; the edges already carry the kind.
    sheet.push({
      selector: 'node[kind = "StateVariable"]',
      style: { 'border-width': 2 },
    });
  }

  return sheet;
}
