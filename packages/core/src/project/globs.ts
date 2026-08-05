/**
 * The glob subset §13's `include`, `exclude` and `trustBoundaries` need.
 *
 * Hand-rolled rather than a dependency, and that is the whole reason this file
 * exists. `@axiomap/core`'s entire production dependency tree is two pure-WASM
 * packages with no transitive dependencies of their own — a fact Phase 1 went
 * out of its way to achieve and §3 makes a security property auditors can
 * check. Adding a glob library to match `src/**` would trade that for about
 * fifty lines of code.
 *
 * Supported, which is everything §13's examples use and everything a path
 * filter needs:
 *
 * - `*`     — any run of characters except `/`
 * - `**`    — any run of characters including `/`
 * - `?`     — one character except `/`
 * - `{a,b}` — alternation
 *
 * Not supported: character classes, negation, extglobs. A pattern here is a
 * path filter, not a shell.
 */

function escapeLiteral(char: string): string {
  return /[.+^$()|[\]\\{}]/.test(char) ? `\\${char}` : char;
}

/**
 * The pattern body, without anchors.
 *
 * `**` is translated by looking at what follows it: `a/**\/b` has to match
 * `a/b` as well as `a/x/y/b`, so the separator is consumed by the globstar and
 * made optional rather than matched beside it.
 */
function compile(pattern: string): string {
  let out = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i] ?? '';

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 2;
        if (pattern[i] === '/') {
          out += '(?:.*/)?';
          i += 1;
        } else {
          out += '.*';
        }
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close !== -1) {
        const options = pattern.slice(i + 1, close).split(',');
        out += `(?:${options.map(compile).join('|')})`;
        i = close + 1;
        continue;
      }
    }

    out += escapeLiteral(char);
    i += 1;
  }

  return out;
}

/**
 * Compile one glob to a full-string regular expression.
 *
 * A trailing `/**` also matches the directory itself, so `exclude: ["test/**"]`
 * excludes `test` as well as everything under it. That is what everyone means
 * by it, and the surprise of it not doing so would surface as a directory that
 * refuses to be excluded.
 */
export function globToRegExp(pattern: string): RegExp {
  const body = compile(pattern);
  if (pattern.endsWith('/**')) {
    return new RegExp(`^(?:${body}|${compile(pattern.slice(0, -3))})$`);
  }
  return new RegExp(`^${body}$`);
}

export interface PathFilter {
  (file: string): boolean;
}

/**
 * §13's `include` + `exclude`, in that order: a file is kept if it matches any
 * include (or there are none) and no exclude.
 *
 * Exclude wins, which is what makes `include: ["src/**"]` plus
 * `exclude: ["src/mocks/**"]` mean what it looks like it means.
 */
export function pathFilter(
  include: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): PathFilter {
  const includes = (include ?? []).map(globToRegExp);
  const excludes = (exclude ?? []).map(globToRegExp);

  return (file: string): boolean => {
    if (excludes.some((pattern) => pattern.test(file))) return false;
    if (includes.length === 0) return true;
    return includes.some((pattern) => pattern.test(file));
  };
}

export function matchesAny(file: string, patterns: readonly string[] | undefined): boolean {
  if (patterns === undefined || patterns.length === 0) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}
