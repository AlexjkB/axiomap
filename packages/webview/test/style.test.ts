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

  it('leaves the channels §11 assigns to overlays alone', () => {
    // Node fill is review state, border colour is access control, opacity is
    // reachability, size is complexity. None of them ships in 7b, and a rule
    // claiming one now is a channel an overlay could not have later.
    const nodeRules = sheet.filter(
      (block) => 'selector' in block && String(block.selector).startsWith('node'),
    );
    for (const rule of nodeRules) {
      if (!('style' in rule)) continue;
      const style = rule.style as Record<string, unknown>;
      const selector = String((rule as { selector: string }).selector);
      // Clusters are not graph nodes and are not in §11's table at all; the
      // bare `node` rule is the neutral default fill the review-state overlay
      // will replace, which is what "neutral" in that row means.
      if (selector.includes('cluster') || selector === 'node') continue;
      expect(style['opacity']).toBeUndefined();
      expect(style['background-color']).toBeUndefined();
    }
  });
});
