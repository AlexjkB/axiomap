/**
 * Finding and reading build-info (§7, Phase 3).
 *
 * A build-info file is the solc **standard-JSON input and output together**,
 * which is the only artifact that carries what the semantic tier needs: the AST
 * with its `referencedDeclaration` links, the source text those ASTs were built
 * from, and — when the project asked for it — storage layouts. Foundry writes
 * them to `<out>/build-info/` with `--build-info`; Hardhat writes them to
 * `<artifacts>/build-info/` on every compile.
 *
 * Both are read the same way because both are the same file with a different
 * `_format` string. Neither is required, neither is validated beyond the fields
 * that are actually read, and anything unreadable is skipped with a diagnostic
 * rather than thrown — §7: **must degrade silently to zero when nothing
 * compiles.**
 */

import fs from 'node:fs';
import path from 'node:path';

import type { DetectedProject } from '../project/detect.js';

/** The subset of the standard-JSON pair this tier reads. */
export interface BuildInfo {
  /** Absolute path it was read from, for diagnostics. */
  source: string;
  /** `0.8.28`, or `unknown` when the file does not say. */
  solcVersion: string;
  /** Source key → the exact text the compiler was given, when present. */
  contents: Map<string, string>;
  /** Source key → its AST root. */
  asts: Map<string, unknown>;
  /** Source key → contract name → `storageLayout`, when the project asked. */
  storageLayouts: Map<string, Map<string, unknown>>;
}

/** Where each supported toolchain puts build-info, relative to the root. */
export function buildInfoDirectories(project: DetectedProject): string[] {
  const dirs = new Set<string>();
  if (project.out !== null) dirs.add(path.posix.join(project.out, 'build-info'));
  // Both defaults are probed whatever the detected kind: a `bare` project may
  // still be a Hardhat project whose config we could not parse, and a Foundry
  // repo with a Hardhat compile step has both.
  dirs.add('out/build-info');
  dirs.add('artifacts/build-info');
  return [...dirs];
}

/**
 * Every build-info file in the project, in a stable order.
 *
 * **Sorted by path, deliberately not by mtime.** Ordering decides which
 * artifact owns a source when two of them cover it, and mtimes come from
 * whenever a checkout happened to write the file — so a graph built from a
 * fresh clone could differ from one built in place, and `axiomap diff` would
 * report the difference as a change in the code (§8, decision #3). This is the
 * same failure Phase 2's "byte-identical however many workers" test exists to
 * prevent, arriving by another route.
 *
 * Nothing is lost by dropping mtime: an artifact is only used for a source
 * whose bytes it still matches, so two artifacts that both qualify are both
 * right about it, and picking the first is as good as picking the newest and
 * reproducible besides.
 */
export function discoverBuildInfo(project: DetectedProject): string[] {
  const found: string[] = [];

  for (const dir of buildInfoDirectories(project)) {
    const absolute = path.join(project.root, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      found.push(path.join(absolute, entry.name));
    }
  }

  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return found;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read one build-info file, or return null with a reason.
 *
 * Deliberately hand-rolled rather than a zod schema: this is someone else's
 * artifact in a format that varies by toolchain and by version, and the useful
 * behaviour is to take the fields that are there and ignore the rest. A schema
 * would turn an unfamiliar-but-usable artifact into a hard failure, which is
 * the opposite of what decision #1 asks for.
 */
export function readBuildInfo(file: string): { info: BuildInfo } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const root = asRecord(raw);
  if (root === null) return { error: 'not a JSON object' };

  const input = asRecord(root['input']);
  const output = asRecord(root['output']);
  if (output === null) return { error: 'no "output" section — not a build-info file' };

  const outputSources = asRecord(output['sources']);
  if (outputSources === null) return { error: 'no "output.sources" — compiled with no AST output' };

  const asts = new Map<string, unknown>();
  for (const [key, value] of Object.entries(outputSources)) {
    const entry = asRecord(value);
    if (entry === null || entry['ast'] === undefined) continue;
    asts.set(key, entry['ast']);
  }
  if (asts.size === 0) {
    return { error: 'no ASTs in "output.sources" — recompile with the "ast" output selected' };
  }

  const contents = new Map<string, string>();
  const inputSources = input === null ? null : asRecord(input['sources']);
  for (const [key, value] of Object.entries(inputSources ?? {})) {
    const entry = asRecord(value);
    const content = entry?.['content'];
    if (typeof content === 'string') contents.set(key, content);
  }

  const storageLayouts = new Map<string, Map<string, unknown>>();
  for (const [key, value] of Object.entries(asRecord(output['contracts']) ?? {})) {
    const contracts = asRecord(value);
    if (contracts === null) continue;
    const layouts = new Map<string, unknown>();
    for (const [name, contract] of Object.entries(contracts)) {
      const layout = asRecord(contract)?.['storageLayout'];
      if (layout !== undefined) layouts.set(name, layout);
    }
    if (layouts.size > 0) storageLayouts.set(key, layouts);
  }

  const version = root['solcVersion'] ?? root['solcLongVersion'];

  return {
    info: {
      source: file,
      solcVersion: typeof version === 'string' && version !== '' ? version : 'unknown',
      contents,
      asts,
      storageLayouts,
    },
  };
}
