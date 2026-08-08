/**
 * §9's aggregation layer and render cap.
 *
 * Decision #6 — 300+ contracts — "is not a rendering problem, it is an
 * information-design problem" (§9). 300 contracts is roughly 6,000 function
 * nodes and nobody reads that in any renderer, so the answer is not throughput
 * but a smaller, honest selection. This file is that layer, and it lives in
 * `core/query/` rather than in the webview because §9 rule 1 is explicit: **the
 * webview never receives the full graph.** It asks for a view + filter + focus
 * and gets back exactly what it will draw. A renderer that received the graph
 * and clustered it itself would satisfy the picture and not the rule.
 *
 * Three of §9's six rules land here:
 *
 * - **Rule 2, the hard cap of 1,500 elements.** Exceeding it is an error with an
 *   actionable message, never a silent hairball. `RenderCapError` carries the
 *   numbers so a caller can phrase it in its own voice.
 * - **Rule 3, semantic aggregation with drill-down.** Contracts cluster by
 *   directory; a collapsed cluster's edges lift to it and aggregate, weighted by
 *   call-site count. Expanding a cluster reveals its subdirectories and its
 *   contracts, one level at a time.
 * - **Rule 4, function-level detail only inside a focus scope** — already
 *   enforced by `views.ts`, which refuses a call view with no focus node.
 *
 * ### The default view expands as far as it fits
 *
 * A literal reading of rule 3 — always start fully collapsed — makes the default
 * view of `defi/` a single box labelled `src`, which is worse than the thing it
 * is protecting against. So the explicit `expand` set is honoured first and
 * always, and then clusters are opened breadth-first for as long as the result
 * stays under the cap. A small project draws itself completely; a 300-contract
 * one stops at the directory level and says so in its note. The cap is then
 * reserved for what it is actually for: an explicit request that cannot be
 * drawn.
 *
 * ### What this returns is not a subgraph
 *
 * A cluster is not a `GraphNode` — §10's node kinds are a closed set of
 * declarations, and a directory is not one — and a lifted edge is not a
 * `GraphEdge`, because its endpoints are directories. So the result is a
 * *display* model: every element carries an id, a parent (cytoscape's compound
 * nodes are exactly this shape), and, where one exists, the graph object it
 * stands for by reference. `ViewSelection`'s warning applies unchanged to those
 * references: they are the graph's own objects, and decorating one writes into
 * what `graph.json` serializes.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { EdgeKind, GraphEdge, GraphNode, Resolution } from '../graph/schema.js';
import {
  selectView,
  ViewError,
  type ViewName,
  type ViewOptions,
  type ViewSelection,
} from './views.js';

/** §9 rule 2, and §13's `renderCap` default. */
export const DEFAULT_RENDER_CAP = 1500;

/** A directory, standing in for everything under it that is not drawn. */
export interface ClusterElement {
  type: 'cluster';
  /** `dir:src/interfaces`. Prefixed so it cannot collide with a node id. */
  id: string;
  /** Repo-relative directory path. `.` for a file at the repo root. */
  path: string;
  /** Last path segment — what a renderer puts on the box. */
  label: string;
  /** Enclosing cluster, when that cluster is itself drawn. */
  parent: string | null;
  expanded: boolean;
  /** Graph nodes underneath it, at any depth, drawn or not. */
  members: number;
  /** Edges wholly inside it, which collapsing hid. */
  internalEdges: number;
}

/** A graph node, drawn as itself. */
export interface NodeElement {
  type: 'node';
  id: string;
  /** The graph's own object, by reference. Do not decorate it. */
  node: GraphNode;
  parent: string | null;
}

export type DisplayNode = ClusterElement | NodeElement;

/** A graph edge, drawn as itself. */
export interface EdgeElement {
  type: 'edge';
  id: string;
  /** The graph's own object, by reference. Do not decorate it. */
  edge: GraphEdge;
  from: string;
  to: string;
}

/**
 * Several edges, lifted to a cluster at one or both ends.
 *
 * `count` is call sites and `pairs` is distinct underlying edges, because §16
 * records an open question about which of the two reads better as a weight and
 * answering it should not need a second query. `resolution` is the *worst* of
 * the contributors, for the reason `views.ts` gives about the protocol rollup:
 * an aggregate is only as certain as its least certain member, and rounding
 * that up is the flattery §4 refuses.
 */
export interface AggregateEdgeElement {
  type: 'aggregate';
  /** `agg:calls:dir:src->dir:lib`. */
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  /** Call sites summed across the contributors (§9 rule 3's weight). */
  count: number;
  /** How many graph edges were folded in. */
  pairs: number;
  members: readonly string[];
  resolution: Resolution;
}

export type DisplayEdge = EdgeElement | AggregateEdgeElement;

export interface AggregatedView {
  view: ViewName;
  nodes: readonly DisplayNode[];
  edges: readonly DisplayEdge[];
  /** `nodes.length + edges.length` — the number the cap counts. */
  elements: number;
  cap: number;
  /** Directory paths that are open, sorted. Feed back in as `expand` to keep them. */
  expanded: readonly string[];
  /** Clusters drawn collapsed, which the user can still drill into. */
  collapsed: readonly string[];
  /** What was aggregated and why, for the UI to print above the graph. */
  note: string;
}

export interface AggregateOptions {
  /**
   * Directory paths to drill into. Ancestors are implied, so `expand:
   * ['src/tokens/erc20']` opens `src` and `src/tokens` on the way.
   */
  expand?: readonly string[];
  /** §9 rule 2. Defaults to {@link DEFAULT_RENDER_CAP}. */
  renderCap?: number;
  /**
   * Cluster by directory at all. Defaults to true for the protocol map, which
   * is the view §9 rule 3 describes, and false for the other four: three of
   * them are already scoped by a focus node, and boxing an inheritance tree by
   * directory fights the tree it exists to show.
   */
  cluster?: boolean;
  /** Open further clusters while they fit. Default true; see the header. */
  autoExpand?: boolean;
}

/**
 * §9 rule 2. Carries the numbers as fields, not only as prose, so a caller can
 * offer the drill-down the message describes rather than reprinting a string.
 */
export class RenderCapError extends Error {
  readonly elements: number;
  readonly cap: number;
  readonly view: ViewName;

  constructor(message: string, view: ViewName, elements: number, cap: number) {
    super(message);
    this.name = 'RenderCapError';
    this.view = view;
    this.elements = elements;
    this.cap = cap;
  }
}

const ROOT_DIR = '.';

function dirOf(file: string): string {
  const cut = file.lastIndexOf('/');
  return cut <= 0 ? ROOT_DIR : file.slice(0, cut);
}

function parentDir(dir: string): string | null {
  if (dir === ROOT_DIR) return null;
  const cut = dir.lastIndexOf('/');
  return cut <= 0 ? null : dir.slice(0, cut);
}

function clusterId(dir: string): string {
  return `dir:${dir}`;
}

function depthOf(dir: string): number {
  return dir === ROOT_DIR ? 0 : dir.split('/').length - 1;
}

function label(dir: string): string {
  // A project whose sources sit at its own root has one directory, and its
  // path is `ROOT_DIR`. Drawn verbatim that is a box labelled with a full stop,
  // which reads as a rendering artifact rather than as a name — seen the first
  // time this was pointed at a single-directory project.
  if (dir === ROOT_DIR) return '(project root)';
  const cut = dir.lastIndexOf('/');
  return cut < 0 ? dir : dir.slice(cut + 1);
}

interface DirNode {
  path: string;
  parent: string | null;
  children: string[];
  /** Nodes whose file sits directly in this directory. */
  own: string[];
  /** Nodes at any depth beneath it. */
  members: number;
}

function buildTree(nodes: readonly GraphNode[]): Map<string, DirNode> {
  const dirs = new Map<string, DirNode>();

  const ensure = (dir: string): DirNode => {
    const existing = dirs.get(dir);
    if (existing !== undefined) return existing;
    const parent = parentDir(dir);
    const created: DirNode = { path: dir, parent, children: [], own: [], members: 0 };
    dirs.set(dir, created);
    if (parent !== null) ensure(parent).children.push(dir);
    return created;
  };

  for (const node of nodes) {
    const dir = dirOf(node.file);
    ensure(dir).own.push(node.id);
    for (let at: string | null = dir; at !== null; at = parentDir(at)) {
      const entry = dirs.get(at);
      if (entry !== undefined) entry.members += 1;
    }
  }

  for (const dir of dirs.values()) dir.children.sort();
  return dirs;
}

/** The expansion set, closed under ancestors — expanding a leaf opens the path to it. */
function closure(dirs: Map<string, DirNode>, expand: readonly string[]): Set<string> {
  const open = new Set<string>();
  for (const raw of expand) {
    const path = raw === '' ? ROOT_DIR : raw.replace(/\/+$/, '');
    if (!dirs.has(path)) {
      const known = [...dirs.keys()].sort();
      throw new ViewError(
        `"${raw}" is not a directory in this view. Expandable directories: ` +
          `${known.slice(0, 12).join(', ')}${known.length > 12 ? `, … (${String(known.length)} in all)` : ''}.`,
      );
    }
    for (let at: string | null = path; at !== null; at = parentDir(at)) open.add(at);
  }
  return open;
}

const WORSE: Record<Resolution, number> = {
  semantic: 0,
  heuristic: 1,
  ambiguous: 2,
  unresolved: 3,
};

interface Layout {
  nodes: DisplayNode[];
  edges: DisplayEdge[];
  collapsed: string[];
}

/**
 * One expansion state, rendered.
 *
 * Called once per candidate during auto-expansion, so it stays a pure function
 * of `open` — the alternative, mutating a layout in place as clusters open, is
 * the kind of incremental update that drifts from the thing it is meant to
 * mirror.
 */
function layOut(
  view: ViewName,
  selection: ViewSelection,
  dirs: Map<string, DirNode>,
  open: ReadonlySet<string>,
): Layout {
  const roots = [...dirs.values()].filter((dir) => dir.parent === null).map((dir) => dir.path);

  // Present = drawn. A cluster is drawn when every ancestor above it is open;
  // a node is drawn when its own directory is open.
  const presentDirs = new Set<string>();
  const queue = [...roots].sort();
  while (queue.length > 0) {
    const path = queue.shift() as string;
    presentDirs.add(path);
    if (!open.has(path)) continue;
    const dir = dirs.get(path);
    if (dir !== undefined) queue.push(...dir.children);
  }

  const drawnNodes = new Set<string>();
  for (const path of presentDirs) {
    if (!open.has(path)) continue;
    const dir = dirs.get(path);
    if (dir !== undefined) for (const id of dir.own) drawnNodes.add(id);
  }

  /** The element standing in for a node: itself, or the nearest drawn cluster. */
  const representative = (node: GraphNode): string => {
    if (drawnNodes.has(node.id)) return node.id;
    for (let at: string | null = dirOf(node.file); at !== null; at = parentDir(at)) {
      if (presentDirs.has(at)) return clusterId(at);
    }
    // Unreachable: every node's directory chain terminates at a root, and every
    // root is present. Stated rather than assumed, because a silent `undefined`
    // here would surface as a missing edge rather than as this sentence.
    throw new ViewError(`No cluster covers ${node.file}; the directory tree is inconsistent.`);
  };

  const byId = new Map(selection.nodes.map((node) => [node.id, node]));
  const nodeOf = (id: string): GraphNode => {
    const node = byId.get(id);
    if (node === undefined) {
      throw new ViewError(
        `This selection has an edge pointing at "${id}", which is not one of its nodes.`,
      );
    }
    return node;
  };

  const internalEdges = new Map<string, number>();
  const edges: DisplayEdge[] = [];
  // Mutable while folding, `readonly` once it leaves: `members` grows here and
  // nowhere else, and casting the readonly away at the push site would be the
  // same claim with less of a guarantee.
  const aggregated = new Map<string, AggregateEdgeElement & { members: string[] }>();

  for (const edge of selection.edges) {
    const from = representative(nodeOf(edge.from));
    const to = representative(nodeOf(edge.to));

    const lifted = from !== edge.from || to !== edge.to;
    if (!lifted) {
      edges.push({ type: 'edge', id: edge.id, edge, from, to });
      continue;
    }

    if (from === to) {
      // Both ends collapsed into the same box. Hidden, but counted: a cluster
      // that says "48 contracts, 291 calls inside" is telling the user where
      // the drill-down is worth spending.
      internalEdges.set(from, (internalEdges.get(from) ?? 0) + edge.count);
      continue;
    }

    const id = `agg:${edge.kind}:${from}->${to}`;
    const existing = aggregated.get(id);
    if (existing === undefined) {
      aggregated.set(id, {
        type: 'aggregate',
        id,
        kind: edge.kind,
        from,
        to,
        count: edge.count,
        pairs: 1,
        members: [edge.id],
        resolution: edge.resolution,
      });
    } else {
      existing.count += edge.count;
      existing.pairs += 1;
      existing.members.push(edge.id);
      if (WORSE[edge.resolution] > WORSE[existing.resolution]) {
        existing.resolution = edge.resolution;
      }
    }
  }

  const nodes: DisplayNode[] = [];
  const collapsed: string[] = [];
  for (const path of [...presentDirs].sort()) {
    const dir = dirs.get(path);
    if (dir === undefined) continue;
    const expanded = open.has(path);
    if (!expanded) collapsed.push(path);
    const parent = dir.parent;
    nodes.push({
      type: 'cluster',
      id: clusterId(path),
      path,
      label: label(path),
      parent: parent !== null && presentDirs.has(parent) ? clusterId(parent) : null,
      expanded,
      members: dir.members,
      internalEdges: internalEdges.get(clusterId(path)) ?? 0,
    });
  }
  for (const node of selection.nodes) {
    if (!drawnNodes.has(node.id)) continue;
    nodes.push({ type: 'node', id: node.id, node, parent: clusterId(dirOf(node.file)) });
  }

  edges.push(...aggregated.values());
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return { nodes, edges, collapsed };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/** What to do about it, in the vocabulary of the view the user is looking at. */
function wayOut(view: ViewName, clustered: boolean): string {
  if (view === 'call') {
    return 'reduce the hop limits (--up/--down) or focus a narrower function';
  }
  if (view === 'protocol') {
    return clustered
      ? 'collapse a directory, or focus a contract'
      : 'turn clustering on, or focus a contract';
  }
  if (view === 'state-access') return 'focus a contract to narrow it';
  return 'focus a single contract';
}

export function enforceRenderCap(
  view: ViewName,
  nodes: number,
  edges: number,
  cap: number,
  clustered: boolean,
): void {
  const elements = nodes + edges;
  if (elements <= cap) return;
  throw new RenderCapError(
    `${plural(elements, 'element')} (${plural(nodes, 'node')}, ${plural(edges, 'edge')}) ` +
      `exceeds the render cap of ${cap.toLocaleString('en-US')} — ${wayOut(view, clustered)}. ` +
      'Nothing legible comes out of a graph this size (AXIOMAP.md §9).',
    view,
    elements,
    cap,
  );
}

/**
 * §9 rules 2 and 3 over a `ViewSelection`.
 *
 * Separate from `selectView` because the two answer different questions and one
 * of them has no renderer: `axiomap export --format dot` wants the whole
 * selection and pipes it to a tool that will not try to draw 3,000 boxes on a
 * screen. The cap belongs to the thing with a viewport.
 */
export function aggregate(
  selection: ViewSelection,
  options: AggregateOptions = {},
): AggregatedView {
  const cap = options.renderCap ?? DEFAULT_RENDER_CAP;
  const clustered = options.cluster ?? selection.view === 'protocol';

  if (!clustered) {
    /*
     * Containment is drawn by nesting, not by an edge.
     *
     * A contract and its members are joined by `declares`, and drawing that as
     * a spoke makes the contract-detail view a star: seven of nine edges on a
     * real contract said nothing except "this member is in this contract", and
     * ELK lays a star out as one row several thousand pixels wide. Reported as
     * "how is that helpful", correctly.
     *
     * So a member becomes a compound child of its container, which is the same
     * mechanism the protocol map already uses for directories, and the
     * `declares` edge that said the same thing is dropped. It is self-gating:
     * `parent` is only set when the container is itself drawn, so the call and
     * state-access views — which never draw the contract — are untouched.
     */
    const drawn = new Map(selection.nodes.map((node) => [node.id, node]));
    const parentOf = (node: GraphNode): string | null => {
      const scope = node.scope;
      if (scope === null) return null;
      const container = drawn.get(scope);
      return container !== undefined && container.kind === 'Contract' ? scope : null;
    };

    const nodes = selection.nodes.map((node) => ({
      type: 'node' as const,
      id: node.id,
      node,
      parent: parentOf(node),
    }));
    const nested = new Map(nodes.map((node) => [node.id, node.parent]));
    const edges = selection.edges
      .filter((edge) => !(edge.kind === 'declares' && nested.get(edge.to) === edge.from))
      .map((edge) => ({
        type: 'edge' as const,
        id: edge.id,
        edge,
        from: edge.from,
        to: edge.to,
      }));

    enforceRenderCap(selection.view, nodes.length, edges.length, cap, false);
    return {
      view: selection.view,
      nodes,
      edges,
      elements: nodes.length + edges.length,
      cap,
      expanded: [],
      collapsed: [],
      note: selection.note,
    };
  }

  const dirs = buildTree(selection.nodes);
  const open = closure(dirs, options.expand ?? []);

  // What the user asked for explicitly is drawn or refused; it is not silently
  // collapsed back to fit.
  let layout = layOut(selection.view, selection, dirs, open);
  enforceRenderCap(selection.view, layout.nodes.length, layout.edges.length, cap, true);

  if (options.autoExpand ?? true) {
    // Breadth-first, so a project opens evenly rather than pouring the whole
    // budget into whichever directory sorts first. Each cluster is tried once.
    const queue = [...layout.collapsed].sort(
      (a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b),
    );
    while (queue.length > 0) {
      const path = queue.shift() as string;
      if (open.has(path)) continue;
      const trial = new Set(open);
      trial.add(path);
      const candidate = layOut(selection.view, selection, dirs, trial);
      if (candidate.nodes.length + candidate.edges.length > cap) continue;
      open.add(path);
      layout = candidate;
      const dir = dirs.get(path);
      if (dir !== undefined) {
        for (const child of dir.children) queue.push(child);
        queue.sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
      }
    }
  }

  const elements = layout.nodes.length + layout.edges.length;
  const drawn = layout.nodes.filter((node) => node.type === 'node').length;
  const total = selection.nodes.length;

  return {
    view: selection.view,
    nodes: layout.nodes,
    edges: layout.edges,
    elements,
    cap,
    expanded: [...open].sort(),
    collapsed: [...layout.collapsed].sort(),
    note:
      `${selection.note}. ${plural(elements, 'element')} of a ${cap.toLocaleString('en-US')} cap; ` +
      (layout.collapsed.length === 0
        ? `all ${plural(total, 'node')} drawn`
        : `${drawn.toLocaleString('en-US')} of ${plural(total, 'node')} drawn, ` +
          `${plural(layout.collapsed.length, 'directory', 'directories')} collapsed — ` +
          'expand one to drill in'),
  };
}

export interface AggregatedViewOptions extends ViewOptions, AggregateOptions {}

/**
 * The one call §9 rule 1 describes: view + filter + focus in, drawable subgraph
 * out. The webview has no other way to reach the graph, and this is why.
 */
export function selectAggregatedView(
  graph: AxiomapGraph,
  options: AggregatedViewOptions,
): AggregatedView {
  return aggregate(selectView(graph, options), options);
}
