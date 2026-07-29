/**
 * `foundry.toml` — source 1 in §4's import-resolution order.
 *
 * Reads `src`, `out`, `libs` and `remappings` from the selected profile,
 * falling back to `profile.default`, then to Foundry's own defaults.
 *
 * Also reproduces Foundry's **implicit** remappings: every directory under a
 * lib path is remapped as `<name>/ -> lib/<name>/src/` when that `src`
 * directory exists, otherwise `<name>/ -> lib/<name>/`. Projects rely on this
 * without ever writing it down, so a resolver that only reads explicit
 * remappings fails on most real Foundry repos.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseRemappings, type Remapping } from './remappings.js';
import { parseToml, tomlString, tomlStringArray } from './toml.js';

export interface FoundryConfig {
  configPath: string;
  profile: string;
  sources: string[];
  libs: string[];
  out: string;
  remappings: Remapping[];
}

const DEFAULTS = { src: 'src', out: 'out', libs: ['lib'] } as const;

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** Directories Foundry itself would remap, given the lib paths. */
function implicitLibRemappings(root: string, libs: string[]): Remapping[] {
  const remappings: Remapping[] = [];
  for (const lib of libs) {
    const libDir = path.join(root, lib);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(libDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const hasSrc = fs.existsSync(path.join(libDir, entry.name, 'src'));
      remappings.push({
        context: null,
        prefix: `${entry.name}/`,
        target: hasSrc ? `${lib}/${entry.name}/src/` : `${lib}/${entry.name}/`,
        source: 'foundry:implicit-lib',
      });
    }
  }
  return remappings;
}

export function readFoundryConfig(root: string, profile = 'default'): FoundryConfig | null {
  const configPath = path.join(root, 'foundry.toml');
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }

  const doc = parseToml(text);
  const table = doc.tables.has(`profile.${profile}`)
    ? `profile.${profile}`
    : 'profile.default';

  const src = tomlString(doc, table, 'src') ?? DEFAULTS.src;
  const out = tomlString(doc, table, 'out') ?? DEFAULTS.out;
  const libsRaw = tomlStringArray(doc, table, 'libs');
  const libs = libsRaw.length > 0 ? libsRaw : [...DEFAULTS.libs];

  const explicit = tomlStringArray(doc, table, 'remappings').flatMap((line) =>
    parseRemappings(line, 'foundry.toml'),
  );

  return {
    configPath: toPosix(path.relative(root, configPath)),
    profile,
    sources: [toPosix(src)],
    libs: libs.map(toPosix),
    out: toPosix(out),
    // Explicit remappings win over the implicit lib ones.
    remappings: [...explicit, ...implicitLibRemappings(root, libs)],
  };
}
