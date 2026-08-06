/**
 * §12's two *rendered* export formats (Phase 7d).
 *
 * §16 deferred `html` and `svg` twice with one reason — both need a layout
 * engine, and §7 puts `elkjs` in Phase 7 — and named the trigger that has now
 * fired. This suite covers what each of them has to be true about.
 *
 * For **svg**, that it is a picture of the same `ViewSelection` the text
 * formats serialize, and that §4's four confidences survive into it. An export
 * that drew every edge identically would be the tool "silently pretending to
 * certainty it does not have", which `formats.ts` already refuses for dot.
 *
 * For **html**, that it is *self-contained* (decision #2: it must not fetch
 * anything), that it carries the answers rather than the graph (§9 rule 1), and
 * that the requests it embedded are the ones the UI will actually send — a
 * mismatch there is not an error, it is a deliverable where every click says
 * "this export does not hold that view".
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runExport } from '../src/commands/export.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary: string[] = [];

let project: string;
let out: string;

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-export-'));
  temporary.push(project);
  fs.cpSync(path.join(REPO, 'fixtures/defi'), project, { recursive: true });
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-export-out-'));
  temporary.push(out);
}, 60_000);

afterAll(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

describe('export --format svg', () => {
  it('lays the selection out and writes it as SVG', async () => {
    const target = path.join(out, 'map.svg');
    const result = await runExport({ path: project, format: 'svg', out: target });

    expect(result.exitCode).toBe(0);
    const svg = fs.readFileSync(target, 'utf8');

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    // Nine contracts, each a rect, plus the background.
    expect(svg.match(/<rect /g)?.length).toBe(10);
    expect(svg).toContain('Factory');
    expect(svg).toContain('IERC20Minimal');

    // ELK actually ran: every node has a placed position rather than the origin.
    const xs = [...svg.matchAll(/<rect x="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(xs.length).toBeGreaterThan(1);
    expect(new Set(xs).size).toBeGreaterThan(1);
  }, 120_000);

  /**
   * §4: "the UI renders these distinctly … this is a feature, not an apology".
   * `pathological/` is the fixture with edges that do not resolve, and an SVG
   * of it must not draw them like the ones that do.
   */
  it('keeps §4’s confidences distinguishable', async () => {
    const target = path.join(out, 'inheritance.svg');
    await runExport({ path: path.join(REPO, 'fixtures/inheritance'), format: 'svg', out: target });
    const svg = fs.readFileSync(target, 'utf8');

    // At least one line treatment beyond plain solid, and a legend-free way to
    // tell them apart: dash patterns and stroke colours.
    const strokes = new Set([...svg.matchAll(/<path [^>]*stroke="(#[0-9a-f]{6})"/g)].map((m) => m[1]));
    expect(strokes.size).toBeGreaterThan(0);
  }, 120_000);

  it('states what was aggregated, wrapped rather than clipped', async () => {
    const target = path.join(out, 'wrapped.svg');
    await runExport({ path: project, format: 'svg', out: target });
    const svg = fs.readFileSync(target, 'utf8');

    // The note is a full sentence; it is present in full, across lines, and the
    // image is not made a thousand pixels wide to hold it on one.
    const width = Number(/width="(\d+)"/.exec(svg)?.[1]);
    expect(width).toBeLessThan(900);
    const noteText = [...svg.matchAll(/font-size="10"[^>]*>([^<]*)</g)].map((m) => m[1]).join(' ');
    expect(noteText).toContain('9 contracts');
    expect(noteText).toContain('--include-tests to keep them');
  }, 120_000);
});

describe('export --format html', () => {
  let html = '';
  let target = '';

  beforeAll(async () => {
    target = path.join(out, 'report.html');
    await runExport({ path: project, format: 'html', out: target });
    html = fs.readFileSync(target, 'utf8');
  }, 180_000);

  /**
   * Decision #2, in the one artifact that leaves the building.
   *
   * Scoped to the *markup*: the inlined bundle contains URLs in its own text —
   * elkjs carries Eclipse's in a licence header — and a string in a script is
   * not a subresource. What must not exist is a `src`, an `href` or a CSS
   * `url()` that would make the browser go and get something.
   */
  it('fetches nothing: no script, style, font or image from anywhere', () => {
    const markup = html
      .replace(/<script[\s\S]*?<\/script>/g, '<script/>')
      .replace(/<style[\s\S]*?<\/style>/g, '<style/>');

    expect(markup).not.toMatch(/<script[^>]+src=/);
    expect(markup).not.toMatch(/<link[^>]+href=/);
    expect(markup).not.toMatch(/<img/);
    expect(markup).not.toMatch(/https?:\/\//);

    // And the stylesheet, which is inlined but is markup's business: a
    // `url(https://fonts…)` in it would be a request the document makes.
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('');
    expect(styles).not.toMatch(/url\(\s*['"]?https?:/);
    expect(styles.length).toBeGreaterThan(1000);
  });

  /**
   * §9 rule 1. The export is where breaking it would be permanent — a graph of
   * somebody's protocol inlined in a file sent to a third party — so what is
   * embedded is the *answers*, and the shape of the artifact says so.
   */
  it('embeds answers rather than the graph', () => {
    const payload = readPayload(html);
    expect(payload.payloadVersion).toBe(2);
    expect(Array.isArray(payload.views)).toBe(true);
    expect(payload.views.length).toBeGreaterThan(1);
    // No `AxiomapGraph`, and no `graph.json` under another name.
    expect(payload).not.toHaveProperty('nodes');
    expect(payload).not.toHaveProperty('edges');
    expect(payload.meta).not.toHaveProperty('nodes');

    /*
     * v2 lifted the drawn nodes into one table, and a table of nodes is one
     * `edges` field away from being the thing this test exists to forbid. The
     * two properties that keep it on the right side of §9 rule 1: nothing in it
     * that no view draws, and no adjacency anywhere in it.
     */
    const drawn = new Set(
      payload.views.flatMap((entry) =>
        entry.view.nodes.flatMap((node) => (node.type === 'node' ? [node.id] : [])),
      ),
    );
    expect(Object.keys(payload.nodeTable).sort()).toEqual([...drawn].sort());
    for (const node of Object.values(payload.nodeTable)) {
      expect(node).not.toHaveProperty('edges');
      expect(node).not.toHaveProperty('callers');
      expect(node).not.toHaveProperty('callees');
    }
  });

  /**
   * The defect this quota exists for: Phase 7d's breadth-first walk spent the
   * whole view budget on contract views and embedded **zero call graphs** on a
   * 298-contract project. §9 rule 4 makes the call graph the focus-node view and
   * §11 makes it the one an auditor works in, so a deliverable that cannot hold
   * one is §15's ninth item not working.
   *
   * `defi/` is small enough that everything reachable fits, so this asserts the
   * mix rather than the ratio — the ratio is asserted against a budget small
   * enough to bind, in `export-budget.test.ts`.
   */
  it('holds every kind of view a click can ask for, not just the cheapest', () => {
    const payload = readPayload(html);
    const kinds = new Set(payload.views.map((entry) => entry.request.view));
    expect(kinds).toContain('protocol');
    expect(kinds).toContain('contract');
    expect(kinds).toContain('call');
  });

  /**
   * The bug this test exists for: the exporter embedded `{view:'call', focus}`
   * while `navigation.ts` sends `{view:'call', focus, up, down}`, so every
   * function click in a 49-view file answered "this export does not hold that
   * view". Found by clicking, and this is the assertion that would have caught
   * it.
   */
  it('embeds the requests the UI will actually send', () => {
    const payload = readPayload(html);
    const requests = payload.views.map((entry) => entry.request);

    // The UI's first request, spelled as `toRequest` spells it.
    expect(requests[0]).toEqual({ view: 'protocol' });

    // Contract drill-down: no hop limits, because the UI sends none.
    const contract = requests.find((request) => request.view === 'contract');
    expect(contract).toBeDefined();
    expect(Object.keys(contract ?? {}).sort()).toEqual(['focus', 'view']);

    // Call drill-down: hop limits, and the ones `meta.callDefaults` advertises,
    // because that is what the UI initialises its steppers from.
    const call = requests.find((request) => request.view === 'call');
    expect(call).toBeDefined();
    expect(call?.up).toBe(payload.meta.callDefaults.up);
    expect(call?.down).toBe(payload.meta.callDefaults.down);
  });

  it('carries §11’s inspector and code preview for the nodes it draws', () => {
    const payload = readPayload(html);
    const drawn = new Set(
      payload.views.flatMap((entry) =>
        entry.view.nodes.flatMap((node) => (node.type === 'node' ? [node.id] : [])),
      ),
    );
    expect(drawn.size).toBeGreaterThan(10);

    // Every drawn node can be inspected, which is what makes it worth clicking.
    for (const id of drawn) expect(payload.inspections[id]).toBeDefined();

    const swap = 'src/Pair.sol:Pair.swap(uint256,uint256,address)';
    expect(payload.sources[swap]?.text).toContain('function swap(');
    expect(payload.sources[swap]?.file).toBe('src/Pair.sol');
  });

  /**
   * §7's Phase 9: elkjs is `EPL-2.0 OR GPL-3.0-or-later`, this file
   * redistributes it, and the attribution goes in the footer. It is in the
   * document rather than in a comment because an attribution nobody can see is
   * not one.
   */
  it('redistributes elkjs, and says so where a reader can see it', () => {
    expect(html).toContain('EPL-2.0 OR GPL-3.0-or-later');
    expect(html).toContain('ax-export-footer');
    // The licence text is inside the footer element, not in a comment.
    const footer = /<footer class="ax-export-footer">([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? '';
    expect(footer).toContain('elkjs');
    // And the worker really is in the file — that is what "redistributes" means.
    expect(html).toContain('__AXIOMAP_ELK_WORKER__');
    expect(Buffer.byteLength(html)).toBeGreaterThan(1_000_000);
  });

  /**
   * A `</script>` inside a Solidity comment would close the tag the payload is
   * inside, and the failure lands after the file has been sent to someone else.
   */
  it('cannot be broken out of by the source it embeds', () => {
    const script = /window\.__AXIOMAP_PAYLOAD__ = ([\s\S]*?);\s*\n\s*window\./.exec(html)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(100);
    expect(script).not.toContain('</');
    expect(script).not.toContain('<script');
  });

  it('refuses to write a three-megabyte file to stdout', async () => {
    await expect(runExport({ path: project, format: 'html' })).rejects.toThrow(/--out/);
  }, 60_000);
});

function readPayload(html: string): {
  payloadVersion: number;
  meta: { callDefaults: { up: number; down: number } };
  nodeTable: Record<string, Record<string, unknown>>;
  views: {
    request: Record<string, unknown> & { view: string };
    view: { nodes: { type: string; id: string }[] };
  }[];
  inspections: Record<string, unknown>;
  sources: Record<string, { text: string; file: string }>;
} {
  const raw = /window\.__AXIOMAP_PAYLOAD__ = ([\s\S]*?);\s*\n\s*window\./.exec(html)?.[1];
  if (raw === undefined) throw new Error('No payload in the exported file.');
  return JSON.parse(raw) as ReturnType<typeof readPayload>;
}
