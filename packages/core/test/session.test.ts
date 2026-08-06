/**
 * The artifact policy: *is `.axiomap/graph.json` still true?*
 *
 * Phase 8a moved this into core, and §5 says why in as many words: two answers
 * to that question means "the editor and the terminal disagreeing about whether
 * the graph on screen describes the code on disk". The Phase 8b boundary audit
 * found it at **5% coverage** — the CLI exercised it end to end, so nothing was
 * broken, but the one file whose entire job is a policy had no test of the
 * policy. Every branch of `loadProjectGraph` is a different answer to a user's
 * "why am I looking at this graph", and each is asserted here.
 *
 * Plus the audit's round-trip probe: an artifact written and read back must be
 * the same graph. `graph.json` is a public artifact with a `schemaVersion`
 * (§3), and a serializer that loses a field is the failure that shows up as a
 * feature quietly not working in whichever host reads rather than builds.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GRAPH_FILE,
  loadProjectGraph,
  newestInput,
  openProject,
  readOverlayFiles,
  writeGraph,
} from '../src/index.js';

const SOURCES: Record<string, string> = {
  'foundry.toml': '[profile.default]\nsrc = "src"\n',
  'src/Vault.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Vault {
    uint256 public total;
    modifier onlyOwner() { _; }
    function deposit(uint256 amount) external { total += amount; _after(amount); }
    function sweep() external onlyOwner { total = 0; }
    function _after(uint256 amount) internal { total = amount; }
}
`,
};

const roots: string[] = [];

function project(extra: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-session-'));
  roots.push(root);
  for (const [name, source] of Object.entries({ ...SOURCES, ...extra })) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
  return root;
}

/** Write the artifact the way `axiomap build` does, then age it or the sources. */
async function withArtifact(root: string): Promise<void> {
  const built = await loadProjectGraph(openProject({ path: root, cacheDir: null, workers: 1 }));
  const target = path.join(root, GRAPH_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeGraph(target, built.file);
}

/** Make the artifact look older than the sources, without waiting a second. */
function ageArtifact(root: string, byMs: number): void {
  const target = path.join(root, GRAPH_FILE);
  const when = new Date(Date.now() - byMs);
  fs.utimesSync(target, when, when);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const options = { cacheDir: null, workers: 1 } as const;

describe('which graph a host gets, and why', () => {
  it('builds when there is no artifact, and says so', async () => {
    const root = project();
    const loaded = await loadProjectGraph(openProject({ path: root, ...options }));

    expect(loaded.origin).toBe('built');
    // Nothing was superseded, so there is nothing to explain.
    expect(loaded.reason).toBeNull();
    expect(loaded.graph.hasNode('src/Vault.sol:Vault.deposit(uint256)')).toBe(true);
  });

  it('reads the artifact while no source is newer than it', async () => {
    const root = project();
    await withArtifact(root);

    const loaded = await loadProjectGraph(openProject({ path: root, ...options }));
    expect(loaded.origin).toBe('artifact');
    expect(loaded.reason).toBeNull();
  });

  it('rebuilds when a source is newer, and names the source as the reason', async () => {
    const root = project();
    await withArtifact(root);
    ageArtifact(root, 60_000);

    const loaded = await loadProjectGraph(openProject({ path: root, ...options }));
    expect(loaded.origin).toBe('built');
    expect(loaded.reason).toBe('a source file is newer than .axiomap/graph.json');
  });

  it('rebuilds when §13’s settings changed under the artifact', async () => {
    const root = project();
    await withArtifact(root);

    // Not staleness — the sources have not moved. A graph built with the
    // default guard list is a confident answer to a *different question* than
    // one asked with `accessControlModifiers: ["auth"]`, and handing it back
    // would be the kind of wrong this tool exists not to be.
    fs.writeFileSync(
      path.join(root, 'axiomap.config.json'),
      JSON.stringify({ accessControlModifiers: ['auth'] }),
    );
    const loaded = await loadProjectGraph(
      openProject({ path: root, ...options }),
      // `stale` says "the sources moved on and I know it"; it must not suppress
      // this, which is a category error rather than staleness.
      { stale: true },
    );

    expect(loaded.origin).toBe('built');
    expect(loaded.reason).toBe(
      '.axiomap/graph.json was built with different settings (AXIOMAP.md §13)',
    );
  });

  it('rebuilds rather than failing on an artifact it cannot read', async () => {
    const root = project();
    await withArtifact(root);
    fs.writeFileSync(path.join(root, GRAPH_FILE), '{ not json');

    // The sources are still there and they are the truth; a hand-edited or
    // schema-mismatched artifact is a reason to rebuild, not to stop. The
    // message still surfaces, so nothing is silent.
    const loaded = await loadProjectGraph(openProject({ path: root, ...options }));
    expect(loaded.origin).toBe('built');
    expect(loaded.reason).not.toBeNull();
    expect(loaded.graph.order).toBeGreaterThan(0);
  });

  it('takes the artifact under `stale` even when a source is newer', async () => {
    const root = project();
    await withArtifact(root);
    ageArtifact(root, 60_000);

    const loaded = await loadProjectGraph(openProject({ path: root, ...options }), {
      stale: true,
    });
    expect(loaded.origin).toBe('artifact');
  });

  it('rebuilds on request, artifact or not', async () => {
    const root = project();
    await withArtifact(root);

    const started: string[] = [];
    const loaded = await loadProjectGraph(
      openProject({ path: root, ...options }),
      { rebuild: true },
      { onBuildStart: (at) => started.push(at) },
    );

    expect(loaded.origin).toBe('built');
    expect(loaded.reason).toBeNull();
    // The hook is the reason this is a hook: a terminal wants a spinner and an
    // editor wants a progress notification, and neither belongs in core.
    expect(started).toEqual([root]);
  });

  it('counts the config among the inputs an artifact can be older than', () => {
    const root = project();
    const before = newestInput(root);
    expect(before).not.toBeNull();

    const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(path.join(root, 'axiomap.config.json'), '{}');
    fs.utimesSync(path.join(root, 'axiomap.config.json'), later, later);

    expect(newestInput(root)).toBeGreaterThan(before as number);
  });
});

describe('the artifact round trip', () => {
  it('reads back the graph it wrote', async () => {
    const root = project();
    const built = await loadProjectGraph(openProject({ path: root, ...options }));
    await withArtifact(root);

    const read = await loadProjectGraph(openProject({ path: root, ...options }));
    expect(read.origin).toBe('artifact');

    // The graph, not the file: node ids, edge count, and every attribute of
    // every node. A serializer that dropped a field would still produce a graph
    // that draws, and the missing field would show up as a feature quietly not
    // working in whichever host reads rather than builds.
    expect(read.graph.nodes().sort()).toEqual(built.graph.nodes().sort());
    expect(read.graph.size).toBe(built.graph.size);
    for (const id of built.graph.nodes()) {
      expect(read.graph.getNodeAttributes(id), id).toEqual(built.graph.getNodeAttributes(id));
    }
    for (const edge of built.graph.edges()) {
      expect(read.graph.getEdgeAttributes(edge), edge).toEqual(
        built.graph.getEdgeAttributes(edge),
      );
    }
  });

  it('serializes to the same bytes twice, from two separate builds', async () => {
    const root = project();
    const one = await loadProjectGraph(openProject({ path: root, ...options }));
    const two = await loadProjectGraph(openProject({ path: root, ...options }), { rebuild: true });

    // Determinism is what makes the golden files a test at all (§6), and it is
    // what lets a diff between two revisions mean "the protocol changed"
    // rather than "the tool ran twice".
    expect(JSON.stringify(two.file.nodes)).toBe(JSON.stringify(one.file.nodes));
    expect(JSON.stringify(two.file.edges)).toBe(JSON.stringify(one.file.edges));
  });
});

describe('the two file-backed overlays', () => {
  it('is absent rather than empty when neither file exists', () => {
    const files = readOverlayFiles(project());
    // Absent and empty stay distinguishable: "nobody has reviewed anything" and
    // "everything is unreviewed" are the same picture and different sentences.
    expect(files.review).toBeNull();
    expect(files.findings).toBeNull();
    expect(files.warnings).toEqual([]);
  });

  it('warns and carries on when one is malformed', () => {
    const root = project();
    fs.mkdirSync(path.join(root, '.axiomap'), { recursive: true });
    fs.writeFileSync(path.join(root, '.axiomap/review.json'), 'not json at all');

    // A hand-edited `review.json` must not cost somebody the tool.
    const files = readOverlayFiles(root);
    expect(files.review).toBeNull();
    expect(files.warnings).toHaveLength(1);
    expect(files.warnings[0]).toContain('Review state not loaded');
  });

  it('reads a review file that is there', () => {
    const root = project();
    fs.mkdirSync(path.join(root, '.axiomap'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.axiomap/review.json'),
      JSON.stringify({
        'src/Vault.sol:Vault.deposit(uint256)': {
          status: 'reviewed',
          bodyHash: 'abc',
          at: '2026-08-06T00:00:00Z',
        },
      }),
    );

    const files = readOverlayFiles(root);
    expect(files.warnings).toEqual([]);
    expect(Object.keys(files.review ?? {})).toEqual(['src/Vault.sol:Vault.deposit(uint256)']);
  });
});
