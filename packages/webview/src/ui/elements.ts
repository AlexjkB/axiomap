/**
 * An `AggregatedView` from the host, in the shape cytoscape draws.
 *
 * Pure, and deliberately so: this is where the graph becomes pixels-in-waiting,
 * and it is the one part of the renderer that can be tested without a DOM, a
 * canvas or a worker. Everything the stylesheet needs is decided here as data
 * (`classes`, `data.kind`, `data.weight`) rather than looked up from the graph
 * later, so `style.ts` never has to reach back into a node.
 *
 * ### Nothing here is decorated
 *
 * §9's aggregation layer hands over the graph's **own** node and edge objects by
 * reference, and both `views.ts` and `aggregate.ts` warn what happens if a
 * renderer hangs a coordinate on one: it writes into what `graph.json`
 * serializes, and the next `axiomap diff` reports a phantom change. So this
 * builds new objects and copies fields out. It never assigns into `element.node`
 * or `element.edge`.
 *
 * ### Four facts, legibly, without hover
 *
 * §11's density target for a function node is "name, visibility, mutability, and
 * one flag summary … without hover", which is what `label` and `detail` carry.
 * A collapsed cluster gets the sentence Phase 7a's notes asked for — "48
 * contracts, 291 calls inside" — because that is what tells a user whether
 * drilling in is worth it.
 */

import type {
  AggregatedView,
  DisplayEdge,
  DisplayNode,
  FunctionNode,
  GraphNode,
  Resolution,
  StateVariableNode,
} from '@axiomap/core';

import type { ViewPreset } from './presets.js';

export interface CyNodeData {
  id: string;
  parent?: string;
  label: string;
  /** Second line: the qualifiers §11 wants legible at default zoom. */
  detail: string;
  /** `label` and `detail` joined — one cytoscape label holds both. */
  display: string;
  kind: string;
  /** Set on clusters, for the drill-down affordance. */
  expanded?: boolean;
  path?: string;
  /** ELK partition for the bipartite state-access map: 0 functions, 1 storage. */
  partition?: number;
  /** True when clicking this node re-focuses the current view. */
  focusable: boolean;
}

export interface CyEdgeData {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
  resolution: Resolution;
  /** Call sites (§10's `count`), which is what edge weight encodes. */
  count: number;
  width: number;
}

export interface CyElements {
  nodes: { data: CyNodeData; classes: string }[];
  edges: { data: CyEdgeData; classes: string }[];
}

function isFunction(node: GraphNode): node is FunctionNode {
  return node.kind === 'Function';
}

function isStateVariable(node: GraphNode): node is StateVariableNode {
  return node.kind === 'StateVariable';
}

/** `deposit(uint256)` — the signature an auditor recognises, not the node id. */
function signature(node: FunctionNode): string {
  const params = node.params.map((param) => param.type).join(',');
  if (node.subkind === 'modifier') return `${node.name}`;
  if (node.subkind === 'constructor' || node.subkind === 'fallback' || node.subkind === 'receive') {
    return node.name;
  }
  return `${node.name}(${params})`;
}

/**
 * §11's fourth fact: one flag summary.
 *
 * Ordered by how much an auditor cares, and truncated rather than wrapped —
 * `asm` and `delegatecall` earn their place on a node label; `hasTryCatch` does
 * not, and a label that lists eight flags is a label nobody reads.
 */
function flagSummary(node: FunctionNode): string {
  const flags: string[] = [];
  if (node.flags.hasDelegatecall) flags.push('delegatecall');
  if (node.flags.hasAssembly) flags.push('asm');
  if (node.flags.hasLowLevelCall) flags.push('low-level');
  if (node.flags.hasSelfdestruct) flags.push('selfdestruct');
  if (node.flags.hasCreate) flags.push('create');
  if (node.flags.sendsValue) flags.push('value');
  if (node.flags.writesState) flags.push('writes');
  else if (node.flags.readsState) flags.push('reads');
  return flags.slice(0, 3).join(' · ');
}

function labelOf(node: GraphNode): { label: string; detail: string } {
  if (isFunction(node)) {
    const qualifiers = [node.visibility, node.stateMutability === 'nonpayable' ? '' : node.stateMutability]
      .filter((part) => part !== '' && part !== 'default')
      .join(' ');
    const summary = flagSummary(node);
    return {
      label: signature(node),
      detail: summary === '' ? qualifiers : `${qualifiers}  ${summary}`,
    };
  }
  if (isStateVariable(node)) {
    const qualifiers = [
      node.visibility === 'default' ? '' : node.visibility,
      node.isConstant ? 'constant' : '',
      node.isImmutable ? 'immutable' : '',
      node.slot === undefined ? '' : `slot ${node.slot}`,
    ].filter((part) => part !== '');
    return { label: node.name, detail: [node.type, ...qualifiers].join('  ') };
  }
  if (node.kind === 'Contract') {
    const marks: string[] = [node.contractKind];
    if (node.isTest) marks.push('test');
    if (node.isMock) marks.push('mock');
    if (!node.isFullyImplemented && node.contractKind === 'contract') marks.push('abstract-in-fact');
    return { label: node.name, detail: marks.join(' · ') };
  }
  if (node.kind === 'Unresolved') {
    return { label: `?${node.name}`, detail: node.category };
  }
  return { label: node.name, detail: node.kind };
}

/** §11: colour is semantic. The kind decides the class; the stylesheet decides the hue. */
function nodeClasses(node: GraphNode, preset: ViewPreset): string[] {
  const classes = [`kind-${node.kind}`];
  if (isFunction(node)) {
    classes.push(`vis-${node.visibility}`);
    if (node.subkind !== 'function') classes.push(`sub-${node.subkind}`);
  }
  if (node.kind === 'Contract') classes.push(`contract-${node.contractKind}`);
  if (preset.focusKinds.includes(node.kind)) classes.push('focusable');
  return classes;
}

/** ELK partitions for §11's bipartite state map: functions left, storage right. */
function partitionOf(node: GraphNode): number {
  return node.kind === 'StateVariable' ? 1 : 0;
}

/**
 * Edge width from call-site count (§11's channel budget: "edge weight — call-site
 * count"). Logarithmic, because twenty calls to `_mint` should read as heavier
 * than one and not as twenty times heavier.
 */
export function edgeWidth(count: number): number {
  return Math.min(6, 1 + Math.log2(Math.max(1, count)));
}

function join(label: string, detail: string): string {
  return detail === '' ? label : `${label}\n${detail}`;
}

function displayNode(element: DisplayNode, preset: ViewPreset): CyElements['nodes'][number] {
  if (element.type === 'cluster') {
    const inside =
      element.internalEdges === 0
        ? ''
        : `${element.internalEdges.toLocaleString('en-US')} call${element.internalEdges === 1 ? '' : 's'} inside`;
    const members = `${element.members.toLocaleString('en-US')} node${element.members === 1 ? '' : 's'}`;
    const detail = element.expanded
      ? element.path
      : [members, inside].filter((part) => part !== '').join(' · ');
    return {
      data: {
        id: element.id,
        ...(element.parent === null ? {} : { parent: element.parent }),
        label: element.label,
        detail,
        display: join(element.label, detail),
        kind: 'Cluster',
        expanded: element.expanded,
        path: element.path,
        focusable: false,
      },
      classes: ['cluster', element.expanded ? 'expanded' : 'collapsed'].join(' '),
    };
  }

  const { label, detail } = labelOf(element.node);
  return {
    data: {
      id: element.id,
      ...(element.parent === null ? {} : { parent: element.parent }),
      label,
      detail,
      display: join(label, detail),
      kind: element.node.kind,
      ...(preset.partitioned ? { partition: partitionOf(element.node) } : {}),
      focusable: preset.focusKinds.includes(element.node.kind),
    },
    classes: nodeClasses(element.node, preset).join(' '),
  };
}

function displayEdge(element: DisplayEdge): CyElements['edges'][number] {
  if (element.type === 'aggregate') {
    return {
      data: {
        id: element.id,
        source: element.from,
        target: element.to,
        label: `${element.count.toLocaleString('en-US')}×`,
        kind: element.kind,
        resolution: element.resolution,
        count: element.count,
        width: edgeWidth(element.count),
      },
      classes: ['aggregate', `edge-${element.kind}`, `res-${element.resolution}`].join(' '),
    };
  }

  const edge = element.edge;
  const subkind = edge.subkind === undefined ? '' : ` sub-${edge.subkind}`;
  return {
    data: {
      id: element.id,
      source: element.from,
      target: element.to,
      label: edge.count > 1 ? `${String(edge.count)}×` : '',
      kind: edge.kind,
      resolution: edge.resolution,
      count: edge.count,
      width: edgeWidth(edge.count),
    },
    classes:
      `edge-${edge.kind} res-${edge.resolution}${subkind}` +
      (edge.crossTrustBoundary === true ? ' cross-trust' : '') +
      (edge.id.startsWith('rollup:') ? ' rollup' : ''),
  };
}

export function toElements(view: AggregatedView, preset: ViewPreset): CyElements {
  return {
    nodes: view.nodes.map((node) => displayNode(node, preset)),
    edges: view.edges.map(displayEdge),
  };
}
