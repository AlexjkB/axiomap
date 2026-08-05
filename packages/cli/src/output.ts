/**
 * Table output, colour, and the `--json` switch (§12).
 *
 * §12: "Table output by default, `--json` for piping. This makes Axiomap
 * scriptable and CI-integrable, and gives it value to people who never open the
 * GUI." Both halves matter, so both go through here rather than each command
 * inventing its own layout.
 *
 * Colour is `picocolors`, which disables itself when stdout is not a TTY and
 * when `NO_COLOR` is set. Nothing in this file is load-bearing for meaning: a
 * pipe into `grep` gets the same words, and every column that carries a
 * judgement carries it as text as well as a colour. §11's channel budget is
 * about a graph renderer; the terminal equivalent of that discipline is that
 * colour is never the only thing saying something.
 */

import pc from 'picocolors';

export interface Column<T> {
  header: string;
  get: (row: T) => string;
  /** Right-align, for counts. */
  numeric?: boolean;
  /** Applied after width calculation, so colour codes never break alignment. */
  paint?: (value: string, row: T) => string;
}

/**
 * Widths are computed on the uncoloured strings and the paint applied
 * afterwards. Doing it the other way round is the classic terminal-table bug:
 * an ANSI escape is invisible and eight characters wide at the same time.
 */
export function table<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  if (rows.length === 0) return '';

  const cells = rows.map((row) => columns.map((column) => column.get(row)));
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...cells.map((row) => (row[i] ?? '').length)),
  );

  const pad = (value: string, width: number, numeric: boolean): string =>
    numeric ? value.padStart(width) : value.padEnd(width);

  const lines: string[] = [];
  lines.push(
    pc.dim(
      columns
        .map((column, i) => pad(column.header, widths[i] ?? 0, column.numeric === true))
        .join('  ')
        .trimEnd(),
    ),
  );

  rows.forEach((row, r) => {
    const line = columns
      .map((column, c) => {
        const raw = cells[r]?.[c] ?? '';
        const padded = pad(raw, widths[c] ?? 0, column.numeric === true);
        return column.paint === undefined ? padded : column.paint(padded, row);
      })
      .join('  ');
    lines.push(line.trimEnd());
  });

  return `${lines.join('\n')}\n`;
}

/** `key   value` pairs, aligned. For summaries rather than record lists. */
export function definitions(pairs: readonly (readonly [string, string])[]): string {
  const width = Math.max(0, ...pairs.map(([key]) => key.length));
  return `${pairs.map(([key, value]) => `${pc.dim(key.padEnd(width))}  ${value}`).join('\n')}\n`;
}

export function heading(text: string): string {
  return `${pc.bold(text)}\n`;
}

/** `1 caller` / `3 callers`. Counts are read out loud; "1 callers" reads wrong. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** `src/Vault.sol:84` — the form editors and `less +N` both understand. */
export function location(ref: { file: string; line: number }): string {
  return `${ref.file}:${String(ref.line)}`;
}

/**
 * §4's four resolution values, coloured by how much they should be trusted.
 *
 * This is the one place colour is doing real work, and it is the place §4 says
 * it should: the confidence split is the headline rather than a footnote,
 * because a tool that quietly implies certainty it does not have is worse than
 * useless in an audit.
 */
export function paintResolution(text: string, resolution: string): string {
  if (resolution === 'semantic') return pc.green(text);
  if (resolution === 'heuristic') return pc.cyan(text);
  if (resolution === 'ambiguous') return pc.yellow(text);
  return pc.red(text);
}

export function paintSeverity(text: string, severity: string): string {
  const key = severity.toLowerCase();
  if (key === 'high') return pc.red(text);
  if (key === 'medium') return pc.yellow(text);
  if (key === 'low') return pc.cyan(text);
  return pc.dim(text);
}

/** `none` is a finding, not an absence — §15's third item is built on it. */
export function paintConfidence(text: string, confidence: string): string {
  if (confidence === 'high') return pc.green(text);
  if (confidence === 'low') return pc.yellow(text);
  return pc.red(text);
}

export function paintMode(text: string, mode: string): string {
  if (mode === 'full') return pc.green(text);
  if (mode === 'heuristic') return pc.cyan(text);
  return pc.yellow(text);
}

export const colour = pc;
