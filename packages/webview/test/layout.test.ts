/**
 * §9 rule 6's two halves, on the side of the worker boundary a test can reach:
 * the ELK graph that goes over it, and the client that owns what comes back.
 */

import { describe, expect, it, vi } from 'vitest';

import { toElements } from '../src/ui/elements.js';
import { LayoutClient, type LayoutEngine } from '../src/ui/layout/client.js';
import { toElkGraph, toPositions, type ElkNode, type ElkRoot } from '../src/ui/layout/elk-graph.js';
import { PRESETS } from '../src/ui/presets.js';
import { contract, edge, fn, stateVariable, view } from './support.js';

const size = (): { width: number; height: number } => ({ width: 100, height: 40 });

describe('the ELK graph', () => {
  it('nests a node inside the cluster that holds it', () => {
    const node = contract('src/Vault.sol:Vault');
    const elements = toElements(
      view({
        nodes: [
          {
            type: 'cluster',
            id: 'dir:src',
            path: 'src',
            label: 'src',
            parent: null,
            expanded: true,
            members: 1,
            internalEdges: 0,
          },
          { type: 'node', id: node.id, node, parent: 'dir:src' },
        ],
      }),
      PRESETS.protocol,
    );

    const graph = toElkGraph(elements, PRESETS.protocol, size);
    expect(graph.children?.map((child) => child.id)).toEqual(['dir:src']);
    expect(graph.children?.[0]?.children?.map((child) => child.id)).toEqual([node.id]);
    // A directory has to lay out as a place. Flattening the hierarchy lets two
    // contracts in one directory land at opposite ends of the canvas, and the
    // box fitted around them then swallows everything in between.
    expect(graph.layoutOptions['elk.hierarchyHandling']).toBe('SEPARATE_CHILDREN');
  });

  it('drops an edge whose endpoint is not drawn rather than referring to nothing', () => {
    const node = fn('src/Vault.sol:Vault.a()');
    const elements = toElements(
      view({
        view: 'call',
        nodes: [{ type: 'node', id: node.id, node, parent: null }],
        edges: [
          {
            type: 'edge',
            id: 'e1',
            edge: edge({ id: 'e1', from: node.id, to: 'not-drawn' }),
            from: node.id,
            to: 'not-drawn',
          },
        ],
      }),
      PRESETS.call,
    );
    expect(toElkGraph(elements, PRESETS.call, size).edges).toEqual([]);
  });

  it('gives the state-access map its partitions and nothing else does', () => {
    const f = fn('src/Vault.sol:Vault.deposit(uint256)');
    const v = stateVariable('src/Vault.sol:Vault.total');
    const nodes = [
      { type: 'node' as const, id: f.id, node: f, parent: null },
      { type: 'node' as const, id: v.id, node: v, parent: null },
    ];
    const preset = PRESETS['state-access'];
    const graph = toElkGraph(toElements(view({ view: 'state-access', nodes }), preset), preset, size);
    expect(graph.children?.map((child) => child.layoutOptions?.['elk.partitioning.partition'])).toEqual([
      '0',
      '1',
    ]);
    expect(graph.layoutOptions['elk.partitioning.activate']).toBe('true');
  });

  it('converts ELK’s relative top-left corners into absolute centres', () => {
    // A cluster at (10,20) holding a node at (5,5), 100×40 inside a 200×100 box.
    const positions = toPositions({
      id: 'root',
      children: [
        {
          id: 'dir:src',
          x: 10,
          y: 20,
          width: 200,
          height: 100,
          children: [{ id: 'Vault', x: 5, y: 5, width: 100, height: 40 }],
        },
      ],
    });

    expect(positions['dir:src']).toEqual({ x: 110, y: 70 });
    expect(positions['Vault']).toEqual({ x: 65, y: 45 });
  });
});

/** An ELK stand-in whose answers are settled by hand, in order. */
class FakeEngine implements LayoutEngine {
  readonly asked: ElkRoot[] = [];
  private readonly settlers: ((laidOut: ElkNode) => void)[] = [];
  private readonly failers: ((error: Error) => void)[] = [];
  terminated = false;

  layout(graph: ElkRoot): Promise<ElkNode> {
    this.asked.push(graph);
    return new Promise<ElkNode>((resolve, reject) => {
      this.settlers.push(resolve);
      this.failers.push(reject);
    });
  }

  terminateWorker(): void {
    this.terminated = true;
  }

  answer(index: number, laidOut: ElkNode): void {
    this.settlers[index]?.(laidOut);
  }

  fail(index: number, message: string): void {
    this.failers[index]?.(new Error(message));
  }
}

/** One node at (10,20), 100×40 — centre (60,40). */
const oneNode: ElkNode = {
  id: 'root',
  children: [{ id: 'a', x: 10, y: 20, width: 100, height: 40 }],
};

describe('the layout client', () => {
  const graph: ElkRoot = { id: 'root', layoutOptions: {}, children: [], edges: [] };

  it('resolves with positions and how long ELK took', async () => {
    const engine = new FakeEngine();
    const pending = new LayoutClient(engine).layout(graph);
    engine.answer(0, oneNode);
    const result = await pending;
    expect(result.positions).toEqual({ a: { x: 60, y: 40 } });
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('drops the answer to a request the caller has moved on from', async () => {
    const engine = new FakeEngine();
    const client = new LayoutClient(engine);

    const first = client.layout(graph);
    const rejected = vi.fn();
    void first.catch(rejected);
    const second = client.layout(graph);

    // The first layout finishes *after* the second was asked for. Applying it
    // would settle the viewport on a view the user is no longer looking at.
    engine.answer(0, { id: 'root', children: [{ id: 'stale', x: 9, y: 9, width: 0, height: 0 }] });
    engine.answer(1, oneNode);

    await expect(second).resolves.toMatchObject({ positions: { a: { x: 60, y: 40 } } });
    await expect(first).rejects.toThrow('superseded');
    expect(rejected).toHaveBeenCalledOnce();
  });

  it('reports a failed layout without taking the graph down with it', async () => {
    const engine = new FakeEngine();
    const client = new LayoutClient(engine);
    const pending = client.layout(graph);
    engine.fail(0, 'elk said no');
    await expect(pending).rejects.toThrow('elk said no');
    client.dispose();
    expect(engine.terminated).toBe(true);
  });
});
