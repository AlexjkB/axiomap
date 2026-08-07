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
 * Colour is semantic, never decorative (§11). **Edge colour is edge kind**,
 * **edge style is resolution confidence**, **edge weight is call-site count**,
 * and node border colour is the node's kind. Each rule below owns one channel,
 * so a node carries at most one class per channel and they do not race.
 *
 * §11's own words for the state-access map — "reads blue / writes orange" — are
 * the view's, and come out of the edge-kind allocation above.
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
  error: string;
  selection: string;
  fontFamily: string;
  /**
   * §11's inline code preview, which needs syntax colours and not graph hues
   * (Phase 7d).
   *
   * A shiki theme is by construction a list of hex values, which is the one
   * thing §11 forbids — so these are read from the host like everything else.
   * They are not the `--vscode-charts-*` the graph uses: VS Code publishes
   * `--vscode-symbolIcon-*Foreground` for exactly these roles (the colours it
   * paints its own outline and completion icons with), so a keyword in this
   * panel is the colour the host calls a keyword rather than a hue borrowed
   * from a chart. Their absence falls back like every other entry, which is
   * what a browser gets.
   */
  syntaxComment: string;
  syntaxKeyword: string;
  syntaxType: string;
  syntaxFunction: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxVariable: string;
}

/**
 * What each palette entry is spelled as in a VS Code theme, and what it falls
 * back to in a browser. The fallback is the browser-mode design; the variable
 * is Phase 8's, and it wins whenever it is set.
 *
 * ### Why some entries name more than one variable
 *
 * The last string is always the literal fallback; everything before it is a
 * variable, tried in order. Most entries name one, because most of what the
 * graph draws with is a `--vscode-charts-*` colour that every theme defines.
 *
 * The syntax entries name two, and Phase 7d found out why by looking: the
 * browser fallbacks are Dark+'s token colours, which are correct against
 * browser mode's own dark background and *illegible* on a host that sets a
 * light editor background without setting `--vscode-symbolIcon-*` — pale yellow
 * on white. A partially-themed host is exactly the case a fallback exists for,
 * so the second variable is a `--vscode-charts-*` one: chosen by the same theme
 * for the same background, and therefore legible against it whatever the first
 * one did. The literal hex is the third rung and only a browser reaches it.
 */
export const PALETTE_VARIABLES: Record<keyof Palette, readonly [string, ...string[]]> = {
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
  error: ['--vscode-editorError-foreground', '#d16969'],
  selection: ['--vscode-focusBorder', '#3f8fd0'],
  fontFamily: ['--vscode-editor-font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace'],
  syntaxComment: ['--vscode-descriptionForeground', '#6f7c8b'],
  syntaxKeyword: ['--vscode-symbolIcon-keywordForeground', '--vscode-charts-purple', '#c586c0'],
  syntaxType: ['--vscode-symbolIcon-classForeground', '--vscode-charts-green', '#4ec9b0'],
  syntaxFunction: ['--vscode-symbolIcon-functionForeground', '--vscode-charts-orange', '#dcdcaa'],
  syntaxString: ['--vscode-symbolIcon-stringForeground', '--vscode-charts-red', '#ce9178'],
  syntaxNumber: ['--vscode-symbolIcon-numberForeground', '--vscode-charts-green', '#b5cea8'],
  syntaxVariable: ['--vscode-symbolIcon-variableForeground', '--vscode-charts-blue', '#9cdcfe'],
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

/** The palette this document resolves to. One place, so the canvas and the badges agree. */
export function readDocumentPalette(): Palette {
  return readPalette((variable) =>
    getComputedStyle(document.documentElement).getPropertyValue(variable),
  );
}

/**
 * The one entry whose job is to be quieter than the foreground, and therefore
 * the one allowed to arrive from the host already translucent.
 */
const KEEPS_ITS_ALPHA = new Set<keyof Palette>(['dim']);

/**
 * Take a host colour at full strength.
 *
 * **Found in Phase 8b, by dumping the variables out of a real editor rather
 * than transcribing them.** Dark+ and Light+ both spell `--vscode-charts-orange`
 * as `rgba(234, 92, 0, 0.33)`, and at a third of an opacity it composites to
 * **1.6:1** against the editor background — well under WCAG 1.4.11's 3:1 for a
 * non-text object, and invisible in practice. That variable is `state` and
 * `writes`: the *orange* half of §11's state access map, "reads blue / writes
 * orange", the view §11 says nothing else does well.
 *
 * A third of an opacity is the right choice for the thing VS Code uses it for —
 * a filled area behind a chart line. It is the wrong choice for a 2px border on
 * a small node. And §11's channel budget has already spent node opacity on
 * reachability dimming, so a hue that arrives pre-faded is not just faint, it is
 * quietly claiming a channel that belongs to something else.
 *
 * So the **hue** is the host's, as §11 requires, and the **opacity** stays ours.
 */
function opaque(value: string): string {
  const rgba = /^rgba\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)[,\s/]+[\d.]+\s*\)$/i.exec(
    value.trim(),
  );
  if (rgba !== null) return `rgb(${rgba[1] ?? '0'}, ${rgba[2] ?? '0'}, ${rgba[3] ?? '0'})`;
  // `#rrggbbaa`, the other form a theme may use.
  const hex8 = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(value.trim());
  return hex8 === null ? value : `#${hex8[1] ?? ''}`;
}

function readPaletteFrom(read: (variable: string) => string): Palette {
  const resolve = (key: keyof Palette): string => {
    // Every entry but the last is a variable; the last is the literal fallback.
    const rungs = PALETTE_VARIABLES[key];
    for (let at = 0; at < rungs.length - 1; at += 1) {
      const value = read(rungs[at] as string).trim();
      if (value !== '') return KEEPS_ITS_ALPHA.has(key) ? value : opaque(value);
    }
    return rungs[rungs.length - 1] as string;
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
    error: resolve('error'),
    selection: resolve('selection'),
    fontFamily: resolve('fontFamily'),
    syntaxComment: resolve('syntaxComment'),
    syntaxKeyword: resolve('syntaxKeyword'),
    syntaxType: resolve('syntaxType'),
    syntaxFunction: resolve('syntaxFunction'),
    syntaxString: resolve('syntaxString'),
    syntaxNumber: resolve('syntaxNumber'),
    syntaxVariable: resolve('syntaxVariable'),
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
        // A node's size is its label plus its padding (`BASE_PADDING`).
        padding: 'data(pad)',
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
        // Inside its own top-left corner, not centred above the box. Centred,
        // two sibling directories put their labels in the same place and draw
        // them through each other.
        'text-valign': 'top',
        'text-halign': 'left',
        'text-margin-x': 10,
        'text-margin-y': 14,
        'text-wrap': 'none',
        'font-size': 12,
        color: palette.dim,
        // Edges cross a cluster's top-left corner freely, and a directory name
        // with a call edge drawn through it is not a directory name.
        'text-background-color': palette.background,
        'text-background-opacity': 0.85,
        'text-background-padding': '3px',
        padding: '18px',
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
        'text-halign': 'center',
        'text-margin-x': 0,
        'text-margin-y': 0,
        'text-wrap': 'wrap',
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
