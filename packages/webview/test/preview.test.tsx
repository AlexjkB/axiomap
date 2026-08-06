// @vitest-environment jsdom

/**
 * §11's inline code preview (Phase 7d).
 *
 * Two properties are worth a test here and they are not the obvious one.
 *
 * The first is that the highlighting is **the host's colours**. §11 forbids
 * hard-coded hex, and a shiki theme is a list of hex values — so the theme is
 * built from the resolved palette, and the only place that is true or false is
 * the colour that comes back attached to a token. This drives the real grammar
 * rather than a stub for exactly that reason: a stub would be asserting that
 * this file's own mapping table agrees with itself.
 *
 * The second is that the preview says when it might be wrong. A stale graph
 * points at lines that have moved, and a preview confidently showing the wrong
 * function is the failure this project refuses everywhere else.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CodePreview } from '../src/ui/CodePreview.js';
import { createSolidityHighlighter, themeFrom } from '../src/ui/highlight.js';
import { FALLBACK_PALETTE, readPalette } from '../src/ui/style.js';
import { sliceOf } from './support.js';

afterEach(cleanup);

/** A host theme, the way `browser-smoke.test.ts` injects one. */
const HOST = readPalette((variable) => {
  if (variable === '--vscode-symbolIcon-keywordForeground') return '#ff0000';
  if (variable === '--vscode-symbolIcon-numberForeground') return '#00ff00';
  return '';
});

describe('the syntax theme', () => {
  it('is built from the palette rather than from a shipped theme', () => {
    const theme = themeFrom(HOST);
    const colours = (theme.settings ?? []).flatMap((rule) => rule.settings.foreground ?? []);

    expect(colours).toContain('#ff0000');
    expect(colours).toContain('#00ff00');
    // Everything else fell back, which is what a browser with no host gets.
    expect(colours).toContain(FALLBACK_PALETTE.syntaxString);
  });

  /**
   * The chain §11 cares about, end to end: a host variable → `readPalette` →
   * the shiki theme → the colour on a token. Every link but the last was
   * already pinned; this is the last one.
   */
  it('colours a Solidity keyword with the colour the host set', async () => {
    const highlighter = await createSolidityHighlighter(HOST);
    // Inside a contract: the grammar only tokenises statements in a scope where
    // Solidity can have them, and a bare line at file level comes back as one
    // undifferentiated token whatever the theme says.
    const lines = highlighter.lines(
      'contract C {\n    function f() external {\n        uint256 x = 1000;\n    }\n}\n',
    );

    const tokens = lines.flat();
    const number = tokens.find((token) => token.content.includes('1000'));
    expect(number?.color?.toLowerCase()).toBe('#00ff00');
    const keyword = tokens.find((token) => token.content.trim() === 'function');
    expect(keyword?.color?.toLowerCase()).toBe('#ff0000');

    // And a construct with no rule takes the editor foreground rather than
    // nothing — an unrecognised bit of Solidity should look like plain code.
    expect(tokens.every((token) => token.color !== undefined)).toBe(true);
  }, 30_000);
});

describe('CodePreview', () => {
  const palette = FALLBACK_PALETTE;

  it('numbers lines from the slice’s own start, not from one', async () => {
    render(<CodePreview slice={sliceOf('x')} busy={false} error={null} palette={palette} />);

    // The slice starts at line 12, so the gutter does too. Getting this wrong
    // is what makes a preview impossible to match against an editor.
    await waitFor(() => {
      expect(screen.getByText('12')).toBeDefined();
    });
    expect(screen.getByText('14')).toBeDefined();
    expect(screen.queryByText('1')).toBeNull();
  });

  it('marks the declaration apart from the context around it', async () => {
    const { container } = render(
      <CodePreview
        slice={sliceOf('x', { startLine: 10, focusStartLine: 12, focusEndLine: 14, lines: 6, text: 'a\nb\nc\nd\ne\nf\n' })}
        busy={false}
        error={null}
        palette={palette}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.ax-code-line').length).toBeGreaterThan(0);
    });
    // Lines 12, 13 and 14 of six starting at 10.
    expect(container.querySelectorAll('.ax-code-focus')).toHaveLength(3);
  });

  it('says so when the file has moved under the graph', async () => {
    render(
      <CodePreview slice={sliceOf('x', { drifted: true })} busy={false} error={null} palette={palette} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/has changed since this graph was built/)).toBeDefined();
    });
  });

  it('says so when the declaration was longer than the slice', async () => {
    render(
      <CodePreview slice={sliceOf('x', { truncated: true })} busy={false} error={null} palette={palette} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Cut at 3 lines/)).toBeDefined();
    });
  });

  /**
   * §4: an unresolved placeholder has no source, and saying so is the answer.
   * The host's sentence is shown verbatim rather than reworded here — a second
   * opinion about what was found is exactly what this project avoids.
   */
  it('shows the host’s reason when there is nothing to show', () => {
    render(
      <CodePreview
        slice={null}
        busy={false}
        error='"?call" is an unresolved placeholder (low-level), not a declaration.'
        palette={palette}
      />,
    );
    expect(screen.getByText(/unresolved placeholder/)).toBeDefined();
  });

  /**
   * `pathological/`'s CRLF file keeps its `\r` in the slice, because the bytes
   * are the file's and normalising them would be a lie about it. It must not
   * reach the DOM, where it is a stray control character in the middle of the
   * code.
   */
  it('does not render the carriage return of a CRLF file', async () => {
    const { container } = render(
      <CodePreview
        slice={sliceOf('x', { text: 'contract Crlf {\r\n    uint256 v;\r\n}\r\n' })}
        busy={false}
        error={null}
        palette={palette}
      />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll('.ax-code-line').length).toBeGreaterThan(1);
    });
    expect(container.textContent).not.toContain('\r');
  });
});
