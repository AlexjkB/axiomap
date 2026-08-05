/**
 * The translation from an aggregated view to drawable elements.
 *
 * Two properties matter more than the rest and both have a test that would fail
 * loudly: **nothing the host sent is mutated** (§9's warning about writing into
 * the graph's own objects), and **a node label carries §11's four facts**.
 */

import { describe, expect, it } from 'vitest';

import { edgeWidth, toElements } from '../src/ui/elements.js';
import { PRESETS } from '../src/ui/presets.js';
import { contract, edge, fn, stateVariable, view } from './support.js';

describe('elements', () => {
  it('gives a function node §11’s four facts without hover', () => {
    const node = fn('src/Vault.sol:Vault.deposit(uint256)', {
      visibility: 'external',
      stateMutability: 'payable',
      flags: { ...fn('x').flags, writesState: true, hasLowLevelCall: true },
    });

    const { nodes } = toElements(
      view({ nodes: [{ type: 'node', id: node.id, node, parent: null }] }),
      PRESETS.contract,
    );

    const drawn = nodes[0];
    expect(drawn?.data.label).toBe('deposit(uint256)');
    // name, visibility, mutability, flag summary — the four §11 names.
    expect(drawn?.data.detail).toContain('external');
    expect(drawn?.data.detail).toContain('payable');
    expect(drawn?.data.detail).toContain('low-level');
    expect(drawn?.data.display).toBe(`${drawn?.data.label ?? ''}\n${drawn?.data.detail ?? ''}`);
  });

  it('does not write into the graph objects it was handed', () => {
    const node = contract('src/Vault.sol:Vault');
    const before = JSON.stringify(node);
    const relation = edge({ id: 'e1', from: node.id, to: node.id });
    const beforeEdge = JSON.stringify(relation);

    toElements(
      view({
        nodes: [{ type: 'node', id: node.id, node, parent: null }],
        edges: [{ type: 'edge', id: relation.id, edge: relation, from: node.id, to: node.id }],
      }),
      PRESETS.protocol,
    );

    expect(JSON.stringify(node)).toBe(before);
    expect(JSON.stringify(relation)).toBe(beforeEdge);
  });

  it('says what a collapsed cluster is hiding, and what an expanded one is', () => {
    const { nodes } = toElements(
      view({
        nodes: [
          {
            type: 'cluster',
            id: 'dir:src',
            path: 'src',
            label: 'src',
            parent: null,
            expanded: false,
            members: 48,
            internalEdges: 291,
          },
          {
            type: 'cluster',
            id: 'dir:lib',
            path: 'lib',
            label: 'lib',
            parent: null,
            expanded: true,
            members: 3,
            internalEdges: 0,
          },
        ],
      }),
      PRESETS.protocol,
    );

    expect(nodes[0]?.data.detail).toBe('48 nodes · 291 calls inside');
    expect(nodes[0]?.classes).toContain('collapsed');
    // An expanded cluster shows its contents, so a second line repeating its
    // path says nothing and collides with the sibling box beside it.
    expect(nodes[1]?.data.detail).toBe('');
    expect(nodes[1]?.data.display).toBe('lib');
    expect(nodes[1]?.classes).toContain('expanded');
  });

  it('carries §4’s confidence and §10’s call count onto every edge', () => {
    const from = fn('src/Vault.sol:Vault.a()');
    const to = fn('src/Vault.sol:Vault.b()');
    const { edges } = toElements(
      view({
        view: 'call',
        nodes: [
          { type: 'node', id: from.id, node: from, parent: null },
          { type: 'node', id: to.id, node: to, parent: null },
        ],
        edges: [
          {
            type: 'edge',
            id: 'e1',
            edge: edge({ id: 'e1', from: from.id, to: to.id, resolution: 'unresolved', count: 20 }),
            from: from.id,
            to: to.id,
          },
          {
            type: 'aggregate',
            id: 'agg:calls:dir:a->dir:b',
            kind: 'calls',
            from: from.id,
            to: to.id,
            count: 7,
            pairs: 3,
            members: ['e2', 'e3', 'e4'],
            resolution: 'ambiguous',
          },
        ],
      }),
      PRESETS.call,
    );

    expect(edges[0]?.classes).toContain('res-unresolved');
    expect(edges[0]?.data.label).toBe('20×');
    expect(edges[1]?.classes).toContain('aggregate');
    expect(edges[1]?.classes).toContain('res-ambiguous');
    expect(edges[1]?.data.count).toBe(7);
  });

  it('partitions the state-access map and nothing else (§11: functions left, storage right)', () => {
    const f = fn('src/Vault.sol:Vault.deposit(uint256)');
    const v = stateVariable('src/Vault.sol:Vault.total');
    const nodes = [
      { type: 'node' as const, id: f.id, node: f, parent: null },
      { type: 'node' as const, id: v.id, node: v, parent: null },
    ];

    const bipartite = toElements(view({ view: 'state-access', nodes }), PRESETS['state-access']);
    expect(bipartite.nodes.map((node) => node.data.partition)).toEqual([0, 1]);

    const plain = toElements(view({ view: 'contract', nodes }), PRESETS.contract);
    expect(plain.nodes.every((node) => node.data.partition === undefined)).toBe(true);
  });

  it('weights an edge by call sites, sublinearly', () => {
    expect(edgeWidth(1)).toBe(1);
    expect(edgeWidth(20)).toBeGreaterThan(edgeWidth(2));
    expect(edgeWidth(20)).toBeLessThan(edgeWidth(2) * 20);
    expect(edgeWidth(1_000_000)).toBeLessThanOrEqual(6);
  });
});
