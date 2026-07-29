import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PositionIndex } from '../src/parse/positions.js';
import { FIXTURE_ROOT } from './fixtures.js';

describe('PositionIndex', () => {
  it('treats offsets as byte offsets, not UTF-16 indices', () => {
    // "é" is two bytes in UTF-8 and one UTF-16 code unit; "🔥" is four and two.
    const text = 'contract A {\n    // é🔥\n    uint256 x;\n}\n';
    const index = new PositionIndex('T.sol', text);

    const utf16 = text.indexOf('uint256');
    const ref = index.ref(utf16, utf16 + 'uint256'.length);

    expect(ref.offset).toBe(Buffer.byteLength(text.slice(0, utf16), 'utf8'));
    expect(ref.offset).toBeGreaterThan(utf16);
    expect(ref.length).toBe(7);
  });

  it('reports 1-based lines and 0-based columns', () => {
    const text = 'a\nbb\nccc\n';
    const index = new PositionIndex('T.sol', text);

    expect(index.ref(0, 1)).toMatchObject({ line: 1, column: 0 });
    expect(index.ref(2, 4)).toMatchObject({ line: 2, column: 0 });
    expect(index.ref(3, 4)).toMatchObject({ line: 2, column: 1 });
    expect(index.ref(5, 8)).toMatchObject({ line: 3, column: 0 });
  });

  it('keeps CRLF bytes inside the line they terminate', () => {
    const text = 'one\r\ntwo\r\n';
    const index = new PositionIndex('T.sol', text);

    const two = index.ref(5, 8);
    expect(two).toMatchObject({ line: 2, column: 0 });
    // "one\r\n" is five bytes, so line 2 starts at byte 5 — not byte 4.
    expect(two.offset).toBe(5);
  });

  it('agrees with Buffer.byteLength across the whole CRLF fixture', () => {
    // The one fixture that combines CRLF with multi-byte characters. If byte
    // arithmetic is wrong anywhere, it is wrong here.
    const file = `${FIXTURE_ROOT}/pathological/src/Crlf.sol`;
    const text = readFileSync(file, 'utf8');
    const index = new PositionIndex('src/Crlf.sol', text);

    expect(text).toContain('\r\n');
    expect(index.byteLength).toBe(Buffer.byteLength(text, 'utf8'));

    for (const needle of ['contract Crlf', 'function set', 'function get', 'value = v;']) {
      const utf16 = text.indexOf(needle);
      expect(utf16).toBeGreaterThan(-1);
      const ref = index.ref(utf16, utf16 + needle.length);
      expect(ref.offset).toBe(Buffer.byteLength(text.slice(0, utf16), 'utf8'));
      expect(ref.length).toBe(Buffer.byteLength(needle, 'utf8'));
    }
  });

  it('is the identity on ASCII input', () => {
    const text = 'contract A { uint256 x; }\n';
    const index = new PositionIndex('T.sol', text);
    for (let i = 0; i <= text.length; i++) {
      expect(index.byteOffsetAt(i)).toBe(i);
    }
  });
});
