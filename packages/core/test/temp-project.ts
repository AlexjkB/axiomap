/**
 * A throwaway Foundry project on disk, built end to end.
 *
 * The committed fixtures carry hand-verified counts that Phase 1 asserts, so a
 * test that needs one more contract writes an inline project instead of
 * changing a fixture. `resolve-edges.test.ts` has its own copy of this shape
 * for the same reason; this one hands back the graph rather than the file,
 * because the analysis passes run over the graph.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildProjectGraph,
  type BuildProjectGraphOptions,
  type ProjectGraphResult,
} from '../src/index.js';

const temporaryDirs: string[] = [];

export async function buildTempProject(
  files: Record<string, string>,
  options: Partial<BuildProjectGraphOptions> = {},
): Promise<ProjectGraphResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-analysis-'));
  temporaryDirs.push(root);
  fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\nsrc = "src"\n');
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
  // Mode gating off: these projects are three contracts long, and §16 already
  // records that the threshold is a ratio and ratios are unstable that small.
  return buildProjectGraph(root, {
    cacheDir: null,
    workers: 1,
    callResolutionThreshold: 0,
    ...options,
  });
}

export function cleanUpTempProjects(): void {
  for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
  temporaryDirs.length = 0;
}
