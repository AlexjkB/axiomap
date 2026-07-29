/**
 * Remapping collection and application (§4, sources 1 and 2).
 *
 * A remapping is `prefix=target`, optionally scoped to a context:
 * `context:prefix=target`. Solc applies the **longest matching prefix**, and
 * among equal-length prefixes the one whose context matches the importing
 * file. Getting the ordering wrong quietly resolves imports to the wrong copy
 * of a library, which is the kind of bug that shows up as a mysteriously
 * duplicated contract in the graph.
 */

export interface Remapping {
  /** Optional path prefix the importing file must sit under. */
  context: string | null;
  prefix: string;
  target: string;
  /** Where this came from — reported in the build summary. */
  source: string;
}

export function parseRemappingLine(line: string, source: string): Remapping | null {
  const text = line.trim();
  if (text === '' || text.startsWith('#')) return null;

  const eq = text.indexOf('=');
  if (eq <= 0) return null;

  const left = text.slice(0, eq);
  const target = text.slice(eq + 1).trim();
  if (target === '') return null;

  const colon = left.indexOf(':');
  const context = colon === -1 ? null : left.slice(0, colon);
  const prefix = colon === -1 ? left : left.slice(colon + 1);
  if (prefix.trim() === '') return null;

  return { context, prefix: prefix.trim(), target, source };
}

export function parseRemappings(text: string, source: string): Remapping[] {
  return text
    .split(/\r?\n/)
    .map((line) => parseRemappingLine(line, source))
    .filter((r): r is Remapping => r !== null);
}

/**
 * Sort so the first match is the right match: longest prefix first, and a
 * context-scoped remapping ahead of an unscoped one of the same length.
 */
export function sortRemappings(remappings: Remapping[]): Remapping[] {
  return [...remappings].sort((a, b) => {
    if (b.prefix.length !== a.prefix.length) return b.prefix.length - a.prefix.length;
    const aContext = a.context?.length ?? 0;
    const bContext = b.context?.length ?? 0;
    return bContext - aContext;
  });
}

/**
 * Apply the first matching remapping to an import path.
 *
 * @param importPath The literal string from the `import` directive.
 * @param fromFile   Project-relative path of the importing file, for contexts.
 */
export function applyRemappings(
  importPath: string,
  fromFile: string,
  remappings: readonly Remapping[],
): { path: string; remapping: Remapping } | null {
  for (const remapping of remappings) {
    if (remapping.context !== null && !fromFile.startsWith(remapping.context)) continue;
    if (!importPath.startsWith(remapping.prefix)) continue;
    return {
      path: remapping.target + importPath.slice(remapping.prefix.length),
      remapping,
    };
  }
  return null;
}
