/**
 * §7's Phase 7 exit criterion, on the half this package owns: "usable on a
 * 300-contract project; interaction stays responsive."
 *
 * Phase 7a answered the first half at the query layer — 300 contracts and 1,800
 * cross-contract calls come to 1,410 elements once clustered, under the 1,500
 * cap. This measures what the renderer then does with a view that size, which is
 * the part that decides whether it *feels* usable: the ELK layout.
 *
 * The view is synthesised rather than aggregated, because `selectAggregatedView`
 * is a core function and §5 keeps this package to core's types. The shape is
 * taken from the numbers Phase 7a measured — twelve directories, five of them
 * opened — so what is being laid out is the size and topology of the real thing.
 *
 * The number is a **tripwire, not a budget**: §9 sets none for layout, and what
 * this guards is a change that turns a sub-second layout into a ten-second one,
 * which shows up as 10x rather than 10%. It runs ELK in-process; in the browser
 * this is on a worker and the viewport stays live throughout (§9 rule 6).
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';

import type { AggregatedView, DisplayEdge, DisplayNode } from '@axiomap/core';

import { toElements } from '../src/ui/elements.js';
import { toElkGraph, toPositions, type ElkNode } from '../src/ui/layout/elk-graph.js';
import { PRESETS } from '../src/ui/presets.js';
import { contract, edge } from './support.js';

const LAYOUT_TRIPWIRE_MS = 20_000;

/** 300 contracts over 12 directories, 5 expanded — Phase 7a's measured shape. */
function syntheticProtocolView(contracts = 300, dirs = 12, opened = 5): AggregatedView {
  const nodes: DisplayNode[] = [];
  const edges: DisplayEdge[] = [];

  for (let index = 0; index < dirs; index += 1) {
    const path = `src/m${String(index)}`;
    const expanded = index < opened;
    nodes.push({
      type: 'cluster',
      id: `dir:${path}`,
      path,
      label: `m${String(index)}`,
      parent: null,
      expanded,
      members: contracts / dirs,
      internalEdges: 12,
    });
  }

  const drawn: string[] = [];
  for (let index = 0; index < contracts; index += 1) {
    const dir = index % dirs;
    if (dir >= opened) continue;
    const file = `src/m${String(dir)}/C${String(index)}.sol`;
    const node = contract(`${file}:C${String(index)}`, { file, src: { file, offset: 0, length: 1, line: 1, column: 0 } });
    nodes.push({ type: 'node', id: node.id, node, parent: `dir:src/m${String(dir)}` });
    drawn.push(node.id);
  }

  // Each drawn contract calls six others; anything landing in a collapsed
  // directory folds into an aggregate edge to that cluster.
  for (let index = 0; index < drawn.length; index += 1) {
    for (let hop = 1; hop <= 6; hop += 1) {
      const from = drawn[index] as string;
      const target = drawn[(index + hop * 7) % drawn.length] as string;
      if (from === target) continue;
      edges.push({
        type: 'edge',
        id: `${from}|${target}|${String(hop)}`,
        edge: edge({ id: `${from}|${target}|${String(hop)}`, from, to: target, subkind: 'external' }),
        from,
        to: target,
      });
    }
  }
  for (let index = 0; index < drawn.length; index += 1) {
    const cluster = `dir:src/m${String(opened + (index % (dirs - opened)))}`;
    edges.push({
      type: 'aggregate',
      id: `agg:calls:${drawn[index] ?? ''}->${cluster}`,
      kind: 'calls',
      from: drawn[index] as string,
      to: cluster,
      count: 4,
      pairs: 2,
      members: [],
      resolution: 'heuristic',
    });
  }

  return {
    view: 'protocol',
    nodes,
    edges,
    elements: nodes.length + edges.length,
    cap: 1500,
    expanded: [],
    collapsed: [],
    note: 'synthesised',
  };
}

describe('a 300-contract protocol map', () => {
  it('lays out inside the tripwire, off the main thread in a browser', async () => {
    const view = syntheticProtocolView();
    expect(view.elements).toBeGreaterThan(1_000);
    expect(view.elements).toBeLessThanOrEqual(view.cap);

    const elements = toElements(view, PRESETS.protocol);
    const graph = toElkGraph(elements, PRESETS.protocol, () => ({ width: 160, height: 44 }));

    const started = Date.now();
    const laidOut = (await new ELK().layout(graph)) as ElkNode;
    const ms = Date.now() - started;

    const positions = toPositions(laidOut);
    // Every element the renderer will draw got somewhere to be.
    expect(Object.keys(positions).length).toBe(elements.nodes.length);
    for (const position of Object.values(positions)) {
      expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true);
    }

    expect(ms).toBeLessThan(LAYOUT_TRIPWIRE_MS);
    console.log(`ELK laid out ${String(view.elements)} elements in ${String(ms)} ms`);
  }, 60_000);
});
