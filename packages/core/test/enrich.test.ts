/**
 * Phase 3 — the semantic tier.
 *
 * §7's exit criterion has two halves and this file is the first: on `defi/`,
 * with artifacts present, the resolution score exceeds 95% semantic **and the
 * graph is identical in shape to the heuristic-only graph**. Shape is the node
 * set plus the edge set keyed by `(kind, subkind, from, to)`, against
 * `test/golden/defi.graph.json` — `resolution` is excluded, and so is
 * `possibleTargets`, which a compiler narrows legitimately.
 *
 * The second half is `enrich-stub.test.ts`, which stubs this tier out entirely
 * and asserts every fixture still builds.
 *
 * The artifacts under `fixtures/defi/out/build-info/` are committed, not built
 * here: CI has no solc, and a fixture whose expected output depends on a
 * compiler being installed is a fixture that fails for a reason nobody can read
 * from the diff.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildProjectGraph,
  discoverBuildInfo,
  detectProject,
  loadSemanticOverlay,
  parseGraph,
  readBuildInfo,
  type GraphEdge,
  type GraphFile,
} from '../src/index.js';
import { fixture, FIXTURE_ROOT } from './fixtures.js';
import { enrichedGraphOf, graphOf } from './graphs.js';

const GOLDEN = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'golden',
  'defi.graph.json',
);

/** §7's definition, in one function so no test can quietly use another. */
function shape(file: GraphFile): { nodes: string[]; edges: string[] } {
  return {
    nodes: file.nodes.map((n) => `${n.kind} ${n.id}`).sort(),
    edges: file.edges
      .map((e: GraphEdge) => `${e.kind}/${e.subkind ?? ''} ${e.from} -> ${e.to}`)
      .sort(),
  };
}

describe('semantic enrichment', () => {
  describe('defi/ with build artifacts', () => {
    it('reads the committed build-info', async () => {
      const files = discoverBuildInfo(detectProject(fixture('defi')));
      expect(files.length).toBeGreaterThan(0);
      const read = readBuildInfo(files[0]!);
      expect('info' in read).toBe(true);
    });

    it('covers every source and reports the compiler', async () => {
      const { semantic, project } = await enrichedGraphOf('defi');
      expect(semantic).not.toBeNull();
      expect(semantic?.stale).toBe(0);
      // Five sources, all of them.
      expect(semantic?.covered).toBe(project.sources.length === 0 ? 0 : 5);
      expect(semantic?.overlay?.compilers).toEqual(['0.8.28']);
    });

    it('exceeds 95% semantic (§7)', async () => {
      const { file } = await enrichedGraphOf('defi');
      const { overall } = file.score;
      const semanticShare = overall.semantic / overall.total;
      expect(semanticShare).toBeGreaterThan(0.95);
      // The remainder is the one honest failure: `token.call(...)` in
      // SafeTransfer, whose target is chosen at runtime. A compiler does not
      // help with that and must not appear to.
      expect(overall.unresolved).toBe(1);
      expect(overall.ambiguous).toBe(0);
      expect(overall.heuristic).toBe(overall.total - overall.semantic - 1);
    });

    it('selects full mode', async () => {
      const { file } = await enrichedGraphOf('defi');
      expect(file.mode).toBe('full');
      expect(file.generator.compilers).toEqual(['0.8.28']);
    });

    it('is identical in shape to the heuristic graph (§7)', async () => {
      const { file } = await enrichedGraphOf('defi');
      const golden = parseGraph(fs.readFileSync(GOLDEN, 'utf8'), GOLDEN);
      expect(shape(file)).toEqual(shape(golden));
    });

    it('changes nothing but confidence, selectors and slots', async () => {
      const { file } = await enrichedGraphOf('defi');
      const golden = parseGraph(fs.readFileSync(GOLDEN, 'utf8'), GOLDEN);

      // Every edge is the same edge, byte for byte, once `resolution`,
      // `possibleTargets` and the now-redundant `reason` are set aside.
      const strip = (e: GraphEdge): unknown => {
        const { resolution, possibleTargets, reason, ...rest } = e;
        void resolution;
        void possibleTargets;
        void reason;
        return rest;
      };
      expect(file.edges.map(strip)).toEqual(golden.edges.map(strip));

      // And every node, once the two semantic-only attributes are.
      const stripNode = (n: GraphFile['nodes'][number]): unknown => {
        const { ...rest } = n as Record<string, unknown>;
        delete rest['selector'];
        delete rest['slot'];
        delete rest['offset'];
        return rest;
      };
      expect(file.nodes.map(stripNode)).toEqual(golden.nodes.map(stripNode));
    });

    it('reports no resolver disagreements', async () => {
      // A `warning` here means the compiler bound a call somewhere the
      // heuristic resolver pointed elsewhere. §7: that is a resolver bug to
      // fix, not a difference to accept.
      const { file } = await enrichedGraphOf('defi');
      expect(file.diagnostics.filter((d) => d.message.includes('compiler binds it to'))).toEqual([]);
    });

    it('adds selectors to externally callable functions and getters', async () => {
      const { file } = await enrichedGraphOf('defi');
      const swap = file.nodes.find(
        (n) => n.id === 'src/Pair.sol:Pair.swap(uint256,uint256,address)',
      );
      expect(swap?.kind === 'Function' ? swap.selector : undefined).toMatch(/^0x[0-9a-f]{8}$/);

      // A public state variable's getter has one too.
      const factory = file.nodes.find((n) => n.id === 'src/Pair.sol:Pair.factory');
      expect(factory?.kind === 'StateVariable' ? factory.selector : undefined).toMatch(
        /^0x[0-9a-f]{8}$/,
      );

      // An internal function has no selector, and the field is absent rather
      // than empty — §10 makes it optional for exactly this reason.
      const internal = file.nodes.find(
        (n) => n.kind === 'Function' && n.visibility === 'internal' && n.hasBody,
      );
      expect(internal?.kind === 'Function' ? 'selector' in internal : true).toBe(false);
    });

    it('adds storage slots in declaration order', async () => {
      const { file } = await enrichedGraphOf('defi');
      const slots = Object.fromEntries(
        file.nodes
          .filter((n) => n.kind === 'StateVariable' && n.file === 'src/Pair.sol')
          .map((n) => (n.kind === 'StateVariable' ? [n.id, n.slot] : [])),
      );

      // `Pair is Shares`, and the layout is the linearization's — the base's
      // variables take slots 0 and 1 and the derived contract's follow. This is
      // the whole reason slots need a compiler: nothing syntactic in Pair.sol
      // says `factory` is slot 2.
      expect(slots).toMatchObject({
        'src/Pair.sol:Shares.totalSupply': '0',
        'src/Pair.sol:Shares.balanceOf': '1',
        'src/Pair.sol:Pair.factory': '2',
        'src/Pair.sol:Pair.token0': '3',
        'src/Pair.sol:Pair.token1': '4',
      });

      // A constant occupies no slot, and says so by having none.
      const constant = file.nodes.find(
        (n) => n.kind === 'StateVariable' && (n.isConstant || n.isImmutable),
      );
      if (constant !== undefined) expect('slot' in constant).toBe(false);
    });

    it('upgrades every kind of edge the compiler can speak to', async () => {
      const { file } = await enrichedGraphOf('defi');
      const semanticKinds = new Set(
        file.edges.filter((e) => e.resolution === 'semantic').map((e) => e.kind),
      );
      // Site-resolved and relation-resolved kinds both, since they take
      // different paths through `graph/semantic.ts`.
      for (const kind of ['calls', 'creates', 'reads', 'writes', 'emits', 'reverts']) {
        expect(semanticKinds, `${kind} edges should reach the semantic tier`).toContain(kind);
      }
      for (const kind of ['inherits', 'implements', 'modifiedBy']) {
        expect(semanticKinds, `${kind} should be confirmed as a relation`).toContain(kind);
      }
      // `declares` is containment and never required resolving a name (§10).
      expect(semanticKinds.has('declares')).toBe(false);
    });

    it('leaves the low-level call unresolved', async () => {
      const { file } = await enrichedGraphOf('defi');
      const unresolved = file.edges.filter((e) => e.resolution === 'unresolved');
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]?.to).toMatch(/^\?low-level:/);
    });
  });

  describe('degradation', () => {
    it('is a no-op on fixtures with no artifacts', async () => {
      for (const name of ['minimal', 'pathological'] as const) {
        const enriched = await buildProjectGraph(fixture(name), {
          cacheDir: null,
          workers: 1,
        });
        expect(enriched.semantic).toBeNull();
        const heuristic = await graphOf(name);
        expect(enriched.file).toEqual(heuristic.file);
      }
    });

    it('ignores build-info that does not match the sources on disk', () => {
      const root = fs.mkdtempSync(path.join(fs.realpathSync(FIXTURE_ROOT), '..', 'tmp-stale-'));
      try {
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(root, 'src', 'A.sol'),
          'pragma solidity ^0.8.0;\ncontract A { function f() public {} }\n',
        );
        fs.mkdirSync(path.join(root, 'out', 'build-info'), { recursive: true });
        fs.writeFileSync(
          path.join(root, 'out', 'build-info', 'stale.json'),
          JSON.stringify({
            solcVersion: '0.8.28',
            // The content the compiler saw, from before someone added a line.
            input: { sources: { 'src/A.sol': { content: 'contract A {}\n' } } },
            output: { sources: { 'src/A.sol': { id: 0, ast: { nodeType: 'SourceUnit', id: 1 } } } },
          }),
        );
        fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\nsrc = "src"\n');

        const project = detectProject(root);
        // The table is irrelevant here: the file is rejected before anything
        // reads its AST, on the bytes alone.
        const load = loadSemanticOverlay({
          project,
          table: {
            symbols: new Map(),
            files: new Map([['src/A.sol', {} as never]]),
            contractsByName: new Map(),
            diagnostics: [],
          } as never,
        });
        expect(load?.overlay ?? null).toBeNull();
        expect(load?.stale).toBe(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
