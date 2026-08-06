/**
 * `axiomap serve` end to end, over real HTTP.
 *
 * The suite exists to pin §9 rule 1 rather than to smoke-test a web server: the
 * property under test is that **there is exactly one way to reach the graph**,
 * that it is `selectAggregatedView`, and that what comes back is bounded by the
 * render cap rather than by the size of the project.
 *
 * It runs against a copy of `defi/` with `out/` removed, like the Phase 6
 * walkthrough — a protocol that does not build is the case decision #1 exists
 * for, and it should be the case the UI is tested on.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServe } from '../src/index.js';
import type { ServeSession } from '../src/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary: string[] = [];
let session: ServeSession;
let base: string;

function copyFixture(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `axiomap-serve-${name}-`));
  temporary.push(root);
  fs.cpSync(path.join(REPO, 'fixtures', name), root, { recursive: true });
  return root;
}

async function get(pathname: string): Promise<{ status: number; type: string; body: unknown }> {
  const response = await fetch(`${base}${pathname}`);
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, type, body };
}

beforeAll(async () => {
  const root = copyFixture('defi');
  fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
  session = await startServe({ path: root, port: 0 });
  base = session.handle.url.replace(/\/$/, '');
}, 60_000);

afterAll(async () => {
  await session.handle.close();
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

describe('axiomap serve', () => {
  it('binds loopback unless told otherwise', () => {
    expect(session.handle.host).toBe('127.0.0.1');
    expect(session.banner).toContain('http://127.0.0.1:');
    // §4 wants the mode and the score stated, not implied — the same line
    // `axiomap build` prints.
    expect(session.banner).toContain('mode');
    expect(session.banner).toMatch(/\d+ edges — \d+% semantic/);
  });

  it('serves the webview bundle at the root', async () => {
    const { status, type, body } = await get('/');
    expect(status).toBe(200);
    expect(type).toContain('text/html');
    expect(String(body)).toContain('<div id="root">');
  });

  it('answers /api/meta with the graph header and not the graph', async () => {
    const { status, body } = await get('/api/meta');
    expect(status).toBe(200);
    const meta = body as Record<string, unknown>;
    expect(meta['mode']).toBe('heuristic');
    expect(meta['modeReason']).toEqual(expect.stringContaining('No build artifacts'));
    expect(meta['renderCap']).toBe(1500);
    expect(meta['callDefaults']).toEqual({ up: 2, down: 3 });
    expect(meta['views']).toEqual(['protocol', 'contract', 'call', 'state-access', 'inheritance']);
    // §9 rule 1: the header carries no nodes and no edges.
    expect(meta['nodes']).toBeUndefined();
    expect(meta['edges']).toBeUndefined();
  });

  it('answers /api/view with an aggregated view, under the cap', async () => {
    const { status, body } = await get('/api/view?view=protocol');
    expect(status).toBe(200);
    const view = body as { view: string; nodes: unknown[]; edges: unknown[]; elements: number; cap: number };
    expect(view.view).toBe('protocol');
    expect(view.elements).toBe(view.nodes.length + view.edges.length);
    expect(view.elements).toBeLessThanOrEqual(view.cap);
    expect(view.nodes.length).toBeGreaterThan(0);
  });

  it('is the only door: there is no route that returns the whole graph', async () => {
    for (const route of ['/api/graph', '/api/nodes', '/graph.json', '/.axiomap/graph.json']) {
      const { status } = await get(route);
      expect(status).toBe(404);
    }
  });

  it('takes the same view + filter + focus the CLI does', async () => {
    const contract = await get('/api/view?view=contract&focus=src%2FPair.sol%3APair');
    expect(contract.status).toBe(200);
    expect((contract.body as { view: string }).view).toBe('contract');

    const call = await get(
      '/api/view?view=call&focus=src%2FPair.sol%3APair.swap(uint256,uint256,address)&up=1&down=1',
    );
    expect(call.status).toBe(200);
    const narrow = (call.body as { nodes: unknown[] }).nodes.length;

    const wider = await get(
      '/api/view?view=call&focus=src%2FPair.sol%3APair.swap(uint256,uint256,address)&up=2&down=3',
    );
    expect((wider.body as { nodes: unknown[] }).nodes.length).toBeGreaterThanOrEqual(narrow);
  });

  it('drills into a directory and back out again', async () => {
    const collapsed = await get('/api/view?view=protocol&autoExpand=0');
    const expanded = await get('/api/view?view=protocol&autoExpand=0&expand=src');
    const drawn = (payload: unknown): number =>
      (payload as { nodes: { type: string }[] }).nodes.filter((node) => node.type === 'node').length;
    expect(drawn(collapsed.body)).toBe(0);
    expect(drawn(expanded.body)).toBeGreaterThan(0);
  });

  it('refuses a view it cannot draw, with the numbers and the way out (§9 rule 2)', async () => {
    const { status, body } = await get('/api/view?view=protocol&cluster=0&renderCap=3');
    expect(status).toBe(422);
    const error = (body as { error: Record<string, unknown> }).error;
    expect(error['name']).toBe('RenderCapError');
    expect(error['cap']).toBe(3);
    expect(error['elements']).toBeGreaterThan(3);
    expect(String(error['message'])).toContain('render cap');
    // Actionable, per §9: it names what to do, in the vocabulary of the view.
    expect(String(error['message'])).toMatch(/collapse a directory|focus a contract/);
  });

  it('refuses a request it cannot read rather than guessing at it', async () => {
    const unknown = await get('/api/view?view=nonsense');
    expect(unknown.status).toBe(400);
    expect(String((unknown.body as { error: { message: string } }).error.message)).toContain(
      'protocol, contract, call, state-access, inheritance',
    );

    const noFocus = await get('/api/view?view=call');
    expect(noFocus.status).toBe(400);
    expect((noFocus.body as { error: { name: string } }).error.name).toBe('ViewError');

    const badNumber = await get('/api/view?view=call&focus=x&up=lots');
    expect(badNumber.status).toBe(400);
  });

  it('does not serve the filesystem it happens to have open', async () => {
    const escape = await fetch(`${base}/../../../etc/passwd`, { redirect: 'manual' });
    expect([403, 404]).toContain(escape.status);
    const encoded = await get('/%2e%2e%2f%2e%2e%2fpackage.json');
    expect([403, 404]).toContain(encoded.status);
  });

  it('answers /api/node with one node’s attributes and relations (§11)', async () => {
    const { status, body } = await get(
      '/api/node?id=src%2FPair.sol%3APair.swap(uint256,uint256,address)',
    );
    expect(status).toBe(200);
    const inspection = body as {
      node: { kind: string; name: string };
      scope: { id: string } | null;
      incoming: unknown[];
      outgoing: { id: string; edgeKind: string }[];
    };
    expect(inspection.node.kind).toBe('Function');
    expect(inspection.scope?.id).toBe('src/Pair.sol:Pair');
    // The inspector's whole point: relations the drawn view does not contain.
    expect(inspection.outgoing.some((relation) => relation.edgeKind === 'reads')).toBe(true);
  });

  it('refuses an unknown node and a missing id, rather than answering vaguely', async () => {
    const missing = await get('/api/node?id=src%2FNope.sol%3ANope');
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { name: string } }).error.name).toBe('NodeNotFoundError');

    const blank = await get('/api/node');
    expect(blank.status).toBe(400);
    expect(String((blank.body as { error: { message: string } }).error.message)).toContain('id');
  });

  it('answers /api/overlays with the audit-state files, empty when there are none', async () => {
    const { status, body } = await get('/api/overlays');
    expect(status).toBe(200);
    const overlays = body as {
      review: Record<string, unknown>;
      findings: Record<string, unknown>;
      sources: { review: boolean; findings: boolean };
    };
    // This fixture copy has neither file, and "absent" and "present but empty"
    // are the same picture and different sentences.
    expect(overlays.review).toEqual({});
    expect(overlays.findings).toEqual({});
    expect(overlays.sources).toEqual({ review: false, findings: false });
  });

  /**
   * §11's palette. The property worth an end-to-end test is not that the search
   * works — `core/test/search.test.ts` covers the matching — but that the *cap*
   * survives the transport. A client that could raise it over the wire would
   * have found the route to the node set §9 rule 1 keeps on the host.
   */
  it('answers /api/search with a capped, ranked list', async () => {
    const { status, body } = await get('/api/search?q=mint');
    expect(status).toBe(200);
    const results = body as { hits: { id: string; name: string }[]; total: number; limit: number };
    expect(results.hits[0]?.name).toBe('mint');
    expect(results.limit).toBe(20);

    const greedy = await get('/api/search?q=a&limit=100000');
    const capped = greedy.body as { hits: unknown[]; total: number; capped: boolean; limit: number };
    expect(capped.limit).toBe(50);
    expect(capped.hits.length).toBeLessThanOrEqual(50);
    // The count is still honest about how many matched — §9 rule 2's shape: a
    // bounded answer that says what it left out, not a silent truncation.
    expect(capped.total).toBeGreaterThan(capped.hits.length);
    expect(capped.capped).toBe(true);
  });

  /**
   * §11's code preview, and the first route in this project that reads the
   * user's source in response to a request.
   */
  it('answers /api/source with a byte range around a node’s src', async () => {
    const { status, body } = await get('/api/source?id=src%2FPair.sol%3APair.mint(address)');
    expect(status).toBe(200);
    const slice = body as {
      file: string;
      text: string;
      startLine: number;
      language: string;
      drifted: boolean;
    };
    expect(slice.file).toBe('src/Pair.sol');
    expect(slice.language).toBe('solidity');
    expect(slice.startLine).toBe(69);
    expect(slice.text).toContain('function mint(address to)');
    expect(slice.drifted).toBe(false);
    // A *range*, not the file: `swap` is in the same file and is not in it.
    expect(slice.text).not.toContain('function swap(');
  });

  /**
   * The design, asserted at the transport: the request names a node, and the
   * path comes from the graph. There is no parameter that reaches a file, so
   * none of these is a way in — each is refused as "not a node".
   */
  it('will not read a file the graph does not name', async () => {
    for (const attempt of [
      '/api/source?id=..%2F..%2F..%2Fetc%2Fpasswd',
      '/api/source?id=%2Fetc%2Fpasswd',
      '/api/source?id=..%2F..%2Fpackage.json',
    ]) {
      const { status, body } = await get(attempt);
      expect(status).toBe(404);
      expect((body as { error: { name: string } }).error.name).toBe('SourceUnavailableError');
    }

    // Parameters that look like a path are not read at all: the id decides
    // everything, and this request answers about the node it names.
    const smuggled = await get(
      '/api/source?file=%2Fetc%2Fpasswd&id=src%2FPair.sol%3APair.mint(address)&path=%2Fetc%2Fpasswd',
    );
    expect(smuggled.status).toBe(200);
    expect((smuggled.body as { file: string }).file).toBe('src/Pair.sol');
    expect((smuggled.body as { text: string }).text).toContain('function mint');

    const blank = await get('/api/source');
    expect(blank.status).toBe(400);
  });

  /**
   * `src/Pair.sol` *is* a node — a SourceUnit — so this is a legitimate 200 and
   * not a hole. Its `src` is a zero-length marker at offset 0 (§10's kinds are
   * declarations; a file is what they live in), so what it means is the file.
   */
  it('previews a whole file when the node is the file, bounded by the cap', async () => {
    const { status, body } = await get('/api/source?id=src%2FPair.sol');
    expect(status).toBe(200);
    const slice = body as { text: string; startLine: number; truncated: boolean };
    expect(slice.startLine).toBe(1);
    expect(slice.text).toContain('contract Pair is IPair, Shares');
    expect(slice.text).toContain('function swap(');
    // 4.7 KB, comfortably inside the default limit.
    expect(slice.truncated).toBe(false);
  });

  it('answers GET only', async () => {
    const response = await fetch(`${base}/api/meta`, { method: 'POST' });
    expect(response.status).toBe(405);
  });
});
