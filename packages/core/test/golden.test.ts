/**
 * Golden-file tests — §7 calls this the most important test suite in the
 * project, and §6 sets the rule that goes with it: **read the diff and justify
 * it.** Never regenerate a golden to turn a red build green.
 *
 * Run `pnpm test:golden -- -u` (or `AXIOMAP_UPDATE_GOLDEN=1`) to rewrite them,
 * then read what changed before committing. A golden diff is a claim that the
 * graph changed; the commit message has to say why.
 *
 * ### Why `inheritance/` is committed filtered
 *
 * `inheritance/` vendors 25 OpenZeppelin files, and its full graph serializes
 * to ~1.2 MB — over this repo's own pre-commit size guard, and far past the
 * point where anyone reads the diff, which is the only thing that makes a
 * golden useful. So its golden covers the hand-written `src/` contracts in
 * full, and the vendored subtree is pinned by a counts summary instead:
 * node kinds, edge kinds, and the resolution split. A change in how OpenZeppelin
 * resolves still fails the build; it just fails as four numbers rather than
 * forty thousand lines.
 *
 * The other three fixtures are committed whole.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseGraph, serializeGraph, type GraphEdge, type GraphFile } from '../src/index.js';
import {
  CORRECTNESS_FIXTURES,
  graphOf,
  graphWithoutModeGating,
  type FixtureName,
} from './graphs.js';

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');

const UPDATE =
  process.env['AXIOMAP_UPDATE_GOLDEN'] === '1' ||
  process.argv.includes('-u') ||
  process.argv.includes('--update');

/** Paths excluded from a fixture's committed golden, with a summary instead. */
const EXCLUDED: Partial<Record<FixtureName, string>> = {
  inheritance: 'lib/',
};

interface VendoredSummary {
  prefix: string;
  files: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  edgesByResolution: Record<string, number>;
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values.slice().sort()) out[value] = (out[value] ?? 0) + 1;
  return out;
}

/**
 * Drop the excluded subtree, then drop edges that lost an endpoint with it.
 * The result is still a valid `GraphFile`, so the golden exercises the real
 * serializer and the real schema rather than a bespoke projection.
 */
function project(file: GraphFile, prefix: string): { kept: GraphFile; summary: VendoredSummary } {
  const excluded = (id: string): boolean => id.startsWith(prefix);
  const keptNodes = file.nodes.filter((n) => !excluded(n.file));
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = file.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));

  const droppedNodes = file.nodes.filter((n) => excluded(n.file));
  const droppedEdges: GraphEdge[] = file.edges.filter(
    (e) => !keptIds.has(e.from) || !keptIds.has(e.to),
  );

  return {
    kept: { ...file, nodes: keptNodes, edges: keptEdges },
    summary: {
      prefix,
      files: droppedNodes.filter((n) => n.kind === 'SourceUnit').length,
      nodesByKind: tally(droppedNodes.map((n) => n.kind)),
      edgesByKind: tally(droppedEdges.map((e) => e.kind)),
      edgesByResolution: tally(droppedEdges.map((e) => e.resolution)),
    },
  };
}

function compare(target: string, actual: string, label: string): void {
  if (UPDATE) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, actual, 'utf8');
    return;
  }
  if (!fs.existsSync(target)) {
    throw new Error(
      `Missing golden ${path.relative(process.cwd(), target)} for ${label}. ` +
        'Run `pnpm test:golden -- -u` and review the result before committing.',
    );
  }
  expect(actual, `${label} differs from its golden file`).toBe(
    fs.readFileSync(target, 'utf8'),
  );
}

describe('golden graphs', () => {
  for (const name of CORRECTNESS_FIXTURES) {
    describe(name, () => {
      it('matches its committed graph.json', async () => {
        const { file } = await graphOf(name);
        const prefix = EXCLUDED[name];
        const target = path.join(GOLDEN_DIR, `${name}.graph.json`);

        if (prefix === undefined) {
          compare(target, serializeGraph(file), `${name}/graph.json`);
          return;
        }

        const { kept, summary } = project(file, prefix);
        compare(target, serializeGraph(kept), `${name}/graph.json (excluding ${prefix})`);
        compare(
          path.join(GOLDEN_DIR, `${name}.vendored.json`),
          `${JSON.stringify(summary, null, 2)}\n`,
          `${name}/ vendored summary`,
        );
      });

      /**
       * `pathological/` resolves below the mode threshold, so its committed
       * graph is structural and contains no call edges at all — leaving the
       * call resolution of the one adversarial fixture pinned by nothing. This
       * second golden is the same project with the mode gate disabled, so the
       * function pointer, the selector dispatch and the low-level call are
       * regression-tested like everything else.
       */
      if (name === 'pathological') {
        it('matches its committed ungated graph.json', async () => {
          const { file } = await graphWithoutModeGating(name);
          expect(file.mode).toBe('heuristic');
          compare(
            path.join(GOLDEN_DIR, `${name}.ungated.graph.json`),
            serializeGraph(file),
            `${name}/graph.json (mode gate disabled)`,
          );
        });
      }

      it('has a golden that still parses against the current schema', async () => {
        const target = path.join(GOLDEN_DIR, `${name}.graph.json`);
        if (!fs.existsSync(target)) return;
        // A golden that no longer validates is a schema change nobody bumped.
        expect(() => parseGraph(fs.readFileSync(target, 'utf8'), target)).not.toThrow();
      });
    });
  }
});
