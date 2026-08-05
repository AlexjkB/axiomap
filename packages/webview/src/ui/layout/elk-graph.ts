/**
 * Elements → an ELK graph, and ELK's answer → positions.
 *
 * Both halves are pure, because §9 rule 6 puts the layout itself in a worker and
 * a worker is the least pleasant place to have a bug. What crosses the boundary
 * is plain JSON either way; the interesting decisions — how a collapsed
 * directory becomes a compound node, how §11's bipartite state map becomes an
 * ELK partition — are here, on the testable side of the `postMessage`.
 *
 * Sizes are measured on the main thread and sent in. ELK cannot measure text,
 * and a layout computed against guessed sizes puts labels through each other's
 * boxes — which is the specific way a dense, technical graph (§11) stops being
 * readable.
 */

import type { CyElements } from '../elements.js';
import type { ViewPreset } from '../presets.js';

export interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  labels?: { text: string }[];
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  edges?: ElkEdge[];
  x?: number;
  y?: number;
}

export interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
}

export interface ElkRoot extends ElkNode {
  layoutOptions: Record<string, string>;
}

/** What the main thread measured for one element. */
export interface Size {
  width: number;
  height: number;
}

export type SizeLookup = (id: string) => Size;

/** A laid-out position, in the absolute coordinates cytoscape wants. */
export interface Positions {
  [id: string]: { x: number; y: number };
}

/**
 * Build the ELK graph.
 *
 * Compound nodes are the shape both ends already speak: `aggregate.ts` gives
 * every element a `parent` "because cytoscape's compound nodes are exactly this
 * shape", and ELK's `children` is the same tree. A parent that is not itself in
 * the element list would silently orphan its children, so it is treated as
 * absent rather than trusted.
 */
export function toElkGraph(elements: CyElements, preset: ViewPreset, size: SizeLookup): ElkRoot {
  const byId = new Map<string, ElkNode>();
  const present = new Set(elements.nodes.map((node) => node.data.id));

  for (const node of elements.nodes) {
    const measured = size(node.data.id);
    const elk: ElkNode = {
      id: node.data.id,
      width: measured.width,
      height: measured.height,
    };
    if (preset.partitioned && node.data.partition !== undefined) {
      elk.layoutOptions = { 'elk.partitioning.partition': String(node.data.partition) };
    }
    byId.set(node.data.id, elk);
  }

  const roots: ElkNode[] = [];
  for (const node of elements.nodes) {
    const elk = byId.get(node.data.id);
    if (elk === undefined) continue;
    const parentId = node.data.parent;
    const parent = parentId !== undefined && present.has(parentId) ? byId.get(parentId) : undefined;
    if (parent === undefined) {
      roots.push(elk);
    } else {
      (parent.children ??= []).push(elk);
    }
  }

  // Every edge hangs off the root. ELK hoists edges to the lowest common
  // ancestor itself when `hierarchyHandling` is INCLUDE_CHILDREN, and doing it
  // by hand here would be a second implementation of that rule.
  const edges: ElkEdge[] = elements.edges
    .filter((edge) => present.has(edge.data.source) && present.has(edge.data.target))
    .map((edge) => ({ id: edge.data.id, sources: [edge.data.source], targets: [edge.data.target] }));

  return {
    id: 'root',
    layoutOptions: preset.layout,
    children: roots,
    edges,
  };
}

/**
 * ELK's answer → absolute positions, centred.
 *
 * ELK reports a child's `x`/`y` relative to its parent and as the box's
 * top-left; cytoscape wants an absolute centre. Getting either wrong draws a
 * graph that looks laid out and is subtly displaced — clusters drifting up-left
 * by half their size — so the conversion is one function with a test rather than
 * a line inside the render loop.
 */
export function toPositions(root: ElkNode): Positions {
  const positions: Positions = {};

  const walk = (node: ElkNode, offsetX: number, offsetY: number): void => {
    for (const child of node.children ?? []) {
      const x = offsetX + (child.x ?? 0);
      const y = offsetY + (child.y ?? 0);
      positions[child.id] = {
        x: x + (child.width ?? 0) / 2,
        y: y + (child.height ?? 0) / 2,
      };
      walk(child, x, y);
    }
  };

  walk(root, 0, 0);
  return positions;
}
