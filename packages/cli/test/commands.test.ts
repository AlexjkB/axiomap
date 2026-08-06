/**
 * §12's command surface, command by command.
 *
 * Each command is called as a function rather than through a spawned process —
 * `bin.ts` is the only file that touches `process`, which is what makes this
 * possible and is why Phase 5 shaped `runDiff` that way. The argument wiring
 * itself is covered by `program.test.ts`.
 *
 * Commands write into the project directory (`.axiomap/`), so every test runs
 * against a **copy** of a fixture rather than the fixture itself. A suite that
 * mutated `fixtures/defi` would break the goldens, Phase 1's symbol counts and
 * Phase 5's tags all at once.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  runBuild,
  runExport,
  runImportFindings,
  runQuery,
  runReview,
  runStats,
} from '../src/index.js';
import { plain } from './plain.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary: string[] = [];

function copyFixture(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `axiomap-cli-${name}-`));
  temporary.push(root);
  fs.cpSync(path.join(REPO, 'fixtures', name), root, { recursive: true });
  return root;
}

afterAll(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

let defi: string;

beforeAll(() => {
  defi = copyFixture('defi');
});

describe('axiomap build (§12)', () => {
  it('writes the artifact and prints §4\'s score and mode', async () => {
    const result = await runBuild({ path: defi });
    expect(result.exitCode).toBe(0);

    const text = plain(result.text);
    expect(text).toContain('mode');
    // §4: "Print it on every build." The score is the headline, not a footnote.
    expect(text).toMatch(/resolution\s+\d+ edges — \d+% semantic/);
    expect(fs.existsSync(path.join(defi, '.axiomap/graph.json'))).toBe(true);
  }, 60_000);

  it('ships the safe git default into .axiomap/ (§5)', () => {
    const ignore = fs.readFileSync(path.join(defi, '.axiomap/.gitignore'), 'utf8');
    expect(ignore).toContain('graph.json');
    expect(ignore).toContain('cache/');
    expect(ignore).toContain('findings.json');
    // review.json is deliberately absent: it is meant to be committed.
    expect(ignore).not.toContain('review.json');
  });

  it('--json carries the score and the artifact path', async () => {
    const result = await runBuild({ path: defi, json: true });
    const parsed = JSON.parse(result.text) as { mode: string; score: { overall: { total: number } } };
    expect(['full', 'heuristic', 'structural']).toContain(parsed.mode);
    expect(parsed.score.overall.total).toBeGreaterThan(0);
  }, 60_000);
});

describe('axiomap stats (§12, §15\'s first two items)', () => {
  it('separates real contracts from scaffolding and states the mode', async () => {
    const result = await runStats({ path: defi });
    const text = plain(result.text);
    expect(text).toContain('real / test / mock');
    expect(text).toContain('unguarded');
    expect(text).toMatch(/resolution\s+\d+ edges/);
  }, 60_000);
});

describe('axiomap query (§12)', () => {
  it('exits 1 when it finds something and 0 when it does not', async () => {
    // §15's eighth item is a CI gate, so the two outcomes have to be
    // distinguishable without parsing the output.
    const found = await runQuery('externals', [], { path: defi });
    expect(found.exitCode).toBe(1);

    const empty = await runQuery('externals', [], { path: defi, payable: true });
    expect(empty.exitCode).toBe(0);
  }, 60_000);

  it('accepts a short node reference', async () => {
    const result = await runQuery('callers-of', ['Pair.mint'], { path: defi });
    expect(plain(result.text)).toContain('Router.addLiquidity');
  }, 60_000);

  it('refuses an ambiguous reference and lists the candidates', async () => {
    // `mint` is on both `Pair` and `IPair`. Picking one silently would mislead.
    await expect(runQuery('callers-of', ['mint'], { path: defi })).rejects.toThrow(/matches 2 nodes/);
  }, 60_000);

  it('unresolved --json is the shape §15\'s CI gate reads', async () => {
    const result = await runQuery('unresolved', [], { path: defi, json: true });
    const parsed = JSON.parse(result.text) as {
      unresolved: { category: string; callee: string }[];
    };
    expect(parsed.unresolved).toHaveLength(1);
    expect(parsed.unresolved[0]?.category).toBe('low-level');
    expect(result.exitCode).toBe(1);
  }, 60_000);

  it('writers-of narrows to state variables', async () => {
    const result = await runQuery('writers-of', ['reserve0'], { path: defi, json: true });
    const parsed = JSON.parse(result.text) as { accessors: { function: string }[] };
    expect(parsed.accessors.map((row) => row.function)).toEqual([
      'src/Pair.sol:Pair._update(uint256,uint256)',
    ]);
  }, 60_000);

  it('rejects an unknown subcommand by naming the real ones', async () => {
    await expect(runQuery('callers', [], { path: defi })).rejects.toThrow(/callers-of/);
  }, 60_000);
});

describe('axiomap export (§12)', () => {
  it('emits dot with §4\'s confidence in the line style', async () => {
    const result = await runExport({ path: defi, format: 'dot' });
    expect(result.text).toContain('digraph axiomap {');
    // §4: the four resolution values render distinctly, and that "is a feature,
    // not an apology". A dot file that drew them identically would be the tool
    // implying certainty it does not have.
    expect(result.text).toMatch(/style=(solid|dashed|dotted)/);
  }, 60_000);

  it('emits mermaid with identifier-safe ids and qualified labels', async () => {
    const result = await runExport({ path: defi, format: 'mermaid', view: 'inheritance' });
    expect(result.text).toContain('flowchart LR');
    expect(result.text).toMatch(/n\d+\["/);
  }, 60_000);

  it('the call view refuses to draw without a focus (§9 rule 4)', async () => {
    await expect(runExport({ path: defi, format: 'dot', view: 'call' })).rejects.toThrow(
      /requires a focus node/,
    );
  }, 60_000);

  /**
   * Phase 6 asserted that `html` and `svg` were *deferred* — §16's reason being
   * that both need the layout engine §7 puts in Phase 7. Phase 7d shipped them,
   * so this now asserts the other half of that: §12's five formats are all
   * there, and a sixth is still refused by name rather than guessed at.
   * `export-rendered.test.ts` covers what the two of them produce.
   */
  it('accepts all five of §12’s formats, and refuses a sixth by name', async () => {
    await expect(runExport({ path: defi, format: 'pdf' })).rejects.toThrow(/Unknown format/);
    // The message names what *is* available, so the refusal is actionable (§6).
    await expect(runExport({ path: defi, format: 'pdf' })).rejects.toThrow(/dot, mermaid, json, html, svg/);

    // `html` is a file rather than a stream, and says so instead of printing
    // three megabytes into a terminal.
    await expect(runExport({ path: defi, format: 'html' })).rejects.toThrow(/--out/);
  }, 60_000);

  it('writes to a file when asked', async () => {
    const target = path.join(defi, 'out.dot');
    const result = await runExport({ path: defi, format: 'dot', out: target });
    expect(fs.existsSync(target)).toBe(true);
    expect(plain(result.text)).toContain('Wrote');
  }, 60_000);
});

describe('axiomap review (§12, §8\'s flagship feature)', () => {
  it('records a review against the current body hash, and it starts current', async () => {
    const root = copyFixture('defi');
    const set = await runReview('Pair.swap', {
      path: root,
      status: 'reviewed',
      reviewer: 'alice',
      note: 'checked the k invariant',
      json: true,
    });
    const parsed = JSON.parse(set.text) as { node: string; entry: { bodyHash: string } };
    expect(parsed.node).toBe('src/Pair.sol:Pair.swap(uint256,uint256,address)');
    expect(parsed.entry.bodyHash).not.toBe('');

    const stale = await runQuery('stale-reviews', [], { path: root });
    expect(stale.exitCode).toBe(0);
    expect(plain(stale.text)).toContain('current');
  }, 120_000);

  it('goes stale when the body changes, which is the whole mechanism (§8)', async () => {
    const root = copyFixture('defi');
    await runReview('Pair.mint', { path: root, status: 'reviewed', reviewer: 'bob' });

    const file = path.join(root, 'src/Pair.sol');
    const source = fs.readFileSync(file, 'utf8');
    const at = source.indexOf('function mint(');
    const brace = source.indexOf('{', at);
    fs.writeFileSync(
      file,
      `${source.slice(0, brace + 1)}\n        uint256 _probe = 1; _probe;${source.slice(brace + 1)}`,
    );

    const stale = await runQuery('stale-reviews', [], { path: root, json: true });
    const parsed = JSON.parse(stale.text) as { stale: { node: string; staleness: string }[] };
    expect(parsed.stale).toHaveLength(1);
    expect(parsed.stale[0]?.staleness).toBe('stale');
    expect(stale.exitCode).toBe(1);
  }, 120_000);

  it('rejects a status that is not one of §8\'s four', async () => {
    await expect(runReview('Pair.mint', { path: defi, status: 'looksfine' })).rejects.toThrow(
      /not a review status/,
    );
  }, 60_000);

  it('--clear removes an entry', async () => {
    const root = copyFixture('defi');
    await runReview('Pair.burn', { path: root, status: 'flagged' });
    const cleared = await runReview('Pair.burn', { path: root, clear: true });
    expect(plain(cleared.text)).toContain('Cleared review');
    const listed = await runReview(undefined, { path: root, json: true });
    expect((JSON.parse(listed.text) as { reviews: unknown[] }).reviews).toEqual([]);
  }, 120_000);
});

describe('axiomap import-findings (§12, decision #4)', () => {
  it('maps a Slither finding onto a node by byte offset and persists it', async () => {
    const root = copyFixture('defi');
    const source = fs.readFileSync(path.join(root, 'src/Pair.sol'));
    const start = source.indexOf('function swap(');

    const file = path.join(root, 'slither.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        success: true,
        error: null,
        results: {
          detectors: [
            {
              check: 'reentrancy-eth',
              impact: 'High',
              confidence: 'Medium',
              description: 'Reentrancy in Pair.swap',
              elements: [
                {
                  type: 'function',
                  name: 'swap',
                  source_mapping: {
                    start,
                    length: 30,
                    filename_relative: 'src/Pair.sol',
                    lines: [112],
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    const result = await runImportFindings(file, { path: root, json: true });
    const parsed = JSON.parse(result.text) as {
      mapped: number;
      findings: { nodes: { id: string; bodyHash: string }[] }[];
    };
    expect(parsed.mapped).toBe(1);
    expect(parsed.findings[0]?.nodes.map((n) => n.id)).toEqual([
      'src/Pair.sol:Pair.swap(uint256,uint256,address)',
    ]);
    // The body it was found on, so the finding can go stale (§8's mechanism).
    expect(parsed.findings[0]?.nodes[0]?.bodyHash).not.toBe('');
    expect(fs.existsSync(path.join(root, '.axiomap/findings.json'))).toBe(true);

    const listed = await runQuery('findings', [], { path: root });
    expect(plain(listed.text)).toContain('reentrancy-eth');
  }, 120_000);

  it('says where to get one when the file is missing', async () => {
    await expect(runImportFindings('/nonexistent/slither.json', { path: defi })).rejects.toThrow(
      /slither/,
    );
  });
});

describe('§13\'s config, which nothing read before this phase', () => {
  it('exclude drops files before they are parsed', async () => {
    const root = copyFixture('defi');
    fs.writeFileSync(
      path.join(root, 'axiomap.config.json'),
      JSON.stringify({ exclude: ['src/interfaces/**'] }),
    );
    const result = await runBuild({ path: root, json: true });
    const parsed = JSON.parse(result.text) as { project: { files: number } };
    expect(parsed.project.files).toBe(4);
  }, 60_000);

  it('accessControlModifiers changes what counts as unguarded (§15\'s third item)', async () => {
    const root = copyFixture('defi');
    const before = await runQuery('externals', [], { path: root, unprotected: true, json: true });
    const beforeCount = (JSON.parse(before.text) as { externals: unknown[] }).externals.length;

    // `defi/`'s mutex is spelled `lock`, not `nonReentrant` — the motivating
    // case §16 already records. Teaching the tool the protocol's own spelling
    // is what §13 is for.
    fs.writeFileSync(
      path.join(root, 'axiomap.config.json'),
      JSON.stringify({ accessControlModifiers: ['onlyOwner', 'lock'] }),
    );
    const after = await runQuery('externals', [], {
      path: root,
      unprotected: true,
      json: true,
      rebuild: true,
    });
    const afterCount = (JSON.parse(after.text) as { externals: unknown[] }).externals.length;
    expect(afterCount).toBeLessThan(beforeCount);
  }, 120_000);

  it('an unknown key warns rather than failing the build', async () => {
    const root = copyFixture('defi');
    fs.writeFileSync(path.join(root, 'axiomap.config.json'), JSON.stringify({ renderCapp: 10 }));
    const result = await runBuild({ path: root });
    expect(result.exitCode).toBe(0);
    expect(plain(result.text)).toContain('unknown key "renderCapp"');
  }, 60_000);
});

describe('the stored artifact is used only while it is still true', () => {
  it('is reused when nothing changed, and rebuilt when a source is newer', async () => {
    const root = copyFixture('defi');
    await runBuild({ path: root });

    const { loadGraph, openProject } = await import('../src/context.js');
    const context = openProject({ path: root });
    expect((await loadGraph(context, {})).origin).toBe('artifact');

    // Touching a source makes the artifact a claim about code that has since
    // changed — which for `axiomap review` would mean storing the hash of a
    // body the reviewer never read.
    const file = path.join(root, 'src/Pair.sol');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n// touched\n`);
    const reloaded = await loadGraph(context, {});
    expect(reloaded.origin).toBe('built');
    expect(reloaded.reason).toContain('newer');

    // …unless the user says they know better.
    expect((await loadGraph(context, { stale: true })).origin).toBe('artifact');
  }, 120_000);
});

describe('an artifact only answers the question it was built for', () => {
  /**
   * The mtime check catches an edited config at the default path. It cannot
   * catch `--config elsewhere.json` or a graph built with `--no-enrich`, and in
   * both of those cases the stored graph is a confident answer to a *different*
   * question. `graph.json` records its settings so this is detectable at all.
   */
  it('rebuilds when the stored graph was built with a different guard list', async () => {
    const root = copyFixture('defi');
    const elsewhere = path.join(root, 'strict.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ accessControlModifiers: ['lock'] }));

    await runBuild({ path: root });
    const { loadGraph, openProject } = await import('../src/context.js');

    // Same project, same sources, same mtimes — only the config differs, and
    // the config lives outside the project so no mtime could have caught it.
    const strict = openProject({ path: root, config: elsewhere });
    const reloaded = await loadGraph(strict, { config: elsewhere });
    expect(reloaded.origin).toBe('built');
    expect(reloaded.reason).toContain('different settings');

    // And the answer actually differs, which is why it mattered.
    const guarded = await runQuery('externals', [], {
      path: root,
      config: elsewhere,
      unprotected: true,
      json: true,
    });
    const plain_ = await runQuery('externals', [], { path: root, unprotected: true, json: true });
    const count = (text: string): number =>
      (JSON.parse(text) as { externals: unknown[] }).externals.length;
    expect(count(guarded.text)).toBeLessThan(count(plain_.text));
  }, 180_000);

  it('a settings mismatch is not staleness, so --stale does not suppress it', async () => {
    const root = copyFixture('defi');
    await runBuild({ path: root });
    const { loadGraph, openProject } = await import('../src/context.js');

    const context = openProject({ path: root });
    expect((await loadGraph(context, { stale: true })).origin).toBe('artifact');
    // `--stale` means "the sources moved on and I know it", not "answer a
    // different question than the one I asked".
    const other = await loadGraph(context, { stale: true, noEnrich: true });
    expect(other.origin).toBe('built');
    expect(other.reason).toContain('different settings');
  }, 180_000);
});
