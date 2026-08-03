/**
 * `SolidityParser` — the swap seam (§5).
 *
 * Two backends implemented this during Phase 1's bake-off; tree-sitter won and
 * the other was deleted. The interface stays so a future backend — Solar when
 * it ships JS bindings, or `web-tree-sitter` for packaging — is a new file
 * rather than a refactor.
 *
 * The shape below is a **declaration-level** view: everything a global symbol
 * table needs, and nothing more. Expression-level detail — call sites, state
 * reads and writes, the `flags` block in §10 — is deliberately not here. It is
 * only needed by heuristic resolution in Phase 2, by which point one backend
 * has already won, so building it twice would be paying the bake-off cost
 * twice for no extra information. Phase 2 extends this interface additively;
 * §16 records the deferral.
 *
 * Rules every implementation must hold to:
 *
 * - **`parse` never throws.** A file that does not parse yields whatever was
 *   recovered plus diagnostics. Decision #1 is the whole product.
 * - **Positions are `SourceRef`s built through `PositionIndex`**, so both
 *   backends produce byte offsets that agree to the byte.
 * - **No normalisation of names.** `IERC20` stays `IERC20`. Resolution is
 *   Phase 2's job and it needs the raw text.
 */

import type { SourceRef } from './positions.js';

/**
 * One member today. Kept as a union because it is the cache key discriminator
 * and because §16 names two candidate future backends.
 */
export type ParserId = 'treesitter';

export type ContractKind = 'contract' | 'interface' | 'library' | 'abstract';

export type Visibility = 'public' | 'external' | 'internal' | 'private' | 'default';

export type StateMutability = 'pure' | 'view' | 'nonpayable' | 'payable';

export type FunctionSubkind =
  | 'function'
  | 'constructor'
  | 'fallback'
  | 'receive'
  | 'modifier';

export interface ParsedParam {
  /** Anonymous parameters are legal and common in overrides. */
  name: string | null;
  /** Source text of the type, not a resolved type. `IERC20`, `uint256[]`. */
  typeName: string;
  storageLocation: 'memory' | 'storage' | 'calldata' | null;
  /** Events only. */
  indexed: boolean;
  src: SourceRef;
}

export interface ParsedModifierInvocation {
  name: string;
  src: SourceRef;
}

export interface ParsedFunction {
  /** `null` for constructor, fallback and receive. */
  name: string | null;
  subkind: FunctionSubkind;
  visibility: Visibility;
  stateMutability: StateMutability;
  isVirtual: boolean;
  isOverride: boolean;
  /** Base names from an explicit `override(A, B)`. Empty for a bare override. */
  overrides: string[];
  modifiers: ParsedModifierInvocation[];
  params: ParsedParam[];
  returns: ParsedParam[];
  /** False for an unimplemented function in an interface or abstract contract. */
  hasBody: boolean;
  /** Range of the body braces. Phase 2 walks this; Phase 2 also hashes it. */
  body: SourceRef | null;
  src: SourceRef;
}

export interface ParsedStateVariable {
  name: string;
  typeName: string;
  visibility: Visibility;
  isConstant: boolean;
  isImmutable: boolean;
  isTransient: boolean;
  isMapping: boolean;
  hasInitializer: boolean;
  src: SourceRef;
}

export interface ParsedEvent {
  name: string;
  params: ParsedParam[];
  isAnonymous: boolean;
  src: SourceRef;
}

export interface ParsedError {
  name: string;
  params: ParsedParam[];
  src: SourceRef;
}

export interface ParsedStruct {
  name: string;
  members: ParsedParam[];
  src: SourceRef;
}

export interface ParsedEnum {
  name: string;
  members: string[];
  src: SourceRef;
}

export interface ParsedUserDefinedValueType {
  name: string;
  underlying: string;
  src: SourceRef;
}

export interface ParsedUsingFor {
  /** `using SafeERC20 for IERC20` → `SafeERC20`. Null for `using {f, g} for T`. */
  libraryName: string | null;
  /** `using {add, sub} for uint256` → the free function names. */
  functions: string[];
  /** `null` means `using L for *`. */
  typeName: string | null;
  isGlobal: boolean;
  src: SourceRef;
}

export interface ParsedInheritance {
  name: string;
  src: SourceRef;
}

export interface ParsedContract {
  name: string;
  kind: ContractKind;
  /** In declaration order. C3 linearization in Phase 4 depends on this order. */
  bases: ParsedInheritance[];
  functions: ParsedFunction[];
  stateVariables: ParsedStateVariable[];
  events: ParsedEvent[];
  errors: ParsedError[];
  structs: ParsedStruct[];
  enums: ParsedEnum[];
  userDefinedValueTypes: ParsedUserDefinedValueType[];
  usingFor: ParsedUsingFor[];
  src: SourceRef;
}

export interface ParsedImportSymbol {
  name: string;
  /** `import {X as Y}` → alias `Y`. §4 calls this out as fiddly; it is tested. */
  alias: string | null;
}

export interface ParsedImport {
  /** The literal string, unresolved. `project/imports.ts` resolves it. */
  path: string;
  symbols: ParsedImportSymbol[];
  /** `import * as L from` / `import L from` → `L`. */
  unitAlias: string | null;
  src: SourceRef;
}

export interface ParsedPragma {
  /** Full directive text, e.g. `pragma solidity ^0.8.20;`. */
  raw: string;
  src: SourceRef;
}

export interface ParsedSourceUnit {
  file: string;
  pragmas: ParsedPragma[];
  imports: ParsedImport[];
  contracts: ParsedContract[];
  /** File-level free functions. */
  functions: ParsedFunction[];
  /** File-level constants. */
  constants: ParsedStateVariable[];
  structs: ParsedStruct[];
  enums: ParsedEnum[];
  errors: ParsedError[];
  userDefinedValueTypes: ParsedUserDefinedValueType[];
}

export interface ParseDiagnostic {
  message: string;
  severity: 'error' | 'warning';
  src: SourceRef | null;
}

export interface ParseResult {
  unit: ParsedSourceUnit;
  diagnostics: ParseDiagnostic[];
  /**
   * True when the parse hit at least one error but still produced a unit.
   * `unit` is always present; `recovered` says whether to trust it fully.
   */
  recovered: boolean;
}

export interface SolidityParser {
  readonly id: ParserId;
  /**
   * @param file Repo-relative path, used verbatim in every `SourceRef`.
   * @param text Decoded file contents.
   */
  parse(file: string, text: string): ParseResult;
}

/** An empty unit, for backends that recovered nothing at all. */
export function emptyUnit(file: string): ParsedSourceUnit {
  return {
    file,
    pragmas: [],
    imports: [],
    contracts: [],
    functions: [],
    constants: [],
    structs: [],
    enums: [],
    errors: [],
    userDefinedValueTypes: [],
  };
}
