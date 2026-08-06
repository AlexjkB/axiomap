/**
 * §11: "Inline shiki code preview so you can read without leaving the graph."
 *
 * It sits inside the inspector, under the attributes, and shows the source of
 * whatever node is selected. Everything it draws arrived through
 * `HostBridge.source` — a byte range the host cut around that node's `src` —
 * which is the same rule the rest of this package lives by (§9 rule 1, §5): the
 * webview cannot open a file, and there is no id it could send that would make
 * the host open one the graph does not name.
 *
 * ### It says when it might be wrong
 *
 * Three states are reported rather than smoothed over, because a preview that
 * is confidently showing the wrong lines is worse than one that shows nothing:
 *
 * - **drifted** — the file on disk no longer matches what the graph describes.
 *   `serve` builds the graph once (§12) and `.axiomap/graph.json` can be older
 *   still, so this is the ordinary consequence of editing while the tool is
 *   open, not an exotic failure.
 * - **truncated** — the declaration was longer than the slice limit.
 * - **unavailable** — an `Unresolved` placeholder (§10) has no source, and
 *   saying so is §4's whole position rather than an embarrassment.
 */

import { useEffect, useState } from 'react';

import type { SourceSlice } from '@axiomap/core';

import { solidityHighlighter, type HighlightedLine } from './highlight.js';
import type { Palette } from './style.js';

export interface CodePreviewProps {
  slice: SourceSlice | null;
  busy: boolean;
  /** Why there is nothing to show, in the host's words. */
  error: string | null;
  palette: Palette;
}

/**
 * Plain lines, for the moment before the grammar has loaded and for the case
 * where it failed to. Unhighlighted Solidity is still Solidity; a preview that
 * renders nothing until a few hundred kilobytes arrive is worse than one that
 * renders immediately and colours in.
 */
function plainLines(text: string): HighlightedLine[] {
  return text.split('\n').map((line) => [{ content: line, offset: 0 }]);
}

export function CodePreview({ slice, busy, error, palette }: CodePreviewProps): JSX.Element | null {
  const [lines, setLines] = useState<HighlightedLine[] | null>(null);

  const text = slice?.text ?? null;
  useEffect(() => {
    if (text === null) {
      setLines(null);
      return;
    }
    // Shown immediately, coloured when the grammar lands.
    setLines(plainLines(text));

    let cancelled = false;
    void solidityHighlighter(palette)
      .then((highlighter) => {
        if (!cancelled) setLines(highlighter.lines(text));
      })
      .catch(() => {
        // The plain lines are already on screen and are not wrong, only
        // uncoloured. A highlighter that failed to load is not worth an error
        // in a panel whose job is to show code.
      });
    return () => {
      cancelled = true;
    };
  }, [text, palette]);

  if (error !== null) {
    return (
      <section className="ax-inspect-section">
        <h3>Source</h3>
        <p className="ax-empty">{error}</p>
      </section>
    );
  }

  if (slice === null) {
    return (
      <section className="ax-inspect-section">
        <h3>Source</h3>
        <p className="ax-empty">{busy ? 'reading…' : 'No source for this node.'}</p>
      </section>
    );
  }

  const rendered = lines ?? plainLines(slice.text);

  return (
    <section className="ax-inspect-section ax-source">
      <h3>
        Source{' '}
        <span className="ax-count">
          {slice.file}:{slice.focusStartLine}
        </span>
      </h3>

      {slice.drifted ? (
        <p className="ax-source-warn">
          {slice.file} has changed since this graph was built, so these lines may not be the
          right ones. Restart <code>axiomap serve</code> to re-read it.
        </p>
      ) : null}

      <pre className="ax-code" style={{ fontFamily: palette.fontFamily }}>
        <code>
          {rendered.map((tokens, index) => {
            const line = slice.startLine + index;
            const inFocus = line >= slice.focusStartLine && line <= slice.focusEndLine;
            return (
              <span
                key={line}
                className={inFocus ? 'ax-code-line ax-code-focus' : 'ax-code-line'}
              >
                <span className="ax-code-gutter">{line}</span>
                <span className="ax-code-text">
                  {tokens.map((token, at) => (
                    <span
                      key={`${String(at)}:${token.content}`}
                      style={token.color === undefined ? undefined : { color: token.color }}
                    >
                      {/* CRLF files keep their `\r` in the slice (the bytes are
                          the file's); it must not reach the DOM as a stray
                          glyph. Stripped here, at the last moment, rather than
                          in the slice — which would be a lie about the file. */}
                      {token.content.replace(/\r$/, '')}
                    </span>
                  ))}
                </span>
              </span>
            );
          })}
        </code>
      </pre>

      {slice.truncated ? (
        <p className="ax-source-note">
          Cut at {slice.lines} lines — this declaration is longer than the preview shows.
        </p>
      ) : null}
    </section>
  );
}
