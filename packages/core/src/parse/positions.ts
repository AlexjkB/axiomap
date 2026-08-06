/**
 * UTF-16 index → byte offset / line / column.
 *
 * The parser reports positions as JavaScript string indices, i.e. in UTF-16
 * code units. §10 requires `SourceRef.offset` to be a **byte** offset, because
 * that is what solc's `src` field uses and what the semantic tier in Phase 3
 * will have to line up against. On any file containing a non-ASCII character
 * the two differ, and the symptom — navigation landing a few characters off,
 * only in some files — looks like an intermittent bug rather than an encoding
 * mistake. Conversion lives here rather than in a backend so that swapping the
 * backend cannot change a single byte offset.
 *
 * `line`/`column` keep the editor convention instead: 1-based line, 0-based
 * column in UTF-16 code units, which is exactly what VS Code's `Position`
 * wants. The mix is deliberate — `offset` is for the compiler, `line`/`column`
 * are for the editor.
 */

export interface SourceRef {
  /** Repo-relative path. */
  file: string;
  /** Byte offset from the start of the file. */
  offset: number;
  /** Length in bytes. */
  length: number;
  /** 1-based. */
  line: number;
  /** 0-based, in UTF-16 code units. */
  column: number;
}

export class PositionIndex {
  readonly file: string;

  readonly #text: string;
  /** UTF-16 index at which each line starts. */
  readonly #lineStarts: number[];
  /** Byte offset at which each line starts. Empty when the file is ASCII. */
  readonly #lineByteStarts: number[];
  /** ASCII files need no conversion at all; this is the common case. */
  readonly #isAscii: boolean;

  constructor(file: string, text: string) {
    this.file = file;
    this.#text = text;

    let ascii = true;
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0x7f) ascii = false;
      if (code === 10 /* \n */) lineStarts.push(i + 1);
    }
    this.#isAscii = ascii;
    this.#lineStarts = lineStarts;

    if (ascii) {
      this.#lineByteStarts = [];
    } else {
      const byteStarts: number[] = new Array<number>(lineStarts.length);
      byteStarts[0] = 0;
      for (let l = 1; l < lineStarts.length; l++) {
        const prevStart = lineStarts[l - 1] as number;
        const thisStart = lineStarts[l] as number;
        byteStarts[l] =
          (byteStarts[l - 1] as number) +
          Buffer.byteLength(text.slice(prevStart, thisStart), 'utf8');
      }
      this.#lineByteStarts = byteStarts;
    }
  }

  /** Total length of the file in bytes. */
  get byteLength(): number {
    return this.byteOffsetAt(this.#text.length);
  }

  /** 0-based line index for a UTF-16 string index. */
  lineIndexAt(utf16Index: number): number {
    const starts = this.#lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= utf16Index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  byteOffsetAt(utf16Index: number): number {
    if (this.#isAscii) return utf16Index;
    const line = this.lineIndexAt(utf16Index);
    const lineStart = this.#lineStarts[line] as number;
    return (
      (this.#lineByteStarts[line] as number) +
      Buffer.byteLength(this.#text.slice(lineStart, utf16Index), 'utf8')
    );
  }

  /**
   * The inverse of `byteOffsetAt`: a byte offset back to a UTF-16 index.
   *
   * Phase 8 needs it because an editor is the one consumer that works the other
   * way round. `SourceRef` carries `line`/`column` for the *start* of a node
   * (which is already a VS Code `Position`), but its extent is `length` in
   * bytes, and selecting a declaration means turning the end of that range into
   * a position in a buffer. Doing it by re-encoding in the extension would be a
   * second implementation of the conversion §10 warns about, in the host whose
   * whole job is landing the cursor in the right place.
   *
   * An offset inside a multi-byte character resolves to the start of that
   * character rather than throwing: half a code point is not a position, and a
   * graph built from a different revision of a file is the ordinary way to ask
   * for one.
   */
  utf16IndexAt(byteOffset: number): number {
    if (this.#isAscii) return Math.max(0, Math.min(byteOffset, this.#text.length));
    const clamped = Math.max(0, Math.min(byteOffset, this.byteLength));

    const starts = this.#lineByteStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= clamped) lo = mid;
      else hi = mid - 1;
    }

    let index = this.#lineStarts[lo] as number;
    let bytes = starts[lo] as number;
    while (bytes < clamped && index < this.#text.length) {
      const size = Buffer.byteLength(this.#text[index] as string, 'utf8');
      // A surrogate pair is two UTF-16 units and one character; `text[index]`
      // gives the high surrogate alone, whose lone encoding is 3 bytes rather
      // than the pair's 4. Step by the pair.
      const pair =
        (this.#text.charCodeAt(index) & 0xfc00) === 0xd800 && index + 1 < this.#text.length;
      const step = pair ? 4 : size;
      if (bytes + step > clamped) break;
      bytes += step;
      index += pair ? 2 : 1;
    }
    return index;
  }

  /**
   * Build a SourceRef from a half-open UTF-16 range `[start, end)`.
   *
   * The range is half-open, and every backend normalises to that before
   * calling in. Worth stating because parsers disagree on the convention —
   * tree-sitter's `endIndex` is exclusive, but the ANTLR backend Phase 1
   * benchmarked reported an inclusive end, and getting it wrong costs exactly
   * one character on every node in the graph.
   */
  ref(startUtf16: number, endUtf16Exclusive: number): SourceRef {
    const start = Math.max(0, Math.min(startUtf16, this.#text.length));
    const end = Math.max(start, Math.min(endUtf16Exclusive, this.#text.length));
    const startByte = this.byteOffsetAt(start);
    const endByte = this.byteOffsetAt(end);
    const line = this.lineIndexAt(start);
    return {
      file: this.file,
      offset: startByte,
      length: endByte - startByte,
      line: line + 1,
      column: start - (this.#lineStarts[line] as number),
    };
  }
}
