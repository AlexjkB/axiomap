/**
 * Stable node IDs (§8).
 *
 * §8 fixes three forms and the rest follow the same grammar:
 *
 *     <file>:<scope><sigil><name><signature?>
 *
 * `scope` is the containing contract, or empty for a file-level declaration.
 * The sigil separates namespaces that would otherwise collide — a function and
 * an event may share a name and an argument list, and `#` for modifiers is
 * §8's own choice, so the others follow its lead rather than inventing a
 * different scheme:
 *
 * | Sigil | Namespace                          | Example                                  |
 * |-------|------------------------------------|------------------------------------------|
 * | `.`   | functions, state variables         | `src/Vault.sol:Vault.deposit(uint256)`   |
 * | `#`   | modifiers                          | `src/Vault.sol:Vault#onlyOwner`          |
 * | `^`   | events                             | `src/Vault.sol:Vault^Swept(address)`     |
 * | `!`   | errors                             | `src/Vault.sol:Vault!TooLarge(uint256)`  |
 * | `~`   | structs, enums, value types        | `src/Types.sol:~Deposit`                 |
 *
 * These are stable across recompiles and deliberately **not** stable across
 * renames or moves — Phase 5's matching layer exists precisely to recover
 * those, and an ID that survived a rename would hide the change instead of
 * reporting it.
 *
 * Signatures use **declared type text**, normalised for whitespace. A truly
 * canonical signature needs type resolution (contract types collapse to
 * `address`, enums to `uint8`), which is the semantic tier's job in Phase 3.
 * Declared text is stable, cheap, and correct for the overwhelming majority of
 * real signatures; where it is not, Phase 3 refines it.
 */

import type { ParsedParam } from '../parse/interface.js';

export type NodeId = string;

export function normaliseTypeName(typeName: string): string {
  return typeName.replace(/\s+/g, ' ').replace(/\s*([(),[\]])\s*/g, '$1').trim();
}

export function signatureOf(params: readonly ParsedParam[]): string {
  return `(${params.map((p) => normaliseTypeName(p.typeName)).join(',')})`;
}

export function contractId(file: string, name: string): NodeId {
  return `${file}:${name}`;
}

/**
 * A file-level declaration has no containing contract, so it also drops the
 * `.` that would otherwise separate one — `src/Types.sol:scale(uint256)`, not
 * `src/Types.sol:.scale(uint256)`. Solidity forbids two file-level
 * declarations sharing a name, so nothing collides.
 */
function dotted(file: string, scope: string | null, tail: string): NodeId {
  return scope === null || scope === '' ? `${file}:${tail}` : `${file}:${scope}.${tail}`;
}

export function functionId(
  file: string,
  scope: string | null,
  name: string,
  params: readonly ParsedParam[],
): NodeId {
  return dotted(file, scope, `${name}${signatureOf(params)}`);
}

export function modifierId(file: string, scope: string | null, name: string): NodeId {
  return `${file}:${scope ?? ''}#${name}`;
}

export function stateVariableId(file: string, scope: string | null, name: string): NodeId {
  return dotted(file, scope, name);
}

export function eventId(
  file: string,
  scope: string | null,
  name: string,
  params: readonly ParsedParam[],
): NodeId {
  return `${file}:${scope ?? ''}^${name}${signatureOf(params)}`;
}

export function errorId(
  file: string,
  scope: string | null,
  name: string,
  params: readonly ParsedParam[],
): NodeId {
  return `${file}:${scope ?? ''}!${name}${signatureOf(params)}`;
}

export function typeId(file: string, scope: string | null, name: string): NodeId {
  return `${file}:${scope ?? ''}~${name}`;
}
