/**
 * `slither --json` import (§12's `axiomap import-findings`, §11's "imported
 * findings" overlay).
 *
 * Decision #4 in one file. Slither's detectors are genuinely valuable and
 * Axiomap does not try to rebuild them; it also does not depend on Slither,
 * because Slither requires a successful compile and decision #1 says the
 * scenario that matters is the one where compiling is impossible. The auditor
 * runs Slither themselves — §2 notes they already do — and this reads what came
 * out.
 *
 * ### The join is a byte offset again
 *
 * Phase 3 joined the semantic tier to the graph on byte offsets and §10 warns
 * why: solc's `src` is bytes, so anything that reasons in characters lands in
 * the wrong place in any file with a non-ASCII character. Slither's
 * `source_mapping.start` is the same byte offset from the same compiler, and
 * every node in the graph carries one, so a finding is attached to **the
 * smallest node whose source range contains it**.
 *
 * Not by name and signature, which was the obvious alternative: two contracts
 * in different files can share a name (`pathological/` has exactly that), and a
 * signature has to be canonicalised the same way on both sides before it can be
 * compared. The offset is already the same number.
 *
 * ### An unmapped finding is reported, never dropped and never guessed
 *
 * Slither reports on things the graph has no node for — a whole source unit, a
 * node in a file Axiomap excluded, an element with no source mapping at all.
 * Those come back in `unmapped` with the reason. §6's rule about not inventing a
 * resolution is about edges, but a finding silently attached to the wrong
 * function is the same failure wearing a different hat.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { GraphNode, SourceRefRecord } from '../graph/schema.js';

/** Slither's own severity words, kept verbatim — they are its claim, not ours. */
export type SlitherImpact = 'High' | 'Medium' | 'Low' | 'Informational' | 'Optimization';

/**
 * A node a finding landed on, **and the body it landed on**.
 *
 * The hash is what makes a stored finding falsifiable. `review.json` records a
 * `bodyHash` so a review goes stale the moment the body differs (§8), and an
 * imported finding needs exactly the same thing for exactly the same reason: it
 * is a claim about a specific piece of code, made by a tool that ran at a
 * specific moment. Without it, §11's overlay draws a High-severity reentrancy
 * badge on a function that was rewritten after Slither last saw it — which is
 * the same failure §8 exists to prevent, wearing a different hat.
 *
 * A node with no body (an interface declaration) hashes to the empty string,
 * per Phase 2's deliberate choice, and therefore cannot go stale. That is
 * correct: there is no body to change.
 */
export interface FindingNode {
  id: string;
  bodyHash: string;
}

export interface ImportedFinding {
  /** Stable across re-imports of the same finding: check + location. */
  id: string;
  /** Slither's detector name, e.g. `reentrancy-eth`. */
  check: string;
  impact: string;
  confidence: string;
  description: string;
  /** Graph nodes this finding lands on, sorted by id. */
  nodes: FindingNode[];
  /** Where Slither pointed, whether or not it mapped to a node. */
  locations: SourceRefRecord[];
}

export interface UnmappedFinding {
  check: string;
  description: string;
  reason: string;
}

export interface FindingsImport {
  findings: ImportedFinding[];
  unmapped: UnmappedFinding[];
  /** Detector results read from the file, mapped or not. */
  total: number;
}

export class FindingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindingsError';
  }
}

interface RawSourceMapping {
  start?: unknown;
  length?: unknown;
  filename_relative?: unknown;
  filename_short?: unknown;
  filename_absolute?: unknown;
  lines?: unknown;
}

interface RawElement {
  type?: unknown;
  name?: unknown;
  source_mapping?: RawSourceMapping;
}

interface RawDetector {
  check?: unknown;
  impact?: unknown;
  confidence?: unknown;
  description?: unknown;
  elements?: unknown;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Slither writes `{ success, error, results: { detectors: [...] } }`. Some
 * wrappers hand back the detector array on its own, and `--json -` prints the
 * same object to stdout — all three are accepted, because the alternative is a
 * user with a perfectly good findings file being told it is the wrong shape.
 */
function detectorsOf(raw: unknown, source: string): RawDetector[] {
  if (Array.isArray(raw)) return raw as RawDetector[];

  if (typeof raw === 'object' && raw !== null) {
    const results = (raw as { results?: unknown }).results;
    if (typeof results === 'object' && results !== null) {
      const detectors = (results as { detectors?: unknown }).detectors;
      if (Array.isArray(detectors)) return detectors as RawDetector[];
    }
    const error = (raw as { error?: unknown }).error;
    if (typeof error === 'string' && error.length > 0) {
      throw new FindingsError(
        `${source} is a Slither run that failed: ${error}. Fix the Slither run and re-export; ` +
          'there are no findings in this file to import.',
      );
    }
  }

  throw new FindingsError(
    `${source} does not look like "slither --json" output: expected an object with ` +
      'results.detectors, or an array of detector results.',
  );
}

/** A Function's `bodyHash`; the empty string for anything else (Phase 2). */
function bodyHashOf(graph: AxiomapGraph, id: string): string {
  if (!graph.hasNode(id)) return '';
  const node = graph.getNodeAttributes(id);
  return node.kind === 'Function' ? node.bodyHash : '';
}

/**
 * An index from file to that file's nodes, so a containment lookup is a scan of
 * one file's nodes rather than the project's.
 */
function nodesByFile(graph: AxiomapGraph): Map<string, GraphNode[]> {
  const byFile = new Map<string, GraphNode[]>();
  graph.forEachNode((_id, node) => {
    // Synthetic placeholders have a borrowed location (Phase 2: project-wide by
    // construction), so containment against them means nothing.
    if (node.kind === 'Unresolved') return;
    const list = byFile.get(node.file);
    if (list === undefined) byFile.set(node.file, [node]);
    else list.push(node);
  });
  return byFile;
}

/**
 * The smallest node containing `[start, start+length)`.
 *
 * Smallest rather than first: a function's range is inside its contract's,
 * which is inside its source unit's, and a reentrancy finding belongs on the
 * function. Ties broken by id so the answer does not depend on node order.
 */
function containing(nodes: readonly GraphNode[], start: number, length: number): GraphNode | null {
  let best: GraphNode | null = null;
  for (const node of nodes) {
    const from = node.src.offset;
    const to = from + node.src.length;
    if (start < from || start + Math.max(length, 0) > to) continue;
    if (
      best === null ||
      node.src.length < best.src.length ||
      (node.src.length === best.src.length && node.id < best.id)
    ) {
      best = node;
    }
  }
  return best;
}

/** Slither's path may be relative to wherever it ran; match by suffix if so. */
function filesFor(mapping: RawSourceMapping, index: Map<string, GraphNode[]>): GraphNode[] | null {
  const candidates = [
    str(mapping.filename_relative),
    str(mapping.filename_short),
    str(mapping.filename_absolute),
  ].filter((value) => value.length > 0);

  for (const candidate of candidates) {
    const direct = index.get(candidate);
    if (direct !== undefined) return direct;
  }
  for (const candidate of candidates) {
    for (const [file, nodes] of index) {
      if (candidate.endsWith(`/${file}`) || file.endsWith(`/${candidate}`)) return nodes;
    }
  }
  return null;
}

export function importSlitherFindings(
  graph: AxiomapGraph,
  raw: unknown,
  source = '<memory>',
): FindingsImport {
  const detectors = detectorsOf(raw, source);
  const index = nodesByFile(graph);

  const findings: ImportedFinding[] = [];
  const unmapped: UnmappedFinding[] = [];
  // Two results of the same detector can share an anchor — Slither reports one
  // per call site for some checks. Suffixing keeps the id unique without making
  // it depend on array position for the common case.
  const used = new Map<string, number>();

  for (const detector of detectors) {
    const check = str(detector.check, 'unknown');
    const description = str(detector.description).trim();
    const elements = Array.isArray(detector.elements) ? (detector.elements as RawElement[]) : [];

    const nodes = new Set<string>();
    const locations: SourceRefRecord[] = [];
    let anchor: string | null = null;

    for (const element of elements) {
      const mapping = element.source_mapping;
      if (mapping === undefined || mapping === null) continue;
      const start = num(mapping.start);
      if (start === null) continue;
      const length = num(mapping.length) ?? 0;
      const lines = Array.isArray(mapping.lines) ? mapping.lines : [];
      const line = num(lines[0]) ?? 1;

      const inFile = filesFor(mapping, index);
      const file = inFile?.[0]?.file ?? str(mapping.filename_relative, str(mapping.filename_short));
      locations.push({ file, offset: start, length, line, column: 0 });
      if (anchor === null) anchor = `${file}:${String(start)}`;

      if (inFile === null) continue;
      const hit = containing(inFile, start, length);
      if (hit !== null) nodes.add(hit.id);
    }

    if (nodes.size === 0) {
      unmapped.push({
        check,
        description,
        reason:
          elements.length === 0
            ? 'the finding names no source element'
            : locations.length === 0
              ? 'no element carries a source mapping'
              : 'no node in the graph contains any of the reported locations (a file Axiomap ' +
                'did not graph, or a stale Slither run)',
      });
      continue;
    }

    const base = `${check}@${anchor ?? String(findings.length)}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);

    findings.push({
      id: seen === 0 ? base : `${base}#${String(seen)}`,
      check,
      impact: str(detector.impact, 'Unknown'),
      confidence: str(detector.confidence, 'Unknown'),
      description,
      nodes: [...nodes]
        .sort()
        .map((id) => ({ id, bodyHash: bodyHashOf(graph, id) })),
      locations,
    });
  }

  findings.sort((a, b) => a.id.localeCompare(b.id));
  unmapped.sort((a, b) => a.check.localeCompare(b.check) || a.description.localeCompare(b.description));

  return { findings, unmapped, total: detectors.length };
}
