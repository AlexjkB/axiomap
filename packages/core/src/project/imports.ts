/**
 * Import resolution without a compiler (§4).
 *
 * Sources are tried in the order §4 fixes: relative paths resolve against the
 * importing file, then remappings (already sorted longest-prefix-first by
 * `detectProject`), then `node_modules/`, then the project's own source roots.
 *
 * **Failure is not fatal.** An unresolvable import is recorded with the list of
 * places that were checked and the file keeps its place in the graph; edges
 * that depended on it become `unresolved` in Phase 2. Unresolved imports are
 * usually the reason a project does not compile, which is exactly the case
 * decision #1 exists to serve, so they are reported rather than fixed.
 */

import path from 'node:path';

import { applyRemappings, type Remapping } from './remappings.js';

export type ImportResolutionVia =
  | 'relative'
  | 'remapping'
  | 'node_modules'
  | 'source-root'
  | 'project-root';

export interface ResolvedImport {
  /** Importing file, project-relative posix. */
  from: string;
  /** The literal string in the `import` directive. */
  raw: string;
  /** Project-relative posix path, or null when nothing matched. */
  resolved: string | null;
  via: ImportResolutionVia | null;
  remapping: Remapping | null;
  /** Candidate paths tried, in order. Feeds the error message. */
  attempts: string[];
}

export interface ImportResolverOptions {
  /** Every `.sol` file in the project, project-relative posix. */
  files: Iterable<string>;
  remappings: readonly Remapping[];
  /** Source roots from project detection, e.g. `['src']`. */
  sources?: readonly string[];
}

/** Collapse `.`/`..` without touching the filesystem. */
function normalise(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

export class ImportResolver {
  readonly #files: Set<string>;
  readonly #remappings: readonly Remapping[];
  readonly #sources: readonly string[];

  constructor(options: ImportResolverOptions) {
    this.#files = new Set(options.files);
    this.#remappings = options.remappings;
    this.#sources = options.sources ?? [];
  }

  resolve(from: string, raw: string): ResolvedImport {
    const attempts: string[] = [];
    const dir = path.posix.dirname(from);

    const tryPath = (candidate: string): string | null => {
      const normalised = normalise(candidate);
      if (normalised === '') return null;
      attempts.push(normalised);
      return this.#files.has(normalised) ? normalised : null;
    };

    // 1. Relative to the importing file.
    if (raw.startsWith('./') || raw.startsWith('../')) {
      const hit = tryPath(`${dir}/${raw}`);
      return hit === null
        ? { from, raw, resolved: null, via: null, remapping: null, attempts }
        : { from, raw, resolved: hit, via: 'relative', remapping: null, attempts };
    }

    // 2. Remappings.
    const remapped = applyRemappings(raw, from, this.#remappings);
    if (remapped !== null) {
      const hit = tryPath(remapped.path);
      if (hit !== null) {
        return {
          from,
          raw,
          resolved: hit,
          via: 'remapping',
          remapping: remapped.remapping,
          attempts,
        };
      }
    }

    // 3. node_modules.
    const inNodeModules = tryPath(`node_modules/${raw}`);
    if (inNodeModules !== null) {
      return {
        from,
        raw,
        resolved: inNodeModules,
        via: 'node_modules',
        remapping: null,
        attempts,
      };
    }

    // 4. The project's own source roots, then the project root itself. Covers
    //    `import "src/Vault.sol"` and bare projects with no config at all.
    for (const source of this.#sources) {
      const hit = tryPath(`${source}/${raw}`);
      if (hit !== null) {
        return { from, raw, resolved: hit, via: 'source-root', remapping: null, attempts };
      }
    }

    const atRoot = tryPath(raw);
    if (atRoot !== null) {
      return { from, raw, resolved: atRoot, via: 'project-root', remapping: null, attempts };
    }

    return { from, raw, resolved: null, via: null, remapping: null, attempts };
  }
}

/**
 * §6: errors carry actionable context. Name what was checked, not just that it
 * failed — the answer is almost always "add a remapping" and the message
 * should make that obvious.
 */
export function describeUnresolvedImport(
  unresolved: ResolvedImport,
  configFiles: readonly string[],
): string {
  const checked = [...configFiles, 'node_modules', 'relative paths'];
  const tried =
    unresolved.attempts.length > 0
      ? ` Tried: ${unresolved.attempts.slice(0, 4).join(', ')}${unresolved.attempts.length > 4 ? ', …' : ''}.`
      : '';
  return (
    `Cannot resolve import "${unresolved.raw}" from ${unresolved.from} ` +
    `(checked: ${checked.join(', ')}).${tried}`
  );
}
