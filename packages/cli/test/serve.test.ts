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

  it('answers GET only', async () => {
    const response = await fetch(`${base}/api/meta`, { method: 'POST' });
    expect(response.status).toBe(405);
  });
});
