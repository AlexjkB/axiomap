/**
 * §11's `/` fuzzy search palette.
 *
 * ### It holds no node list, and cannot
 *
 * Every keystroke is a request to `HostBridge.search`, and the answer is a
 * capped list of rows. That is not a round-trip this could have avoided by
 * fetching the ids once and filtering locally — §9 rule 1 is that the webview
 * never receives the full graph, and a client-side index of every node id *is*
 * that graph, minus the edges. Phase 7b's navigation note says the same thing
 * from the other direction: "a list of every function is either later in §11 or
 * is the full graph wearing a different hat". This is the "later in §11", and
 * the way it stays honest is that the host does the matching.
 *
 * ### It says what it did not show
 *
 * `searchNodes` returns `total` alongside the rows, so a query broad enough to
 * match half the protocol reports the number and asks for a narrower one. The
 * alternative — twenty rows with no indication there were four hundred — is
 * the silent truncation §9 rule 2 refuses for the render cap, in a different
 * panel.
 */

import { useEffect, useRef, useState } from 'react';

import type { SearchHit, SearchResults } from '@axiomap/core';

export interface SearchPaletteProps {
  open: boolean;
  /** The host's matcher. The only one there is. */
  search: (query: string, limit?: number) => Promise<SearchResults>;
  /** Chosen a row: navigate to it and open the inspector on it. */
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}

/**
 * Long enough that a fast typist makes one request per word rather than per
 * letter, short enough that the list feels live. The host is local and the
 * match is a pass over the node set, so this is about request churn rather
 * than about the cost of an answer.
 */
const DEBOUNCE_MS = 90;

export function SearchPalette({ open, search, onPick, onClose }: SearchPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (query.trim() === '') {
      setResults(null);
      setFailed(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void search(query)
        .then((loaded) => {
          if (cancelled) return;
          setResults(loaded);
          setFailed(null);
          // A new answer means the old highlight is meaningless; the first row
          // is the best match, which is what Enter should take.
          setActive(0);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setResults(null);
          setFailed(cause instanceof Error ? cause.message : String(cause));
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, search]);

  if (!open) return null;

  const hits = results?.hits ?? [];

  const move = (delta: number): void => {
    if (hits.length === 0) return;
    setActive((at) => (at + delta + hits.length) % hits.length);
  };

  return (
    <div
      className="ax-palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ax-palette" role="dialog" aria-label="Search nodes">
        <input
          ref={input}
          type="text"
          className="ax-palette-input"
          placeholder="Search contracts, functions, storage…"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              move(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              move(-1);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const hit = hits[active];
              if (hit !== undefined) onPick(hit);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />

        {failed === null ? null : <p className="ax-palette-note ax-palette-error">{failed}</p>}

        {query.trim() === '' ? (
          <p className="ax-palette-note">
            Type a contract, function or variable name. Fuzzy: <code>prswp</code> finds{' '}
            <code>Pair.swap</code>.
          </p>
        ) : hits.length === 0 && failed === null ? (
          <p className="ax-palette-note">No node matches “{query.trim()}”.</p>
        ) : (
          <ul className="ax-palette-hits">
            {hits.map((hit, index) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className={index === active ? 'ax-palette-hit ax-palette-hit-active' : 'ax-palette-hit'}
                  title={hit.id}
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    onPick(hit);
                  }}
                >
                  <span className="ax-palette-name">{hit.name}</span>
                  <span className="ax-palette-kind">{hit.kind}</span>
                  <span className="ax-palette-where">
                    {hit.scope === null ? hit.file : `${hit.file}:${String(hit.line)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* §9 rule 2's shape, in a different panel: a bounded answer that says
            what it left out rather than a truncation that looks like the whole
            of it. */}
        {results !== null && results.capped ? (
          <p className="ax-palette-note">
            {results.total.toLocaleString('en-US')} matches — showing the closest{' '}
            {String(results.hits.length)}. Narrow the query.
          </p>
        ) : null}
      </div>
    </div>
  );
}
