/**
 * `hardhat.config.{js,ts,cjs,mjs}` — source 3 in §4's order.
 *
 * **Parsed statically. Never executed.** A Hardhat config is arbitrary code
 * that runs plugins, reads `.env`, and in the wild sometimes makes network
 * calls; executing one would break decision #2 outright and hand arbitrary
 * execution to whatever repository the tool was pointed at. That is not a
 * trade worth making for a `paths.sources` value.
 *
 * The cost is that anything computed at runtime is invisible. A config that
 * builds its paths dynamically degrades to Hardhat's defaults, which is a
 * recorded diagnostic and still produces a usable graph.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface HardhatConfig {
  configPath: string;
  sources: string[];
  artifacts: string;
  cache: string;
  /** True when the file parsed but no `paths` block was found. */
  usedDefaults: boolean;
}

const CONFIG_NAMES = [
  'hardhat.config.ts',
  'hardhat.config.js',
  'hardhat.config.cjs',
  'hardhat.config.mjs',
];

const DEFAULTS = { sources: 'contracts', artifacts: 'artifacts', cache: 'cache' } as const;

/**
 * Pull a single string field out of a `paths: { ... }` object literal.
 * Tolerates quoted and unquoted keys and both quote styles.
 */
function readPathField(pathsBlock: string, key: string): string | null {
  const pattern = new RegExp(
    `(?:^|[\\s,{])["']?${key}["']?\\s*:\\s*["']([^"']+)["']`,
    'm',
  );
  const match = pattern.exec(pathsBlock);
  return match === null ? null : (match[1] as string);
}

/** Extract the balanced `{ ... }` following a `paths:` key, if present. */
function extractPathsBlock(source: string): string | null {
  const match = /["']?paths["']?\s*:\s*\{/.exec(source);
  if (match === null) return null;

  let depth = 0;
  const start = match.index + match[0].length - 1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export function readHardhatConfig(root: string): HardhatConfig | null {
  for (const name of CONFIG_NAMES) {
    const configPath = path.join(root, name);
    let source: string;
    try {
      source = fs.readFileSync(configPath, 'utf8');
    } catch {
      continue;
    }

    const block = extractPathsBlock(source);
    const sources = block === null ? null : readPathField(block, 'sources');
    const artifacts = block === null ? null : readPathField(block, 'artifacts');
    const cache = block === null ? null : readPathField(block, 'cache');

    return {
      configPath: name,
      sources: [sources ?? DEFAULTS.sources],
      artifacts: artifacts ?? DEFAULTS.artifacts,
      cache: cache ?? DEFAULTS.cache,
      usedDefaults: sources === null,
    };
  }
  return null;
}
