/**
 * §11's code preview, at the layer that reads the bytes (Phase 7d).
 *
 * Two things are being checked here and they are of different kinds.
 *
 * The first is **byte offsets**, which §10 warns about in as many words: get
 * them wrong and "navigation lands in the wrong place in any file containing
 * non-ASCII characters, and it will look like a random intermittent bug".
 * `pathological/`'s `Crlf.sol` exists for exactly this — CRLF endings and
 * multi-byte characters in the comments *above* the declaration being sliced —
 * so a character-offset implementation lands short by the number of extra bytes
 * and this suite says so.
 *
 * The second is what this module refuses. It is the first payload in the
 * project that ships the user's source, and the reason it is safe is that a
 * request names a node rather than a path. That is a property to assert, not a
 * comment to trust.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { graphFromFile, sliceNode, SourceUnavailableError } from '../src/index.js';
import { fixture } from './fixtures.js';
import { graphOf } from './graphs.js';

const DEFI = fixture('defi');
const PATHOLOGICAL = fixture('pathological');

const MINT = 'src/Pair.sol:Pair.mint(address)';
const PAIR = 'src/Pair.sol:Pair';

describe('sliceNode', () => {
  it('returns exactly the declaration, whole lines, with the right line number', async () => {
    const { graph } = await graphOf('defi');
    const slice = sliceNode(graph, DEFI, MINT);

    // Hand-read from the fixture: `function mint(address to)` opens on line 69.
    expect(slice.startLine).toBe(69);
    expect(slice.focusStartLine).toBe(69);
    expect(slice.file).toBe('src/Pair.sol');
    expect(slice.language).toBe('solidity');

    expect(slice.text.startsWith('    function mint(address to)')).toBe(true);
    expect(slice.text.trimEnd().endsWith('}')).toBe(true);
    expect(slice.truncated).toBe(false);
    expect(slice.drifted).toBe(false);

    // The slice really is a window on the file rather than a re-render of it.
    const source = fs.readFileSync(path.join(DEFI, 'src/Pair.sol'), 'utf8');
    expect(source).toContain(slice.text);
  });

  it('numbers its first line correctly when context is asked for', async () => {
    const { graph } = await graphOf('defi');
    const slice = sliceNode(graph, DEFI, MINT, { context: 3 });

    expect(slice.startLine).toBe(66);
    // The declaration is still identified within the wider window, which is
    // what lets the panel highlight it rather than the context around it.
    expect(slice.focusStartLine).toBe(69);
    expect(slice.text.split('\n')[0]).toContain('return (reserve0, reserve1);');
  });

  /**
   * §10's byte-offset warning, in the fixture written for it. Every line in
   * `Crlf.sol` ends CRLF and the comments above `set` contain `é`, `世界` and an
   * emoji — so a character-offset slice starts several bytes early and lands
   * inside the comment instead of on the function.
   */
  it('slices by bytes, not characters, through CRLF and multi-byte text', async () => {
    const { graph } = await graphOf('pathological');
    const id = 'src/Crlf.sol:Crlf.set(uint256)';
    const slice = sliceNode(graph, PATHOLOGICAL, id);

    expect(slice.text.startsWith('    function set(uint256 v) external {')).toBe(true);
    expect(slice.text).toContain('value = v;');
    // The comment above it is *not* in the slice: had the offset been counted
    // in characters, the multi-byte ones would have pulled the start into it.
    expect(slice.text).not.toContain('@dev');
    expect(slice.drifted).toBe(false);

    // CRLF survives rather than being normalised away. The file is what it is,
    // and a preview that quietly rewrites line endings is a preview of
    // something else.
    expect(slice.text).toContain('\r\n');
  });

  it('caps a long declaration at a line boundary and says it did', async () => {
    const { graph } = await graphOf('defi');
    const slice = sliceNode(graph, DEFI, PAIR, { limit: 200 });

    expect(slice.truncated).toBe(true);
    expect(Buffer.byteLength(slice.text)).toBeLessThanOrEqual(200);
    // Cut between lines, never mid-line: half a line of Solidity reads as a
    // syntax error in the user's own code.
    expect(slice.text.endsWith('\n')).toBe(true);
  });

  it('refuses a node that is not in the graph', async () => {
    const { graph } = await graphOf('defi');
    expect(() => sliceNode(graph, DEFI, 'src/Nope.sol:Nope.f()')).toThrow(SourceUnavailableError);
  });

  /**
   * §10's synthetic placeholders stand for a call whose target could not be
   * bound. There is nothing on disk to show, and §4's whole position is that
   * saying so is the correct answer rather than an embarrassment.
   */
  it('refuses an Unresolved placeholder, and explains what it is', async () => {
    // `minimal/`, not `pathological/`: the latter scores below §4's threshold
    // and so is in structural mode, which drops the orphaned placeholders (§10).
    const { graph } = await graphOf('minimal');
    const ids: string[] = [];
    graph.forEachNode((_key, node) => {
      if (node.kind === 'Unresolved') ids.push(node.id);
    });
    expect(ids.length).toBeGreaterThan(0);

    expect(() => sliceNode(graph, fixture('minimal'), ids[0] as string)).toThrow(
      /unresolved placeholder/,
    );
  });

  /**
   * The security property, asserted rather than asserted-in-a-comment: the
   * only thing a caller supplies is a node id, and every path this module opens
   * came out of the graph. There is no id that reaches a file the graph does
   * not already name.
   */
  it('takes its path from the graph, so no request can name a file', async () => {
    const { graph } = await graphOf('defi');
    const files = new Set<string>();
    graph.forEachNode((_key, node) => files.add(node.file));

    for (const attempt of [
      '../../../etc/passwd',
      'src/Pair.sol',
      '/etc/passwd',
      'src/Pair.sol:Pair.mint(address)/../../../etc/passwd',
    ]) {
      // Every one of these is refused as "not a node", which is the point: the
      // parameter is an id, and an id that is not in the graph has no path.
      if (graph.hasNode(attempt)) continue;
      expect(() => sliceNode(graph, DEFI, attempt)).toThrow(SourceUnavailableError);
    }

    // And the one that does work names a file the graph already knew about.
    expect(files.has(sliceNode(graph, DEFI, MINT).file)).toBe(true);
  });

  /**
   * §10's `SourceUnit` marks a file rather than spanning it — offset 0, length
   * 0 — so slicing it literally returns one line of licence header, which is a
   * preview of nothing. The file is what it means.
   */
  it('previews a whole file when the node is the file', async () => {
    const { graph } = await graphOf('defi');
    const slice = sliceNode(graph, DEFI, 'src/Pair.sol');

    expect(slice.startLine).toBe(1);
    expect(slice.text).toContain('contract Pair is IPair, Shares');
    expect(slice.text).toContain('function swap(');
    expect(slice.truncated).toBe(false);
    // A file cannot have shifted relative to itself, and its `name` is a
    // basename that need not appear in the text.
    expect(slice.drifted).toBe(false);
  });

  /**
   * The belt-and-braces half of the security design.
   *
   * A request cannot reach this: the path comes from the graph, so there is no
   * input that makes it escape. What reaches it is a graph built somewhere else
   * or edited by hand — and this process has read access to the whole checkout,
   * so the guard is worth having *and* worth testing rather than asserting in a
   * comment.
   */
  it('refuses a graph whose node claims a file outside the project', async () => {
    const { file } = await graphOf('defi');
    const scratch = fs.mkdtempSync(path.join('/tmp', 'axiomap-escape-'));
    try {
      // A hand-edited graph, which is exactly what the guard is for. Rebuilt
      // from the serialized form rather than mutated in place: `graphs.ts`
      // shares one build across the suite and nothing may write to it.
      const forged = graphFromFile(JSON.parse(JSON.stringify(file)) as typeof file);
      forged.setNodeAttribute(MINT, 'file', '../../../etc/passwd');

      expect(() => sliceNode(forged, scratch, MINT)).toThrow(/resolves outside the project/);
      expect(() => sliceNode(forged, scratch, MINT)).toThrow(SourceUnavailableError);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('says which file it could not read, rather than throwing an ENOENT', async () => {
    const { graph } = await graphOf('defi');
    const empty = fs.mkdtempSync(path.join('/tmp', 'axiomap-missing-'));
    try {
      expect(() => sliceNode(graph, empty, MINT)).toThrow(
        /Could not read src\/Pair\.sol.*different checkout/s,
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  /**
   * §12 builds `serve`'s graph once, and `.axiomap/graph.json` can be older
   * still. Byte offsets into a file that has since moved point at the wrong
   * code, and a preview confidently showing the wrong function is the failure
   * §16 refuses to risk for build-info offsets. The check is one-directional
   * and cheap, and this is the case it exists for.
   */
  it('reports drift when the file no longer matches the graph', async () => {
    const { graph } = await graphOf('defi');
    const scratch = fs.mkdtempSync(path.join(process.env['RUNNER_TEMP'] ?? '/tmp', 'axiomap-slice-'));
    try {
      fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
      const original = fs.readFileSync(path.join(DEFI, 'src/Pair.sol'), 'utf8');
      // Twenty lines inserted at the top: every offset below is now wrong by
      // exactly the bytes they occupy, which is what an edit does.
      fs.writeFileSync(
        path.join(scratch, 'src/Pair.sol'),
        `${'// pushed down\n'.repeat(20)}${original}`,
      );

      const slice = sliceNode(graph, scratch, MINT);
      expect(slice.drifted).toBe(true);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  /**
   * Phase 8: an editor is the one host where the file on disk is routinely not
   * what the user is looking at.
   *
   * A preview read off disk while the buffer has unsaved changes shows a
   * function the screen does not contain, and `drifted` cannot catch it —
   * the graph and the disk agree, and it is the *editor* that has moved on. So
   * the caller may supply the bytes; the path still comes from the graph.
   */
  describe('reading from a caller’s buffer rather than from disk', () => {
    it('slices what the caller supplied', async () => {
      const { graph } = await graphOf('defi');
      const onDisk = sliceNode(graph, DEFI, MINT);
      const edited = fs
        .readFileSync(path.join(DEFI, 'src/Pair.sol'), 'utf8')
        .replace('function mint(', 'function mint( /* unsaved */ ');

      const slice = sliceNode(graph, DEFI, MINT, { read: () => edited });
      expect(slice.text).toContain('unsaved');
      expect(onDisk.text).not.toContain('unsaved');
    });

    it('is asked about the node’s own file, and falls back to disk', async () => {
      const { graph } = await graphOf('defi');
      const asked: string[] = [];
      const slice = sliceNode(graph, DEFI, MINT, {
        read: (file) => {
          asked.push(file);
          return undefined;
        },
      });
      // The path is the graph's, not the caller's: there is no parameter here
      // through which a file could be named.
      expect(asked).toEqual(['src/Pair.sol']);
      expect(slice.text).toContain('function mint(');
    });

    it('still reports drift, against the buffer', async () => {
      const { graph } = await graphOf('defi');
      const pushed = `${'// pushed down\n'.repeat(20)}${fs.readFileSync(
        path.join(DEFI, 'src/Pair.sol'),
        'utf8',
      )}`;
      expect(sliceNode(graph, DEFI, MINT, { read: () => pushed }).drifted).toBe(true);
    });
  });
});
