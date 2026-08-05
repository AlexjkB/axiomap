/**
 * §7's Phase 6 exit criterion, as a test:
 *
 * > **Exit:** a human can audit a small protocol using only the terminal. Do
 * > not proceed until this is true — it is the real proof the engine works.
 *
 * "A human can audit" is not directly assertable, so this walks §15's
 * definition of done — the document's own statement of what a working auditor
 * has to be able to do — using nothing but §12 commands, in the order someone
 * would actually run them. Each step names the item it covers.
 *
 * The protocol under audit is a copy of `defi/` **with its build artifacts
 * removed**, because §15's first item says "an unfamiliar 30-contract protocol
 * *that does not build*". Running this against the compiled fixture would be
 * auditing the happy path and calling it the hard one — decision #1 is the
 * product, and this is where it gets exercised end to end.
 *
 * The one item not covered here is §15's fourth, "click any function and land
 * in the editor at the right byte": there is no editor in a terminal. Its
 * terminal-shaped half — that every row carries a real `file:line` an editor
 * could be pointed at — is asserted in step 4.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBuild, runExport, runQuery, runReview, runStats } from '../src/index.js';
import { plain } from './plain.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-audit-'));
  fs.cpSync(path.join(REPO, 'fixtures/defi'), root, { recursive: true });
  // "A protocol that does not build" — no artifacts, no compiler, decision #1.
  fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a human audits a small protocol using only the terminal', () => {
  it('1. `axiomap build` — a graph of code that does not compile, with an honest score', async () => {
    const result = await runBuild({ path: root });
    const text = plain(result.text);

    // §15 item 2: "see honestly how much of the graph is certain vs inferred."
    // With no artifacts there is nothing a compiler confirmed, and the tool
    // says so rather than implying otherwise.
    expect(result.file.mode).toBe('heuristic');
    expect(result.file.generator.compilers).toEqual([]);
    expect(result.file.score.overall.semantic).toBe(0);
    expect(text).toContain('no build artifacts were read');
    expect(text).toMatch(/resolution\s+\d+ edges — 0% semantic, \d+% heuristic/);

    // …and it produced a usable graph anyway, which is the whole thesis.
    expect(result.file.nodes.length).toBeGreaterThan(50);
  }, 120_000);

  it('2. `axiomap stats` — which contracts are real and which are scaffolding', async () => {
    // §15 item 1.
    const result = await runStats({ path: root });
    const text = plain(result.text);

    expect(result.stats.contracts.total).toBe(9);
    expect(result.stats.contracts.real).toBe(9);
    expect(text).toContain('real / test / mock');
    expect(text).toContain('heuristic');
    // The mode's own copy is shown verbatim (§4: designed states, not errors).
    expect(text).toContain(result.stats.modeReason);
  }, 120_000);

  it('3. `axiomap query externals --unprotected` — the unguarded surface', async () => {
    // §15 item 3: "identify every externally reachable state-mutating function
    // with no access control."
    const result = await runQuery('externals', [], { path: root, unprotected: true });
    const text = plain(result.text);

    expect(result.exitCode).toBe(1);
    expect(text).toContain('Pair.mint');
    expect(text).toContain('Factory.createPair');
    // Never overstated: `none` is "no guard this tool recognises", and the
    // output says which knob makes the tool recognise yours.
    expect(text).toContain('not that the function is unguarded');
    expect(text).toContain('accessControlModifiers');
  }, 120_000);

  it('4. every row carries a file:line an editor can be pointed at', async () => {
    // The terminal half of §15 item 4. §10 makes the byte offset the thing
    // that matters and the line the thing a human reads; a row without one is
    // a row you cannot act on.
    const result = await runQuery('externals', [], { path: root, json: true });
    const parsed = JSON.parse(result.text) as {
      externals: { id: string; src: { file: string; line: number; offset: number } }[];
    };
    expect(parsed.externals.length).toBeGreaterThan(0);
    for (const row of parsed.externals) {
      expect(row.src.file).toMatch(/\.sol$/);
      expect(row.src.line).toBeGreaterThan(0);
      expect(row.src.offset).toBeGreaterThanOrEqual(0);
    }
    expect(plain((await runQuery('externals', [], { path: root })).text)).toMatch(
      /src\/Pair\.sol:\d+/,
    );
  }, 120_000);

  it('5. `writers-of` a storage variable, then follow each writer back', async () => {
    // §15 item 5: "select a storage variable and see every writer, then click
    // through each." In a terminal, "click through" is the next query.
    const writers = await runQuery('writers-of', ['reserve0'], { path: root, json: true });
    const parsed = JSON.parse(writers.text) as {
      accessors: { function: string; sites: { file: string; line: number }[] }[];
    };
    expect(parsed.accessors.map((row) => row.function)).toEqual([
      'src/Pair.sol:Pair._update(uint256,uint256)',
    ]);
    expect(parsed.accessors[0]?.sites[0]?.line).toBeGreaterThan(0);

    // Follow it back to an external entrypoint: who can reach the writer.
    const callers = await runQuery('callers-of', ['Pair._update'], {
      path: root,
      depth: 3,
      json: true,
    });
    const reached = (JSON.parse(callers.text) as { hits: { id: string }[] }).hits.map((h) => h.id);
    expect(reached).toContain('src/Pair.sol:Pair.swap(uint256,uint256,address)');

    // …and get the exact route, with the call site of each hop.
    const route = await runQuery(
      'path',
      ['Router.swapExactTokensForTokens', 'Pair._update'],
      { path: root, json: true },
    );
    const steps = (JSON.parse(route.text) as { found: boolean; path: unknown[] });
    expect(steps.found).toBe(true);
    expect(steps.path.length).toBeGreaterThan(0);
  }, 120_000);

  it('6. `axiomap query unresolved` — the graph says where it is uncertain', async () => {
    // §4: "show me every unresolved external call is one of the most valuable
    // queries an auditor can run", and it is a graph query like any other.
    const result = await runQuery('unresolved', [], { path: root, json: true });
    const parsed = JSON.parse(result.text) as {
      unresolved: { category: string; callee: string; from: string }[];
    };
    expect(parsed.unresolved).toHaveLength(1);
    expect(parsed.unresolved[0]).toMatchObject({ category: 'low-level', callee: 'call' });
    expect(result.exitCode).toBe(1);
  }, 120_000);

  it('7. mark functions reviewed; the state survives the process', async () => {
    // §15 item 6: "mark functions reviewed, close the laptop, reopen tomorrow,
    // still have the state." Every command here reads `.axiomap/review.json`
    // from disk, so a second command *is* the reopened laptop.
    await runReview('Pair.mint', {
      path: root,
      status: 'reviewed',
      reviewer: 'alice',
      note: 'rounding on the first mint',
    });
    await runReview('Pair.swap', { path: root, status: 'flagged', reviewer: 'alice' });

    const listed = await runReview(undefined, { path: root, json: true });
    const reviews = (JSON.parse(listed.text) as {
      reviews: { node: string; staleness: string; entry: { status: string } }[];
    }).reviews;
    expect(reviews).toHaveLength(2);
    expect(reviews.every((row) => row.staleness === 'current')).toBe(true);

    // It is a real file, in the shape §8 specifies, meant to be committed.
    const stored = JSON.parse(
      fs.readFileSync(path.join(root, '.axiomap/review.json'), 'utf8'),
    ) as Record<string, { status: string; bodyHash: string; reviewer: string; at: string }>;
    expect(stored['src/Pair.sol:Pair.mint(address)']?.status).toBe('reviewed');
    expect(stored['src/Pair.sol:Pair.mint(address)']?.bodyHash).not.toBe('');
  }, 120_000);

  it('8. the protocol changes; `stale-reviews` says exactly what to look at again', async () => {
    // §8 calls this the flagship feature, and §15 item 7 is the workflow it
    // produces. Editing one reviewed function must invalidate that review and
    // only that review.
    const file = path.join(root, 'src/Pair.sol');
    const source = fs.readFileSync(file, 'utf8');
    const at = source.indexOf('function mint(');
    const brace = source.indexOf('{', at);
    fs.writeFileSync(
      file,
      `${source.slice(0, brace + 1)}\n        uint256 _audit = 1; _audit;${source.slice(brace + 1)}`,
    );

    const result = await runQuery('stale-reviews', [], { path: root, json: true });
    const stale = (JSON.parse(result.text) as { stale: { node: string; staleness: string }[] }).stale;

    expect(stale).toHaveLength(1);
    expect(stale[0]?.node).toBe('src/Pair.sol:Pair.mint(address)');
    expect(stale[0]?.staleness).toBe('stale');
    // The flagged `swap`, which was not touched, is still current — a re-review
    // list that includes everything is a re-review list nobody reads.
    expect(result.exitCode).toBe(1);
    expect(plain((await runQuery('stale-reviews', [], { path: root })).text)).toContain('stale');
  }, 120_000);

  it('9. `axiomap export` — a shareable artifact of what was audited', async () => {
    // §15 item 9 asks for one HTML file, which needs the renderer Phase 7
    // brings (§16). The terminal form of the same need is a dot or mermaid
    // graph, which is what ships now.
    const target = path.join(root, 'protocol.dot');
    await runExport({ path: root, format: 'dot', out: target });
    const dot = fs.readFileSync(target, 'utf8');

    expect(dot).toContain('digraph axiomap {');
    expect(dot).toContain('contract Pair');
    expect(dot).toContain('interface IPair');

    const mermaid = await runExport({ path: root, format: 'mermaid', view: 'state-access' });
    expect(mermaid.text).toContain('flowchart LR');
  }, 120_000);

  it('10. the CI gate: `--json` everywhere, and an exit code that means something', async () => {
    // §15 item 8: "run `axiomap query unresolved --json` in CI and fail the
    // build on new unresolved external calls."
    for (const sub of ['unresolved', 'externals', 'stale-reviews']) {
      const result = await runQuery(sub, [], { path: root, json: true });
      expect(() => JSON.parse(result.text)).not.toThrow();
      expect(result.exitCode).toBe(1);
    }

    // Nothing found is 0, so `... && echo clean` works.
    const clean = await runQuery('externals', [], { path: root, payable: true, json: true });
    expect(clean.exitCode).toBe(0);
  }, 120_000);
});
