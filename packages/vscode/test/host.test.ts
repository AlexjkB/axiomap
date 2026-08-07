/**
 * The extension's half of §9 rule 1, against a real graph.
 *
 * `host.ts` imports no `vscode`, which is what makes this a plain unit test of
 * the thing that would otherwise be the least testable part of an extension: the
 * message loop of a webview nobody can step through.
 *
 * The fixture is `minimal/` (§14's canary), built once for the file.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildProjectGraph,
  auditState,
  type AxiomapGraph,
  type GraphFile,
} from '@axiomap/core';
import { CHANNEL, type BridgeMethod } from '@axiomap/webview';

import { answer, isBridgeRequest, type HostSources } from '../src/host.js';
import { fixture } from './fixtures.js';

let sources: HostSources;
let graph: AxiomapGraph;
let file: GraphFile;

const DEPOSIT = 'src/Vault.sol:Vault.deposit(uint256)';

beforeAll(async () => {
  const built = await buildProjectGraph(fixture('minimal'), {
    cacheDir: null,
    workers: 1,
    enrich: false,
  });
  graph = built.graph;
  file = built.file;
  sources = {
    graph,
    file,
    root: fixture('minimal'),
    renderCap: 1500,
    auditState: auditState(graph, { review: null, findings: null }),
  };
});

function request(method: BridgeMethod, params: Record<string, string> = {}) {
  return { channel: CHANNEL as typeof CHANNEL, id: 7, method, params };
}

describe('isBridgeRequest', () => {
  it('accepts ours and refuses everything else', () => {
    expect(isBridgeRequest(request('meta'))).toBe(true);
    expect(isBridgeRequest({ ...request('meta'), channel: 'other' })).toBe(false);
    expect(isBridgeRequest({ channel: CHANNEL, id: 1, method: 'meta' })).toBe(false);
    expect(isBridgeRequest({ channel: CHANNEL, event: 'reveal' })).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
    expect(isBridgeRequest('meta')).toBe(false);
  });
});

describe('answer', () => {
  it('quotes the id it was asked with', () => {
    expect(answer(sources, request('meta')).id).toBe(7);
  });

  it('sends the header and not the graph (§9 rule 1)', () => {
    const meta = answer(sources, request('meta')).result as Record<string, unknown>;
    expect(meta['mode']).toBe(file.mode);
    expect(meta['renderCap']).toBe(1500);
    expect(meta['callDefaults']).toEqual({ up: 2, down: 3 });
    // The two fields rule 1 is about.
    expect(meta['nodes']).toBeUndefined();
    expect(meta['edges']).toBeUndefined();
  });

  it('answers a view request decoded the same way the HTTP host decodes it', () => {
    const view = answer(sources, request('view', { view: 'protocol' })).result as {
      view: string;
      elements: number;
      cap: number;
    };
    expect(view.view).toBe('protocol');
    expect(view.elements).toBeGreaterThan(0);
    expect(view.cap).toBe(1500);
  });

  it('applies the host’s render cap when the request does not name one', () => {
    // The cap the *host* resolved from §13, not a default of the transport's.
    const view = answer({ ...sources, renderCap: 900 }, request('view', { view: 'protocol' }))
      .result as { cap: number };
    expect(view.cap).toBe(900);

    // §9 rule 2: exceeding it is a refusal with the numbers, not a hairball and
    // not a crash. Unclustered, so the map cannot fit under the cap by
    // collapsing itself into one box.
    const capped = answer(
      { ...sources, renderCap: 3 },
      request('view', { view: 'protocol', cluster: '0' }),
    );
    expect(capped.error?.name).toBe('RenderCapError');
    expect(capped.error?.cap).toBe(3);
    expect(capped.error?.elements).toBeGreaterThan(3);
    expect(capped.result).toBeUndefined();
  });

  it('inspects a node, and refuses one that is not there', () => {
    const inspection = answer(sources, request('inspect', { id: DEPOSIT })).result as {
      id: string;
      node: { kind: string };
    };
    expect(inspection.id).toBe(DEPOSIT);
    expect(inspection.node.kind).toBe('Function');

    expect(answer(sources, request('inspect', { id: 'nope' })).error?.name).toBe(
      'NodeNotFoundError',
    );
    expect(answer(sources, request('inspect', {})).error?.name).toBe('ViewError');
  });

  it('sends the two audit-state files as the host read them', () => {
    expect(answer(sources, request('auditState')).result).toBe(sources.auditState);
  });

  it('searches on this side, capped here (§9 rule 1)', () => {
    const hits = answer(sources, request('search', { q: 'deposit' })).result as {
      hits: { id: string }[];
    };
    expect(hits.hits.map((hit) => hit.id)).toContain(DEPOSIT);
  });

  it('slices a node’s source, and reads a caller’s buffer when there is one', () => {
    const onDisk = answer(sources, request('source', { id: DEPOSIT })).result as { text: string };
    expect(onDisk.text).toContain('function deposit(');

    const edited = answer(
      { ...sources, buffer: () => 'contract Vault { /* unsaved */ }' },
      request('source', { id: DEPOSIT }),
    ).result as { text: string };
    expect(edited.text).toContain('unsaved');
  });

  it('reports an unresolved placeholder as having no source, rather than throwing', () => {
    const synthetic: string[] = [];
    graph.forEachNode((id, node) => {
      if (node.kind === 'Unresolved') synthetic.push(id);
    });
    expect(synthetic.length).toBeGreaterThan(0);

    const refused = answer(sources, request('source', { id: synthetic[0] as string }));
    expect(refused.error?.name).toBe('SourceUnavailableError');
  });

  it('says so when a webview asks for a method this host does not have', () => {
    const unknown = answer(sources, {
      ...request('meta'),
      method: 'graph' as BridgeMethod,
    });
    expect(unknown.error?.name).toBe('UnknownMethod');
    // The point of the branch: there is no `graph` method, and a version skew
    // is a sentence rather than a request that never answers.
    expect(unknown.error?.message).toContain('graph');
  });
});
