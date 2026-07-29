/**
 * Project detection and source enumeration.
 *
 * Establishes, for a directory: what kind of project it is, where its sources
 * live, and the full remapping set in §4's priority order —
 * `foundry.toml`, then `remappings.txt`, then `hardhat.config.*`.
 *
 * Nothing here fails hard. An unreadable config is a diagnostic and the
 * defaults apply; a project with no config at all is `bare` and still gets a
 * complete file list. Decision #1 means the tool has to say something useful
 * about a directory it does not understand.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readFoundryConfig } from './foundry.js';
import { readHardhatConfig } from './hardhat.js';
import { parseRemappings, sortRemappings, type Remapping } from './remappings.js';

export type ProjectKind = 'foundry' | 'hardhat' | 'bare';

export interface ProjectDiagnostic {
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface DetectedProject {
  /** Absolute. */
  root: string;
  kind: ProjectKind;
  /** Project-relative, posix separators. */
  sources: string[];
  libs: string[];
  /** Build output directory, if the project declares one. */
  out: string | null;
  /** Longest-prefix-first, ready for `applyRemappings`. */
  remappings: Remapping[];
  configFiles: string[];
  diagnostics: ProjectDiagnostic[];
}

/**
 * Directories that never contain source worth graphing. `out`/`artifacts` hold
 * compiler output, and walking `node_modules` wholesale on a large project
 * costs seconds for files that imports reach directly anyway.
 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'artifacts',
  'cache',
  'coverage',
  'broadcast',
  'typechain',
  'typechain-types',
  '.axiomap',
]);

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

export function detectProject(root: string): DetectedProject {
  const absoluteRoot = path.resolve(root);
  const diagnostics: ProjectDiagnostic[] = [];
  const configFiles: string[] = [];
  const remappings: Remapping[] = [];

  let kind: ProjectKind = 'bare';
  let sources: string[] = [];
  let libs: string[] = [];
  let out: string | null = null;

  // 1. foundry.toml
  const foundry = readFoundryConfig(absoluteRoot);
  if (foundry !== null) {
    kind = 'foundry';
    sources = foundry.sources;
    libs = foundry.libs;
    out = foundry.out;
    remappings.push(...foundry.remappings);
    configFiles.push(foundry.configPath);
  }

  // 2. remappings.txt — applies whatever the project kind, and takes priority
  //    over foundry.toml's implicit lib remappings by being listed first.
  const remappingsPath = path.join(absoluteRoot, 'remappings.txt');
  if (fs.existsSync(remappingsPath)) {
    try {
      const parsed = parseRemappings(fs.readFileSync(remappingsPath, 'utf8'), 'remappings.txt');
      remappings.unshift(...parsed);
      configFiles.push('remappings.txt');
    } catch (error) {
      diagnostics.push({
        message: `Cannot read remappings.txt: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'warning',
      });
    }
  }

  // 3. hardhat.config.* — parsed, never executed.
  const hardhat = readHardhatConfig(absoluteRoot);
  if (hardhat !== null) {
    if (kind === 'bare') {
      kind = 'hardhat';
      sources = hardhat.sources;
      out = hardhat.artifacts;
    }
    configFiles.push(hardhat.configPath);
    if (hardhat.usedDefaults) {
      diagnostics.push({
        message:
          `${hardhat.configPath} has no static \`paths.sources\`; assuming ` +
          `"${hardhat.sources[0] ?? 'contracts'}". The config is never executed, so ` +
          'anything computed at runtime is invisible here.',
        severity: 'info',
      });
    }
  }

  if (kind === 'bare') {
    diagnostics.push({
      message:
        'No foundry.toml, remappings.txt or hardhat.config.* found. Treating the ' +
        'directory as a bare Solidity tree; imports resolve relatively and through ' +
        'node_modules only.',
      severity: 'info',
    });
  }

  return {
    root: absoluteRoot,
    kind,
    sources,
    libs,
    out,
    remappings: sortRemappings(remappings),
    configFiles,
    diagnostics,
  };
}

/**
 * Every `.sol` file under the project, project-relative and posix-separated.
 *
 * Deliberately not limited to `sources`: test and script directories are the
 * difference between "which of these 40 contracts are real" and a graph that
 * cannot answer that question (§1). `out`-style directories are skipped
 * because they hold compiler output, not source.
 */
export function listSolidityFiles(
  project: DetectedProject,
  options: { skipDirs?: ReadonlySet<string> } = {},
): string[] {
  const skip = options.skipDirs ?? SKIP_DIRS;
  const found: string[] = [];
  const outDir = project.out === null ? null : path.join(project.root, project.out);

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        if (outDir !== null && full === outDir) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.sol')) {
        found.push(toPosix(path.relative(project.root, full)));
      }
    }
  };

  walk(project.root);
  return found.sort();
}
