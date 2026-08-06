/**
 * A byte range of the user's source, for §11's inline code preview.
 *
 * ### Why this is not in `query/`, and why it is not in the CLI
 *
 * Every payload that has crossed §9 rule 1's bridge so far is graph-derived: a
 * subgraph, a node's attributes, a map from node id to a review status. This is
 * the first one that ships **the client's actual source code** to a browser, so
 * it gets its own module and its own rules rather than being appended to the
 * query API.
 *
 * `query/` is deliberately `fs`-free — it is "the API both CLI and webview
 * consume" (§5) and reading a file is not a question about the graph. But the
 * CLI is the wrong home too: Phase 8's VS Code host implements the same
 * `HostBridge`, and a slice that lived in `packages/cli` would be reimplemented
 * there, which is exactly the second implementation Phase 7b's notes forbid for
 * the inspector. So: `core/source/`, which may use `fs` (§6 keeps core to `fs`),
 * consumed by both hosts.
 *
 * ### The request names a node, never a path
 *
 * This is the whole security design and it is worth stating plainly, because
 * the obvious convenient shape — "give me lines 40–80 of `src/Vault.sol`" —
 * turns a graph viewer into a file server for whatever the process can read.
 * The caller supplies a **node id**; the path comes from the graph, and a node
 * id that is not in the graph is refused. There is no parameter through which a
 * caller can name a file, so there is no traversal to guard against. The
 * realpath check below is a second lock on the same door, for the case where a
 * graph was hand-edited or built somewhere else.
 *
 * ### The range is bounded, and says when it was cut
 *
 * A node's `src` spans its whole declaration, and a 4,000-line library is a
 * declaration. The preview is a panel, not an editor, so the slice is capped
 * and reports `truncated` rather than either shipping a megabyte or silently
 * showing the first screenful as though it were the whole thing.
 *
 * ### Offsets are bytes (§10), and this is the file where that bites
 *
 * §10 is emphatic that `SourceRef.offset` is a byte offset, and warns that
 * getting it wrong "will look like a random intermittent bug" in any file with
 * non-ASCII characters. So the file is read as a `Buffer` and sliced as bytes;
 * the decode to a string happens once, at the end, on the range that is being
 * returned. Expanding to line boundaries is a scan for `\n` **bytes**, which is
 * safe in UTF-8 because no continuation byte can be `0x0a`.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { AxiomapGraph } from '../graph/build.js';

/** Bytes. Enough for a long function, far short of a vendored library. */
export const DEFAULT_SLICE_LIMIT = 24_000;

export interface SourceSliceOptions {
  /** Whole lines of context on each side of the declaration. */
  context?: number;
  /** Byte ceiling on the returned text. */
  limit?: number;
  /**
   * Where the bytes come from, when the caller has a better copy than the disk.
   *
   * Added in Phase 8 for the one host where "the file" is routinely not what
   * the user is looking at: an editor with unsaved changes. A preview read off
   * disk would then show a function the buffer no longer contains, and
   * `drifted` could not catch it — the graph and the disk agree, and it is the
   * *screen* that has moved on.
   *
   * It takes the repo-relative path the graph holds and returns the current
   * text, or undefined to fall back to disk. It cannot be used to read a file
   * of the caller's choosing: the path still comes from the node, and the
   * containment check below still runs.
   */
  read?: (file: string) => string | undefined;
}

export interface SourceSlice {
  /** The node this is the source of. */
  id: string;
  /** Repo-relative, as §10 records it. */
  file: string;
  /** For the highlighter. Solidity is the only language this tool parses. */
  language: 'solidity';
  /** The slice itself, decoded UTF-8. */
  text: string;
  /** 1-based line of the slice's first line, so a gutter can be numbered. */
  startLine: number;
  /** 1-based first and last line of the *declaration* within the slice. */
  focusStartLine: number;
  focusEndLine: number;
  /** Lines in `text`. */
  lines: number;
  /** True when the declaration was longer than the limit and was cut. */
  truncated: boolean;
  /**
   * True when the file on disk no longer looks like what the graph describes.
   *
   * The graph may have been loaded from a `.axiomap/graph.json` artifact, or
   * held in memory by a long-running `axiomap serve` while the file was edited
   * underneath it (§12: the graph is built once). Byte offsets into a file that
   * has since moved point at the wrong code, and a preview that is confidently
   * showing the wrong function is precisely the failure §16 refuses to risk for
   * build-info. The check is cheap and one-directional: the declared name has
   * to appear on the declaration's **first line**, which is where Solidity
   * puts it for every kind this slices. It cannot prove the slice is right; it
   * reliably catches a file whose lines have shifted.
   *
   * Deliberately not "the name appears anywhere in the slice" — that was the
   * first version, and it reported no drift on a `Pair.sol` shifted twenty
   * lines because the window it landed on contained `_mintShares` and the node
   * was called `mint`. A substring test over a whole function body will match
   * something eventually, which makes it a check that passes rather than a
   * check that holds.
   */
  drifted: boolean;
}

export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

/** Byte offset of the start of the line containing `offset`. */
function lineStart(buffer: Buffer, offset: number): number {
  const index = buffer.lastIndexOf(0x0a, Math.max(0, offset - 1));
  return index === -1 ? 0 : index + 1;
}

/** Byte offset just past the end of the line containing `offset`. */
function lineEnd(buffer: Buffer, offset: number): number {
  const index = buffer.indexOf(0x0a, offset);
  return index === -1 ? buffer.length : index + 1;
}

/** Step `count` line starts backwards from `offset`. */
function back(buffer: Buffer, offset: number, count: number): number {
  let at = lineStart(buffer, offset);
  for (let step = 0; step < count && at > 0; step += 1) at = lineStart(buffer, at - 1);
  return at;
}

/** Step `count` line ends forwards from `offset`. */
function forward(buffer: Buffer, offset: number, count: number): number {
  let at = lineEnd(buffer, offset);
  for (let step = 0; step < count && at < buffer.length; step += 1) at = lineEnd(buffer, at + 1);
  return at;
}

function countLines(buffer: Buffer, from: number, to: number): number {
  let lines = 0;
  for (let at = from; at < to; at += 1) if (buffer[at] === 0x0a) lines += 1;
  return lines;
}

/**
 * One node's source, as bytes read from disk at the moment of asking.
 *
 * `root` is the project directory the graph was built from; every path in the
 * graph is relative to it.
 */
export function sliceNode(
  graph: AxiomapGraph,
  root: string,
  id: string,
  options: SourceSliceOptions = {},
): SourceSlice {
  if (!graph.hasNode(id)) {
    throw new SourceUnavailableError(`No node with id "${id}" is in this graph.`);
  }
  const node = graph.getNodeAttributes(id);

  // §10: an `Unresolved` node is a placeholder for a call whose target could
  // not be bound. It stands for nothing on disk, and the honest answer is to
  // say so rather than to slice whatever its dummy `src` points at.
  if (node.kind === 'Unresolved') {
    throw new SourceUnavailableError(
      `"${node.name}" is an unresolved placeholder (${node.category}), not a declaration — ` +
        'there is no source to show. Its callers have the call site.',
    );
  }

  const base = path.resolve(root);
  const target = path.resolve(base, node.file);
  // The path came from the graph rather than from the caller, so this cannot
  // be reached by a crafted request. It is here for a graph that was built
  // elsewhere or edited by hand — the same belt-and-braces as `serve`'s static
  // file guard, and for the same reason: this process can read the whole
  // checkout.
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new SourceUnavailableError(
      `"${node.file}" resolves outside the project (${base}); refusing to read it.`,
    );
  }

  const supplied = options.read?.(node.file);
  let buffer: Buffer;
  if (supplied === undefined) {
    try {
      buffer = fs.readFileSync(target);
    } catch {
      throw new SourceUnavailableError(
        `Could not read ${node.file}. The graph may have been built from a different checkout.`,
      );
    }
  } else {
    buffer = Buffer.from(supplied, 'utf8');
  }

  const context = Math.max(0, options.context ?? 0);
  const limit = Math.max(1, options.limit ?? DEFAULT_SLICE_LIMIT);

  // Clamped, because a stale graph can name an offset past the end of a file
  // that has since shrunk — which must read as drift, not as a crash.
  const declStart = Math.min(node.src.offset, buffer.length);
  const declEnd =
    node.kind === 'SourceUnit'
      ? // A SourceUnit's `src` is a marker at offset 0 with length 0 — it
        // stands for the file rather than spanning it (§10's node kinds are
        // declarations, and a file is the thing they are declared in). Slicing
        // it literally gives one line of licence header, which is a preview of
        // nothing. The whole file is what it means, and the limit below is what
        // keeps that bounded.
        buffer.length
      : Math.min(node.src.offset + node.src.length, buffer.length);

  const from = back(buffer, declStart, context);
  const wanted = forward(buffer, Math.max(declEnd - 1, declStart), context);

  // Cut at a line boundary rather than mid-line: half a line of Solidity in a
  // syntax highlighter reads as a parse error in the user's code.
  let to = wanted;
  let truncated = false;
  if (to - from > limit) {
    to = lineStart(buffer, from + limit);
    if (to <= from) to = lineEnd(buffer, from);
    truncated = true;
  }

  const text = buffer.toString('utf8', from, to);
  const startLine = node.src.line - countLines(buffer, from, declStart);
  const declLines = countLines(buffer, declStart, Math.max(declEnd - 1, declStart));

  return {
    id: node.id,
    file: node.file,
    language: 'solidity',
    text,
    startLine,
    focusStartLine: node.src.line,
    focusEndLine: node.src.line + declLines,
    lines: countLines(buffer, from, to) + (to > from && buffer[to - 1] !== 0x0a ? 1 : 0),
    truncated,
    // A SourceUnit is a whole file and its `name` is the path's basename, which
    // need not appear in the text; there is nothing to check it against, and a
    // file read whole cannot be shifted relative to itself.
    drifted:
      node.kind !== 'SourceUnit' &&
      !buffer
        .toString('utf8', lineStart(buffer, declStart), lineEnd(buffer, declStart))
        .includes(node.name),
  };
}
