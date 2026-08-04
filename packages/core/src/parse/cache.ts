/**
 * Content-hash-keyed disk cache for parse results (§9, ingest budget).
 *
 * Keyed by `xxhash64(parserId + schema version + path + file text)`. The key
 * ignores mtime, which matters because git checkouts rewrite mtimes wholesale
 * and diff mode (§8) checks out old revisions constantly — content that has
 * not changed stays a hit across a checkout.
 *
 * The path is in the key even though every `SourceRef` could in principle be
 * re-stamped on a cross-path hit. Sharing one entry between two byte-identical
 * files saves a parse; getting the re-stamp subtly wrong puts navigation in
 * the wrong copy of a duplicated file, which `pathological/` has two of on
 * purpose. The parse is cheaper than the bug.
 *
 * `PARSE_SCHEMA_VERSION` is part of the key on purpose. Changing the neutral
 * AST invalidates every entry rather than silently deserialising an old shape
 * into a new type.
 */

import fs from 'node:fs';
import path from 'node:path';

import xxhash from 'xxhash-wasm';

import type { ParserId, ParseResult } from './interface.js';

/**
 * Bump on any change to the `ParsedSourceUnit` shape.
 *
 * 2 — Phase 2 added expression-level detail to `ParsedFunction`: call sites,
 * identifier uses, emits, reverts, locals, flags, metrics and §8's hashes.
 *
 * 3 — Phase 4 added `flags.checksSender`. A cached v2 entry would deserialise
 * with the field absent and report every inline `msg.sender` guard as no guard
 * at all, which is the wrong direction for an access-control overlay to fail
 * in.
 */
export const PARSE_SCHEMA_VERSION = 3;

export interface Hasher {
  h64ToString(input: string): string;
}

let hasherPromise: Promise<Hasher> | null = null;

export async function getHasher(): Promise<Hasher> {
  hasherPromise ??= xxhash().then((api) => ({ h64ToString: api.h64ToString }));
  return hasherPromise;
}

export interface ParseCacheStats {
  hits: number;
  misses: number;
  writes: number;
  errors: number;
}

export class ParseCache {
  readonly #dir: string;
  readonly #hasher: Hasher;
  readonly #parserId: ParserId;
  readonly #stats: ParseCacheStats = { hits: 0, misses: 0, writes: 0, errors: 0 };

  private constructor(dir: string, hasher: Hasher, parserId: ParserId) {
    this.#dir = dir;
    this.#hasher = hasher;
    this.#parserId = parserId;
  }

  static async open(dir: string, parserId: ParserId): Promise<ParseCache> {
    const hasher = await getHasher();
    return new ParseCache(dir, hasher, parserId);
  }

  get stats(): Readonly<ParseCacheStats> {
    return this.#stats;
  }

  key(file: string, text: string): string {
    return this.#hasher.h64ToString(`${this.#parserId} ${PARSE_SCHEMA_VERSION} ${file} ${text}`);
  }

  #pathFor(key: string): string {
    // Two-character fan-out: 200k SLOC is ~1k files, and a flat directory of
    // tens of thousands of entries is measurably slower to stat on ext4.
    return path.join(this.#dir, key.slice(0, 2), `${key}.json`);
  }

  get(file: string, text: string): ParseResult | null {
    const key = this.key(file, text);
    try {
      const raw = fs.readFileSync(this.#pathFor(key), 'utf8');
      this.#stats.hits++;
      return JSON.parse(raw) as ParseResult;
    } catch {
      this.#stats.misses++;
      return null;
    }
  }

  set(file: string, text: string, result: ParseResult): void {
    const key = this.key(file, text);
    const target = this.#pathFor(key);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Write-then-rename: a cache half-written by an interrupted run must
      // not be readable, or the next run parses nothing and trusts it.
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(result), 'utf8');
      fs.renameSync(temporary, target);
      this.#stats.writes++;
    } catch {
      // A cache that cannot be written is a slow run, not a failed one.
      this.#stats.errors++;
    }
  }

  clear(): void {
    fs.rmSync(this.#dir, { recursive: true, force: true });
  }
}
