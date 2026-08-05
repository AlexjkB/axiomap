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
   * §11's channel budget, as a test rather than as a comment.
   *
   * 7b asserted that the overlay channels were *untouched*, which was the right
   * check while no overlay existed. 7c fills them, so the check becomes the one
   * the budget actually makes: each channel is written by exactly the overlay it
   * was allocated to, and by nothing else. That is what stops the fifth overlay
   * from quietly reaching for a channel the third already owns.
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

  it('gives node fill to the review-state overlay and nothing else', () => {
    // The bare `node` rule and the two cluster rules are the neutral defaults
    // this overlay replaces — which is what "neutral" in §11's row means.
    expect(touching('background-color')).toEqual([
      'node',
      'node.cluster',
      'node.cluster.collapsed',
      'node.rv-flagged',
      'node.rv-follow-up',
      'node.rv-ignored',
      'node.rv-reviewed',
      'node.rv-stale',
    ]);
  });

  it('gives node opacity to reachability dimming and nothing else', () => {
    expect(touching('opacity')).toEqual(['node.surf-unreachable']);
  });

  it('gives node border style to resolution confidence', () => {
    // `contract-abstract` and the synthetic `?` node predate the overlay and are
    // the view's own vocabulary; the overlay's own classes are the `res-node-*`
    // pair, and nothing else in the sheet writes this property.
    expect(touching('border-style')).toEqual([
      'node.cluster.collapsed',
      'node.contract-abstract',
      'node.res-node-ambiguous',
      'node.res-node-unresolved',
      'node[kind = "Unresolved"]',
    ]);
  });

  it('gives the badge channel one rule, keyed on the node carrying badges', () => {
    expect(touching('background-image')).toEqual(['node[badges]']);
  });

  it('sizes nodes from data, which is where the complexity overlay writes', () => {
    const base = sheet.find((block) => 'selector' in block && block.selector === 'node');
    expect((base as { style: Record<string, unknown> }).style['padding']).toBe('data(pad)');
  });
});
