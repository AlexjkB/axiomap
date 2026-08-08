/**
 * The palette rule, and the channels §11 allocates.
 *
 * The palette test is the one that keeps Phase 8 cheap: every colour has to come
 * from a `--vscode-*` variable when the host sets one, and the browser hex is
 * only what those variables resolve to when nobody has.
 */

import { describe, expect, it } from 'vitest';

import { PRESETS } from '../src/ui/presets.js';
import { FALLBACK_PALETTE, PALETTE_VARIABLES, readPalette, RESOLUTION_LINE, stylesheet } from '../src/ui/style.js';

describe('palette', () => {
  it('takes every colour from the host’s theme when it sets one', () => {
    const themed = readPalette((variable) => `themed(${variable})`);
    for (const [key, [variable]] of Object.entries(PALETTE_VARIABLES)) {
      expect(themed[key as keyof typeof themed]).toBe(`themed(${variable})`);
    }
  });

  it('falls back per variable, not per palette', () => {
    const partial = readPalette((variable) =>
      variable === '--vscode-editor-background' ? '#000000' : '',
    );
    expect(partial.background).toBe('#000000');
    expect(partial.foreground).toBe(FALLBACK_PALETTE.foreground);
  });

  it('names a VS Code variable for every entry — §11 forbids hard-coded hex', () => {
    for (const [variable] of Object.values(PALETTE_VARIABLES)) {
      expect(variable.startsWith('--vscode-')).toBe(true);
    }
  });
});

describe('stylesheet', () => {
  const sheet = stylesheet(FALLBACK_PALETTE, PRESETS.protocol);
  const selectors = sheet.map((block) => ('selector' in block ? block.selector : ''));

  it('gives each of §4’s four confidences its own line treatment', () => {
    expect(Object.keys(RESOLUTION_LINE).sort()).toEqual([
      'ambiguous',
      'heuristic',
      'semantic',
      'unresolved',
    ]);
    for (const resolution of Object.keys(RESOLUTION_LINE)) {
      expect(selectors).toContain(`edge.res-${resolution}`);
    }
    // §4: the four must be distinguishable, or the graph is "silently
    // pretending to certainty it does not have".
    const treatments = Object.values(RESOLUTION_LINE).map((line) => `${line.style}/${String(line.opacity)}`);
    expect(new Set(treatments).size).toBe(4);
  });

  /**
   * What each node channel is written by, as a test rather than as a comment.
   *
   * With the overlay system removed, a node's appearance is decided by the view
   * alone: its kind, and whether it is a cluster. These assertions are the ones
   * that catch a rule reaching for a channel that is not its own — the same
   * check 7b made before the overlays arrived, and the one that survives them.
   */
  const touching = (property: string): string[] =>
    sheet
      .filter(
        (block) =>
          'selector' in block &&
          'style' in block &&
          String(block.selector).startsWith('node') &&
          (block.style as Record<string, unknown>)[property] !== undefined,
      )
      .map((block) => String((block as { selector: string }).selector))
      .sort();

  it('fills nodes from the neutral defaults and nothing else', () => {
    // All four are the same statement — "this is a box, or a box holding
    // boxes" — rather than four signals competing for one channel. `:parent`
    // is a contract drawing its members inside it; the two `.cluster` rules
    // are a directory doing the same. Nothing here is an *attribute* of the
    // node, which is what the channel rule is about.
    expect(touching('background-color')).toEqual([
      'node',
      'node.cluster',
      'node.cluster.collapsed',
      'node:parent',
    ]);
  });

  it('leaves node opacity alone — nothing dims a node', () => {
    expect(touching('opacity')).toEqual([]);
  });

  it('gives node border style to the view’s own vocabulary only', () => {
    // An abstract contract and the synthetic `?` node are what a *view* says
    // about a node; a collapsed cluster is a box standing for what is not
    // drawn. Nothing else in the sheet writes this property.
    expect(touching('border-style')).toEqual([
      'node.cluster.collapsed',
      'node.contract-abstract',
      'node[kind = "Unresolved"]',
    ]);
  });

  it('draws no image on a node', () => {
    expect(touching('background-image')).toEqual([]);
  });

  it('sizes nodes from data', () => {
    const base = sheet.find((block) => 'selector' in block && block.selector === 'node');
    expect((base as { style: Record<string, unknown> }).style['padding']).toBe('data(pad)');
  });
});
