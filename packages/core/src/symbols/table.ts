/**
 * The global symbol table — Phase 1's deliverable.
 *
 * Everything Phase 2 needs to turn names into edges: every declaration in the
 * project keyed by stable ID, plus the per-file scope that says which names a
 * given file can see. Nothing here resolves a call; resolution is Phase 2 and
 * it reads this.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * - **Names are ambiguous and that is recorded, not resolved.**
 *   `contractsByName` maps to an *array*. The `pathological/` fixture has two
 *   contracts called `Duplicate`; a table keyed by bare name silently drops
 *   one and the graph is then wrong in a way nothing catches.
 * - **Solidity version is per-file.** §4 puts the supported band at 0.8.x with
 *   0.5–0.7 best-effort, so each file carries its own pragma and its own
 *   support verdict, and files outside the band are excluded from the
 *   resolution score rather than excluded from the graph.
 */

import type {
  ContractKind,
  FunctionSubkind,
  ParsedParam,
  StateMutability,
  Visibility,
} from '../parse/interface.js';
import type { SourceRef } from '../parse/positions.js';
import type { ResolvedImport } from '../project/imports.js';
import type { NodeId } from './ids.js';

export type SymbolKind =
  | 'contract'
  | 'function'
  | 'modifier'
  | 'stateVariable'
  | 'event'
  | 'error'
  | 'struct'
  | 'enum'
  | 'userDefinedValueType';

export interface SymbolBase {
  id: NodeId;
  kind: SymbolKind;
  name: string;
  file: string;
  /** Containing contract's ID, or null for a file-level declaration. */
  scope: NodeId | null;
  src: SourceRef;
}

export interface ContractSymbol extends SymbolBase {
  kind: 'contract';
  contractKind: ContractKind;
  /** Base names as written, in declaration order. Unresolved — Phase 2's job. */
  baseNames: string[];
  members: NodeId[];
  /** `using L for T` directives, needed for library-call resolution. */
  usingFor: { libraryName: string | null; functions: string[]; typeName: string | null }[];
  /** §10: inherits `Test`/`DSTest`, or lives under a test directory. */
  isTest: boolean;
  isMock: boolean;
}

export interface FunctionSymbol extends SymbolBase {
  kind: 'function' | 'modifier';
  subkind: FunctionSubkind;
  visibility: Visibility;
  stateMutability: StateMutability;
  isVirtual: boolean;
  isOverride: boolean;
  overrides: string[];
  modifierNames: string[];
  params: ParsedParam[];
  returns: ParsedParam[];
  hasBody: boolean;
  body: SourceRef | null;
}

export interface StateVariableSymbol extends SymbolBase {
  kind: 'stateVariable';
  typeName: string;
  visibility: Visibility;
  isConstant: boolean;
  isImmutable: boolean;
  isTransient: boolean;
  isMapping: boolean;
}

export interface EventSymbol extends SymbolBase {
  kind: 'event';
  params: ParsedParam[];
  isAnonymous: boolean;
}

export interface ErrorSymbol extends SymbolBase {
  kind: 'error';
  params: ParsedParam[];
}

export interface TypeSymbol extends SymbolBase {
  kind: 'struct' | 'enum' | 'userDefinedValueType';
}

export type AnySymbol =
  | ContractSymbol
  | FunctionSymbol
  | StateVariableSymbol
  | EventSymbol
  | ErrorSymbol
  | TypeSymbol;

/** §4's version policy, decided per file from its own pragma. */
export type VersionSupport = 'supported' | 'best-effort' | 'unsupported' | 'unknown';

export interface FileSymbols {
  file: string;
  /** Raw pragma text, first `pragma solidity` directive found. */
  pragma: string | null;
  versionSupport: VersionSupport;
  /** IDs declared directly in this file, at any scope. */
  declarations: NodeId[];
  /** Top-level names this file declares, for import resolution. */
  exports: Map<string, NodeId>;
  /**
   * Names visible in this file through imports, mapped to the file they came
   * from. `import {X as Y}` binds `Y`; §4 flags aliasing as fiddly, so the
   * local name is always the key.
   */
  imported: Map<string, { fromFile: string; originalName: string }>;
  /** Files this one imports, resolved where possible. */
  imports: ResolvedImport[];
  /** True when the parse recovered from at least one error. */
  recovered: boolean;
  diagnosticCount: number;
}

export interface SymbolTableStats {
  files: number;
  parsedFiles: number;
  filesWithErrors: number;
  contracts: number;
  interfaces: number;
  libraries: number;
  abstractContracts: number;
  functions: number;
  modifiers: number;
  stateVariables: number;
  events: number;
  errors: number;
  structs: number;
  enums: number;
  userDefinedValueTypes: number;
  unresolvedImports: number;
  /** Files whose pragma sits outside the tested 0.8.x band (§4). */
  bestEffortFiles: number;
  unsupportedFiles: number;
}

export interface SymbolTable {
  root: string;
  files: Map<string, FileSymbols>;
  symbols: Map<NodeId, AnySymbol>;
  /** Every declaration sharing a name. Multiple entries is data, not an error. */
  byName: Map<string, NodeId[]>;
  /** Contracts only, the common lookup during resolution. */
  contractsByName: Map<string, NodeId[]>;
  unresolvedImports: ResolvedImport[];
  diagnostics: { message: string; severity: 'error' | 'warning' | 'info' }[];
  stats: SymbolTableStats;
}

export function symbolsOfKind<K extends SymbolKind>(
  table: SymbolTable,
  kind: K,
): Extract<AnySymbol, { kind: K }>[] {
  const out: Extract<AnySymbol, { kind: K }>[] = [];
  for (const symbol of table.symbols.values()) {
    if (symbol.kind === kind) out.push(symbol as Extract<AnySymbol, { kind: K }>);
  }
  return out;
}

export function lookupContracts(table: SymbolTable, name: string): ContractSymbol[] {
  const ids = table.contractsByName.get(name) ?? [];
  const out: ContractSymbol[] = [];
  for (const id of ids) {
    const symbol = table.symbols.get(id);
    if (symbol !== undefined && symbol.kind === 'contract') out.push(symbol);
  }
  return out;
}
