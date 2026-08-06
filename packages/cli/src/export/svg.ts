/**
 * `axiomap export --format svg` (§12).
 *
 * §16 deferred this twice with one reason: "both need a layout engine, and §7
 * puts `cytoscape` and `elkjs` in Phase 7". `elkjs` is here now, and it runs in
 * Node as happily as in a browser — so this is the same `ViewSelection` the
 * three text formats consume, laid out by the same engine the webview uses, and
 * written as SVG elements.
 *
 * ### Why this is not the second renderer §16 warned about
 *
 * The thing §16 refused was "a throwaway layout engine" — a second answer to
 * *where things go*, which would put the CLI's diagram and the webview's
 * diagram in disagreement. There is one layout engine and this calls it. What
 * is written twice is the *drawing*: cytoscape needs a DOM and there is none
 * here, so nodes become `<rect>` and edges become `<path>`. That is a
 * serializer, in the same family as `toDot` and `toMermaid`, and it is bounded
 * by the same `ViewSelection`.
 *
 * The one thing it must not do is disagree about **§4's four confidences**.
 * `formats.ts` already states why: an export that drew every edge identically
 * would be the tool "silently pretending to certainty it does not have". The
 * line treatments below are §4's own words — "solid / solid-thin /
 * dashed-fanned / dotted-muted" — in SVG's vocabulary.
 *
 * ### Colours are literal here, and that is not a §11 violation
 *
 * §11's "no hard-coded hex" is a rule about the *webview*, whose palette comes
 * from the host's theme. An SVG file has no host: it is opened in an image
 * viewer, dropped into a report, or printed. It carries its own colours because
 * there is nothing to inherit them from — the same reason `toDot` carries its
 * own.
 */

/*
 * `elk.bundled.js`, not `elk-api.js`.
 *
 * The webview imports the latter because it drives elkjs's own worker (§9 rule
 * 6, and Phase 7b's finding that nesting a worker around it breaks). `elk-api`
 * refuses to construct without a worker, and a CLI writing a file has no
 * viewport to keep responsive — so the bundled build, which carries the
 * algorithm and runs in-process, is the right one here. It is also the one
 * `packages/webview/test/scale.test.ts` uses to measure layout in Node.
 */
import ELK from 'elkjs/lib/elk.bundled.js';

import type { GraphEdge, GraphNode, ViewSelection } from '@axiomap/core';

/** Roughly a monospace character at 11px, for sizing a node around its label. */
const CHAR_WIDTH = 6.6;
const LINE_HEIGHT = 14;
const PADDING_X = 10;
const PADDING_Y = 6;

interface Positioned {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElkPort {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkPort[];
  edges?: {
    id: string;
    sections?: {
      startPoint: { x: number; y: number };
      endPoint: { x: number; y: number };
      bendPoints?: { x: number; y: number }[];
    }[];
  }[];
}

/**
 * Two lines, the way the webview draws them: what it is, then how it is
 * declared. §11's density target is "four facts legibly at default zoom", and
 * an image with no hover has only what is printed on it.
 */
function labelLines(node: GraphNode): string[] {
  if (node.kind === 'Contract') return [node.name, node.contractKind];
  if (node.kind === 'Function') {
    const params = node.params.map((param) => param.type).join(',');
    return [`${node.name}(${params})`, `${node.visibility} ${node.stateMutability}`];
  }
  if (node.kind === 'StateVariable') return [node.name, node.type];
  if (node.kind === 'Unresolved') return [`? ${node.name}`, node.category];
  return [node.name, node.kind];
}

function sizeOf(lines: string[]): { width: number; height: number } {
  const longest = lines.reduce((most, line) => Math.max(most, line.length), 0);
  return {
    width: Math.max(72, longest * CHAR_WIDTH + PADDING_X * 2),
    height: lines.length * LINE_HEIGHT + PADDING_Y * 2,
  };
}

/** §4's four, as SVG. The same distinction `formats.ts` draws for dot. */
function edgeStyle(edge: GraphEdge): { stroke: string; width: number; dash: string; opacity: number } {
  switch (edge.resolution) {
    case 'semantic':
      return { stroke: '#2e7d32', width: 1.6, dash: '', opacity: 1 };
    case 'heuristic':
      return { stroke: '#0277bd', width: 0.9, dash: '', opacity: 0.95 };
    case 'ambiguous':
      return { stroke: '#f9a825', width: 0.9, dash: '5 3', opacity: 0.9 };
    default:
      return { stroke: '#9e9e9e', width: 0.9, dash: '2 3', opacity: 0.6 };
  }
}

function nodeFill(node: GraphNode): { fill: string; stroke: string } {
  switch (node.kind) {
    case 'Contract':
      return node.contractKind === 'interface'
        ? { fill: '#f3e5f5', stroke: '#6a1b9a' }
        : node.contractKind === 'library'
          ? { fill: '#e8f5e9', stroke: '#2e7d32' }
          : { fill: '#e3f2fd', stroke: '#1565c0' };
    case 'StateVariable':
      return { fill: '#fff3e0', stroke: '#ef6c00' };
    case 'Unresolved':
      return { fill: '#fafafa', stroke: '#9e9e9e' };
    default:
      return { fill: '#ffffff', stroke: '#546e7a' };
  }
}

/** Greedy word wrap. SVG has no text flow, so the lines are decided here. */
function wrap(text: string, columns: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= columns) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Lay a selection out with ELK and write it as SVG.
 *
 * The ELK options are the webview's protocol-map preset, for the reason the
 * whole module exists: two pictures of one graph that disagree about where
 * things go are worse than one picture. `thoroughness: 4` and
 * `SEPARATE_CHILDREN` are Phase 7b's measured choices.
 */
export async function toSvg(selection: ViewSelection): Promise<string> {
  const nodes = selection.nodes.map((node) => {
    const lines = labelLines(node);
    return { node, lines, ...sizeOf(lines) };
  });

  const known = new Set(nodes.map((entry) => entry.node.id));
  const edges = selection.edges.filter((edge) => known.has(edge.from) && known.has(edge.to));

  /*
   * `elk-api.js` has no default construct signature in its types, and in Node
   * it runs on the main thread rather than in a worker — §9 rule 6 is about a
   * *viewport* that must not freeze, and a CLI writing a file has none. The
   * webview's `browserEngine` is where that rule applies.
   */
  const Engine = ELK as unknown as new () => { layout(graph: unknown): Promise<ElkPort> };
  const elk = new Engine();

  const laidOut = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '48',
      'elk.spacing.nodeNode': '24',
      'elk.layered.thoroughness': '4',
      'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
    },
    children: nodes.map((entry) => ({
      id: entry.node.id,
      width: entry.width,
      height: entry.height,
    })),
    edges: edges.map((edge, index) => ({
      id: `e${String(index)}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  });

  const placed = new Map<string, Positioned>();
  for (const child of laidOut.children ?? []) {
    const entry = nodes.find((candidate) => candidate.node.id === child.id);
    if (entry === undefined) continue;
    placed.set(child.id, {
      node: entry.node,
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? entry.width,
      height: child.height ?? entry.height,
    });
  }

  const margin = 16;

  /*
   * The note is wrapped, not laid out on one line.
   *
   * §4 requires what was aggregated and why to be *stated*, and `selection.note`
   * is a full sentence — 158 characters on the protocol map. Sizing the image to
   * the graph alone clipped it mid-word; sizing the image to the sentence made a
   * 300px call graph into a 1,000px picture that is mostly whitespace. Wrapping
   * bounds the width and keeps the sentence whole, which is what the sentence is
   * for.
   */
  const NOTE_COLUMNS = 108;
  // A monospace advance is 0.6em; at the 10px the note is drawn at, that is 6px,
  // and the margin above it is for the descenders of the last line.
  const NOTE_CHAR = 6.2;
  const noteLines = wrap(selection.note, NOTE_COLUMNS);
  const headerHeight = 22 + noteLines.length * 12;

  const longest = noteLines.reduce((most, line) => Math.max(most, line.length), 0);
  const width = Math.max(320, (laidOut.width ?? 0) + margin * 2, longest * NOTE_CHAR + margin * 2);
  const height = Math.max(180, (laidOut.height ?? 0) + margin * 2 + headerHeight);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(Math.round(width))}" ` +
      `height="${String(Math.round(height))}" viewBox="0 0 ${String(Math.round(width))} ${String(Math.round(height))}" ` +
      'font-family="ui-monospace, SFMono-Regular, Menlo, monospace">',
  );
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
  /*
   * One marker per confidence colour, rather than one marker using
   * `context-stroke`.
   *
   * `context-stroke` is SVG 2 and would have been a single definition; Chrome
   * honours it and ImageMagick refuses the file outright, which is the wrong
   * trade for an artifact whose whole purpose is to be opened by somebody
   * else's tool. Four markers is a few more bytes and no dependency on how
   * modern the reader is.
   */
  const markers = [...new Set(edges.map((edge) => edgeStyle(edge).stroke))];
  parts.push(
    `<defs>${markers
      .map(
        (stroke, index) =>
          `<marker id="ax-arrow-${String(index)}" viewBox="0 0 8 8" refX="7" refY="4" ` +
          'markerWidth="6" markerHeight="6" orient="auto">' +
          `<path d="M0 0 L8 4 L0 8 z" fill="${stroke}"/></marker>`,
      )
      .join('')}</defs>`,
  );

  // §4 requires the mode and the score to be stated rather than implied, and an
  // image handed to someone else is the copy most likely to be read alone.
  parts.push(
    `<text x="${String(margin)}" y="16" font-size="12" fill="#263238">` +
      `${escapeXml(`axiomap — ${selection.view}`)}</text>`,
  );
  noteLines.forEach((line, index) => {
    parts.push(
      `<text x="${String(margin)}" y="${String(30 + index * 12)}" font-size="10" fill="#607d8b">` +
        `${escapeXml(line)}</text>`,
    );
  });

  parts.push(`<g transform="translate(${String(margin)}, ${String(headerHeight + margin)})">`);

  for (const [index, edge] of edges.entries()) {
    const section = (laidOut.edges ?? []).find((candidate) => candidate.id === `e${String(index)}`)
      ?.sections?.[0];
    if (section === undefined) continue;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    const d = points
      .map((point, at) => `${at === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`)
      .join(' ');
    const style = edgeStyle(edge);
    parts.push(
      `<path d="${d}" fill="none" stroke="${style.stroke}" stroke-width="${String(style.width)}" ` +
        `${style.dash === '' ? '' : `stroke-dasharray="${style.dash}" `}` +
        `opacity="${String(style.opacity)}" marker-end="url(#ax-arrow-${String(markers.indexOf(style.stroke))})"/>`,
    );
  }

  for (const entry of nodes) {
    const at = placed.get(entry.node.id);
    if (at === undefined) continue;
    const colours = nodeFill(entry.node);
    parts.push(
      `<rect x="${String(at.x)}" y="${String(at.y)}" width="${String(at.width)}" ` +
        `height="${String(at.height)}" rx="3" fill="${colours.fill}" stroke="${colours.stroke}" ` +
        'stroke-width="1"/>',
    );
    entry.lines.forEach((line, lineIndex) => {
      const y = at.y + PADDING_Y + LINE_HEIGHT * (lineIndex + 0.75);
      parts.push(
        `<text x="${String(at.x + at.width / 2)}" y="${String(y)}" font-size="${lineIndex === 0 ? '11' : '9'}" ` +
          `text-anchor="middle" fill="${lineIndex === 0 ? '#212121' : '#607d8b'}">` +
          `${escapeXml(line)}</text>`,
      );
    });
  }

  parts.push('</g>');
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}
