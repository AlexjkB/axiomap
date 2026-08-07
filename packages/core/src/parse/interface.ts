/**
 * `SolidityParser` — the swap seam (§5).
 *
 * Two backends implemented this during Phase 1's bake-off; tree-sitter won and
 * the other was deleted. The interface stays so a future backend — Solar when
 * it ships JS bindings, or `web-tree-sitter` for packaging — is a new file
 * rather than a refactor.
 *
 * Phase 1 kept this to a **declaration-level** view, because building
 * expression detail twice would have paid the bake-off cost twice. Phase 2
 * extended it additively, as planned: `ParsedFunction` now also carries its
 * call sites, identifier uses, emits, reverts, locals, flags, metrics and the
 * two hashes §8 needs. Nothing declaration-level changed shape.
 *
 * The expression-level types stay **syntactic**. A call site records what was
 * written — a bare name, a member on an identifier, a cast, `super.` — and
 * never what it resolves to. Resolution reads the symbol table and lives in
 * `resolve/`, which is what lets the same parse output feed both the heuristic
 * tier and Phase 3's semantic upgrade.
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

/**
 * How a call was written. The resolver keys off this before it looks at any
 * name, because the shape alone decides which scopes are even candidates.
 */
export type CallShape =
  /** `f(...)` — current contract, then bases, then file scope. */
  | 'bare'
  /** `recv.m(...)` where `recv` is a plain identifier. */
  | 'member'
  /** `T(expr).m(...)` — the cast names the type outright. */
  | 'cast'
  /** `super.m(...)` — needs the linearization. */
  | 'super'
  /** `this.m(...)` — own external entrypoint. */
  | 'this'
  /** `new T(...)` — a `creates` edge, not a `calls` edge. */
  | 'new'
  /** `f()(...)`, `arr[i].m(...)`, anything whose receiver is an expression. */
  | 'expression';

export interface ParsedCall {
  shape: CallShape;
  /**
   * The name being called: `f` for a bare call, the member for everything
   * with a receiver, the type for `new T`.
   */
  name: string;
  /** `recv` for `shape: 'member'`, the type for `'cast'`, else null. */
  receiver: string | null;
  argCount: number;
  /** `{value: ...}` was present. Also sets `sendsValue`. */
  hasValueOption: boolean;
  /** `{salt: ...}` — create2. */
  hasSaltOption: boolean;
  /** Whole call expression. §10: an edge's `src` is the **call site**. */
  src: SourceRef;
}

/**
 * One use of an identifier in a function body, already classified as a read or
 * a write. Which declaration it refers to is the resolver's problem; the
 * parser only reports that the name appeared and how.
 *
 * `write` covers assignment, compound assignment, `++`/`--`, `delete`, and
 * `.push`/`.pop` on the identifier. A compound assignment is recorded twice,
 * once each way, because `x += 1` genuinely both reads and writes.
 */
export interface ParsedIdentifierUse {
  name: string;
  write: boolean;
  src: SourceRef;
}

/** `emit E(...)` and `revert Err(...)` — a name and where it was written. */
export interface ParsedNameRef {
  name: string;
  src: SourceRef;
}

/**
 * A local declaration, including parameters and named returns.
 *
 * Two jobs, both load-bearing. Declared types are what makes `f.bar()`
 * resolvable without a compiler (§4), and the same list is what stops a local
 * that shadows a state variable from producing a bogus `reads` edge —
 * `inheritance/src/Shadowing.sol` exists to catch exactly that.
 */
export interface ParsedLocal {
  name: string;
  /** Source text of the declared type. */
  typeName: string;
  src: SourceRef;
}

/**
 * §10's `flags`, minus `readsState`/`writesState` — those are derived from
 * resolved edges and so belong to the graph, not the parse.
 *
 * The two `assembly*` fields are not in §10's list. They exist because a `sload`
 * or `sstore` inside an `assembly` block touches storage without naming a
 * variable the resolver could bind, and without them a proxy's `fallback` would
 * report `writesState: false` — wrong in exactly the file where it matters
 * most. The graph ORs them into §10's two booleans; nothing else reads them.
 *
 * `checksSender` is not in §10's list either, and is the one syntactic fact
 * Phase 4's access-control pass cannot derive from the graph. §11 requires
 * `low` confidence "when the guard is an inline `require` rather than a
 * modifier", but the resolver drops `require` as a language builtin (there is
 * nothing to bind it to), so no edge records that a comparison against
 * `msg.sender` happened. Recording it here — the same shape as the two
 * `assembly*` fields — keeps the analysis pass a pure function over the graph.
 */
export interface ParsedFunctionFlags {
  hasAssembly: boolean;
  hasDelegatecall: boolean;
  hasLowLevelCall: boolean;
  hasSelfdestruct: boolean;
  hasCreate: boolean;
  sendsValue: boolean;
  hasUnchecked: boolean;
  hasTryCatch: boolean;
  assemblyReadsState: boolean;
  assemblyWritesState: boolean;
  /**
   * `msg.sender` or `tx.origin` appears as an operand of `==` or `!=` somewhere
   * in the body. Evidence of an authorization check, not proof of one: the
   * comparison may guard nothing, which is exactly why it produces `low`
   * confidence rather than `high`.
   */
  checksSender: boolean;
}

export interface ParsedFunctionMetrics {
  /** Distinct body lines carrying a non-comment token. */
  sloc: number;
  /** 1 + branch points, counting `&&`/`||`, ternaries and catch clauses. */
  cyclomatic: number;
  /** Deepest block nesting inside the body; a flat body is 1. */
  maxDepth: number;
}

export function emptyFunctionFlags(): ParsedFunctionFlags {
  return {
    hasAssembly: false,
    hasDelegatecall: false,
    hasLowLevelCall: false,
    hasSelfdestruct: false,
    hasCreate: false,
    sendsValue: false,
    hasUnchecked: false,
    hasTryCatch: false,
    assemblyReadsState: false,
    assemblyWritesState: false,
    checksSender: false,
  };
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
  /** Range of the body braces. */
  body: SourceRef | null;
  src: SourceRef;

  // --- expression level (Phase 2) ---------------------------------------
  calls: ParsedCall[];
  identifiers: ParsedIdentifierUse[];
  emits: ParsedNameRef[];
  reverts: ParsedNameRef[];
  /** Parameters, named returns and body declarations, in that order. */
  locals: ParsedLocal[];
  flags: ParsedFunctionFlags;
  metrics: ParsedFunctionMetrics;
  /**
   * §8. `bodyHash` is over the body's non-comment tokens, so reformatting and
   * comment edits do not invalidate a review; `interfaceHash` is over
   * signature, visibility, mutability and modifier names, so a breaking change
   * is distinguishable from a re-review trigger.
   */
  bodyHash: string;
  interfaceHash: string;
  /**
   * The NatSpec doc comment immediately preceding this declaration, verbatim
   * — comment markers and all, exactly as written. `null` when none is
   * attached. §16's NatSpec entry settles two things this field depends on:
   * `@inheritdoc` is stored as plain text inside it, never resolved here —
   * resolving which base it names is a UI concern, and one that can fail
   * visibly, rather than a derived value baked into a golden file. And
   * verbatim rather than stripped of its `///`/`/**` markers, for the same
   * reason the body walker records what was written and not what it means:
   * `pathological/` already stresses non-ASCII text in comments, and a
   * formatting pass here would be one more place for that to go subtly wrong.
   */
  natspec: string | null;
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
  /** See `ParsedFunction.natspec` — same rule, same reasons. */
  natspec: string | null;
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
