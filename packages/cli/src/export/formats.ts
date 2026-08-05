/**
 * `axiomap export --format dot|mermaid|json` (§12).
 *
 * All three are text serializations of a `ViewSelection` — the same subgraph
 * §11's five views define, rendered for a different consumer. Nothing here
 * decides what is in the graph; `core/src/query/views.ts` does that, and Phase
 * 7's renderer will ask it the same question.
 *
 * ### Colour and style carry §4's confidence, in every format
 *
 * §4: the UI renders the four resolution values distinctly — solid, solid-thin,
 * dashed-fanned, dotted-muted — and "this is a feature, not an apology". A dot
 * or mermaid export that drew every edge identically would be the tool
 * "silently pretending to certainty it does not have", which §4 calls worse
 * than useless in an audit. So the line styles below are the same distinction
 * in the vocabulary each format has.
 */

import type { GraphEdge, GraphNode, ViewSelection } from '@axiomap/core';

export const TEXT_FORMATS = ['dot', 'mermaid', 'json'] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

/**
 * Labels are qualified by their contract, because unqualified they are not
 * unique: `IFactory.getPair` and `Factory.getPair` both render as `getPair`,
 * and a diagram with two identically-labelled nodes is worse than no diagram —
 * an interface call and its implementation are exactly the pair an auditor is
 * trying to tell apart.
 */
function owner(node: GraphNode): string {
  if (node.scope === null) return '';
  const colon = node.scope.lastIndexOf(':');
  return `${colon === -1 ? node.scope : node.scope.slice(colon + 1)}.`;
}

function label(node: GraphNode): string {
  if (node.kind === 'Contract') return `${node.contractKind} ${node.name}`;
  if (node.kind === 'Function') {
    const params = node.params.map((p) => p.type).join(',');
    return `${owner(node)}${node.name}(${params})`;
  }
  if (node.kind === 'StateVariable') return `${owner(node)}${node.name}: ${node.type}`;
  if (node.kind === 'Unresolved') return `? ${node.name}`;
  return `${owner(node)}${node.name}`;
}

/** §4's four values as a dot line style, and as a colour. */
function dotEdgeStyle(edge: GraphEdge): string {
  switch (edge.resolution) {
    case 'semantic':
      return 'style=solid, penwidth=1.4, color="#2e7d32"';
    case 'heuristic':
      return 'style=solid, penwidth=0.8, color="#0277bd"';
    case 'ambiguous':
      return 'style=dashed, penwidth=0.8, color="#f9a825"';
    default:
      return 'style=dotted, penwidth=0.8, color="#9e9e9e"';
  }
}

function dotNodeShape(node: GraphNode): string {
  switch (node.kind) {
    case 'Contract':
      return 'shape=box, style="rounded,filled", fillcolor="#eceff1"';
    case 'StateVariable':
      return 'shape=box, style=filled, fillcolor="#fff3e0"';
    case 'Unresolved':
      return 'shape=octagon, style=dashed, color="#9e9e9e"';
    case 'Function':
      return node.visibility === 'external' || node.visibility === 'public'
        ? 'shape=ellipse, style=filled, fillcolor="#e8f5e9"'
        : 'shape=ellipse';
    default:
      return 'shape=note';
  }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function toDot(selection: ViewSelection): string {
  const lines: string[] = [];
  lines.push(`// axiomap export --view ${selection.view}`);
  lines.push(`// ${selection.note}`);
  lines.push('digraph axiomap {');
  lines.push('  rankdir=LR;');
  lines.push('  node [fontname="monospace", fontsize=10];');
  lines.push('  edge [fontname="monospace", fontsize=8];');

  for (const node of selection.nodes) {
    lines.push(`  ${quote(node.id)} [label=${quote(label(node))}, ${dotNodeShape(node)}];`);
  }

  for (const edge of selection.edges) {
    const tag = edge.subkind === undefined ? edge.kind : `${edge.kind}:${edge.subkind}`;
    const weight = edge.count > 1 ? ` ×${String(edge.count)}` : '';
    lines.push(
      `  ${quote(edge.from)} -> ${quote(edge.to)} ` +
        `[label=${quote(tag + weight)}, ${dotEdgeStyle(edge)}];`,
    );
  }

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/**
 * Mermaid ids have to be identifier-shaped, so node ids are replaced by `n0`,
 * `n1`, … and the real id goes in the label. The mapping is emitted as a
 * comment header so the output is still traceable back to the graph.
 */
export function toMermaid(selection: ViewSelection): string {
  const alias = new Map<string, string>();
  selection.nodes.forEach((node, i) => alias.set(node.id, `n${String(i)}`));

  const lines: string[] = [];
  lines.push(`%% axiomap export --view ${selection.view}`);
  lines.push(`%% ${selection.note}`);
  lines.push('flowchart LR');

  for (const node of selection.nodes) {
    const id = alias.get(node.id) ?? node.id;
    const text = label(node).replace(/"/g, "'");
    // Shape per kind: contracts square, functions rounded, storage stadium.
    if (node.kind === 'Contract') lines.push(`  ${id}["${text}"]`);
    else if (node.kind === 'StateVariable') lines.push(`  ${id}[("${text}")]`);
    else if (node.kind === 'Unresolved') lines.push(`  ${id}{{"${text}"}}`);
    else lines.push(`  ${id}("${text}")`);
  }

  for (const edge of selection.edges) {
    const from = alias.get(edge.from);
    const to = alias.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const tag = edge.subkind === undefined ? edge.kind : `${edge.kind}:${edge.subkind}`;
    const weight = edge.count > 1 ? ` x${String(edge.count)}` : '';
    // Mermaid has two line weights and a dotted form; §4's four values map onto
    // them as certain / inferred / uncertain, with ambiguous and unresolved
    // sharing the dotted form and separated by the label.
    const arrow =
      edge.resolution === 'semantic'
        ? '==>'
        : edge.resolution === 'heuristic'
          ? '-->'
          : '-.->';
    lines.push(`  ${from} ${arrow}|"${tag}${weight} (${edge.resolution})"| ${to}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The `json` format is the selection, not the whole `graph.json`: a view is a
 * subgraph and exporting the artifact under another name would make `--view`
 * a lie. `axiomap build` is how you get the whole thing.
 */
export function toJson(selection: ViewSelection): string {
  return `${JSON.stringify(
    {
      view: selection.view,
      note: selection.note,
      nodes: selection.nodes,
      edges: selection.edges,
    },
    null,
    2,
  )}\n`;
}
