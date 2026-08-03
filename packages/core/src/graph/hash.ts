/**
 * Body and interface hashes (§8).
 *
 * Decision #3 makes diff a day-one constraint, and the whole review-invalidation
 * feature reduces to one comparison: is this node's `bodyHash` still the one
 * recorded when it was reviewed? So the definition of "the same body" is a
 * product decision, not an implementation detail:
 *
 * - **Comments and whitespace do not count.** Reformatting a repo or fixing a
 *   typo in a NatSpec line must not invalidate every review in it. The hash is
 *   taken over the body's non-comment *tokens*, joined by single spaces, which
 *   is whitespace- and comment-insensitive by construction rather than by a
 *   regex that has to know about string literals.
 * - **Everything else does count.** Renaming a local, reordering statements,
 *   changing a literal — all of those change behaviour and should force a
 *   re-read.
 *
 * `interfaceHash` is deliberately separate. §8: an interface change is a
 * breaking change, a body change is a re-review trigger, and a tool that cannot
 * tell them apart reports both as "modified".
 *
 * xxhash rather than a cryptographic hash, per §3 — this needs speed, and
 * nothing here is a security boundary. It is called once per function.
 */

import type { Hasher } from '../parse/cache.js';
import { normaliseTypeName } from '../symbols/ids.js';

/** Bump when the hashing rules change; it invalidates every stored review. */
export const HASH_VERSION = 1;

/**
 * Join tokens the way both hashes expect: single space, no leading or trailing
 * padding. Exported so a test can assert two spellings of the same body
 * normalise identically without reaching into the parser.
 */
export function normaliseTokens(tokens: readonly string[]): string {
  return tokens.join(' ');
}

export function hashBody(hasher: Hasher, tokens: readonly string[]): string {
  return hasher.h64ToString(`b${HASH_VERSION} ${normaliseTokens(tokens)}`);
}

export interface InterfaceHashInput {
  name: string;
  /** `function` | `constructor` | `fallback` | `receive` | `modifier`. */
  subkind: string;
  visibility: string;
  stateMutability: string;
  /** Declared parameter type text, as written; normalised here. */
  params: readonly string[];
  returns: readonly string[];
  /** Modifier invocation names, in source order. */
  modifiers: readonly string[];
}

/**
 * Modifier order is part of the hash. `nonReentrant onlyOwner` and
 * `onlyOwner nonReentrant` differ in evaluation order, and in a reentrancy
 * review that difference is the thing being checked.
 */
export function hashInterface(hasher: Hasher, input: InterfaceHashInput): string {
  const parts = [
    `i${HASH_VERSION}`,
    input.subkind,
    input.name,
    `(${input.params.map(normaliseTypeName).join(',')})`,
    `returns(${input.returns.map(normaliseTypeName).join(',')})`,
    input.visibility,
    input.stateMutability,
    input.modifiers.join(' '),
  ];
  return hasher.h64ToString(parts.join(' '));
}
