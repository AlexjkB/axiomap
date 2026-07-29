/**
 * A deliberately small TOML reader for `foundry.toml`.
 *
 * Scope: tables (`[profile.default]`), string / boolean / number values, and
 * string arrays written inline or across several lines. That is everything §4
 * asks of `foundry.toml` — `remappings`, `src`, `out`, `libs`.
 *
 * Why not a TOML dependency: `@axiomap/core` carries a hard zero-network,
 * minimal-dependency invariant (§3) that a reviewer is expected to be able to
 * audit by reading the tree. Sixty lines here is cheaper to justify than
 * another package, and a `foundry.toml` this cannot read degrades to "no
 * remappings found", which is a recorded diagnostic rather than a failure.
 */

export type TomlValue = string | number | boolean | string[];
export type TomlTable = Map<string, TomlValue>;

export interface TomlDocument {
  /** Keyed by dotted table path; the root table is `''`. */
  tables: Map<string, TomlTable>;
}

function stripComment(line: string): string {
  let inString = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === quote) inString = false;
    } else if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(raw: string): string {
  const text = raw.trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseArray(raw: string): string[] {
  const inner = raw.slice(raw.indexOf('[') + 1, raw.lastIndexOf(']'));
  return inner
    .split(',')
    .map((part) => unquote(part))
    .filter((part) => part.length > 0);
}

function parseScalar(raw: string): TomlValue {
  const text = raw.trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return unquote(text);
}

export function parseToml(source: string): TomlDocument {
  const tables = new Map<string, TomlTable>();
  tables.set('', new Map());
  let current = '';

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i] as string).trim();
    if (line === '') continue;

    const table = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (table !== null) {
      current = (table[1] as string).trim();
      if (!tables.has(current)) tables.set(current, new Map());
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = unquote(line.slice(0, eq));
    let value = line.slice(eq + 1).trim();

    // Arrays may span lines; accumulate until the brackets balance.
    if (value.startsWith('[') && !value.includes(']')) {
      const parts = [value];
      while (i + 1 < lines.length && !parts.join('').includes(']')) {
        i++;
        parts.push(stripComment(lines[i] as string).trim());
      }
      value = parts.join(' ');
    }

    const target = tables.get(current);
    if (target === undefined) continue;
    target.set(key, value.startsWith('[') ? parseArray(value) : parseScalar(value));
  }

  return { tables };
}

export function tomlString(doc: TomlDocument, table: string, key: string): string | null {
  const value = doc.tables.get(table)?.get(key);
  return typeof value === 'string' ? value : null;
}

export function tomlStringArray(doc: TomlDocument, table: string, key: string): string[] {
  const value = doc.tables.get(table)?.get(key);
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}
