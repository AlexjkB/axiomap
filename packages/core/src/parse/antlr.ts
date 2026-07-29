/**
 * Backend A — `@solidity-parser/parser` (ANTLR-generated, version-agnostic
 * grammar, `tolerant: true` error recovery).
 *
 * Benchmarked against `treesitter.ts` in Phase 1; see
 * `docs/decisions/0001-parser.md`.
 *
 * Two things about this library that the code below depends on and that are
 * not obvious from its README:
 *
 * 1. `range` is `[start, endInclusive]`, not half-open. Every conversion here
 *    adds 1 to the end.
 * 2. `loc.end` is unreliable — on many nodes `loc.end.column` equals
 *    `loc.start.column`. We ignore `loc` entirely and derive line/column from
 *    `range[0]` via `PositionIndex`, which also makes both backends produce
 *    byte-identical `SourceRef`s.
 */

import * as solidityParser from '@solidity-parser/parser';

import {
  emptyUnit,
  type ContractKind,
  type FunctionSubkind,
  type ParsedContract,
  type ParsedEnum,
  type ParsedError,
  type ParsedEvent,
  type ParsedFunction,
  type ParsedImport,
  type ParsedImportSymbol,
  type ParsedModifierInvocation,
  type ParsedParam,
  type ParsedSourceUnit,
  type ParsedStateVariable,
  type ParsedStruct,
  type ParsedUserDefinedValueType,
  type ParsedUsingFor,
  type ParseDiagnostic,
  type ParseResult,
  type ParserId,
  type SolidityParser,
  type StateMutability,
  type Visibility,
} from './interface.js';
import { PositionIndex, type SourceRef } from './positions.js';

/** The library is untyped enough in places that `unknown` + narrowing is the
 * honest representation. Code conventions forbid `any`. */
type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null;
}

function nodes(value: unknown): Node[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function rangeOf(node: Node): [number, number] | null {
  const range = node['range'];
  if (!Array.isArray(range) || range.length < 2) return null;
  const [start, endInclusive] = range;
  if (typeof start !== 'number' || typeof endInclusive !== 'number') return null;
  // Inclusive → half-open.
  return [start, endInclusive + 1];
}

class AntlrConverter {
  readonly #positions: PositionIndex;
  readonly #text: string;

  constructor(positions: PositionIndex, text: string) {
    this.#positions = positions;
    this.#text = text;
  }

  ref(node: Node): SourceRef {
    const range = rangeOf(node);
    if (range === null) return this.#positions.ref(0, 0);
    return this.#positions.ref(range[0], range[1]);
  }

  /** Source text of a node — used for type names, which stay unresolved text. */
  text(node: unknown): string {
    if (!isNode(node)) return '';
    const range = rangeOf(node);
    if (range === null) return '';
    return this.#text.slice(range[0], range[1]).trim();
  }

  param(node: Node): ParsedParam {
    const storage = str(node['storageLocation']);
    return {
      name: str(node['name']),
      typeName: this.text(node['typeName']),
      storageLocation:
        storage === 'memory' || storage === 'storage' || storage === 'calldata'
          ? storage
          : null,
      indexed: node['isIndexed'] === true,
      src: this.ref(node),
    };
  }

  params(value: unknown): ParsedParam[] {
    return nodes(value).map((n) => this.param(n));
  }

  functionDef(node: Node): ParsedFunction {
    const subkind = functionSubkind(node);
    const override = node['override'];
    const body = isNode(node['body']) ? this.ref(node['body']) : null;

    const modifiers: ParsedModifierInvocation[] = nodes(node['modifiers']).flatMap((m) => {
      const name = str(m['name']);
      return name === null ? [] : [{ name, src: this.ref(m) }];
    });

    return {
      name: subkind === 'function' || subkind === 'modifier' ? str(node['name']) : null,
      subkind,
      visibility: visibilityOf(str(node['visibility'])),
      stateMutability: mutabilityOf(str(node['stateMutability'])),
      isVirtual: node['isVirtual'] === true,
      isOverride: override !== null && override !== undefined,
      overrides: nodes(override).flatMap((o) => {
        const path = str(o['namePath']);
        return path === null ? [] : [path];
      }),
      modifiers,
      params: this.params(node['parameters']),
      returns: this.params(node['returnParameters']),
      hasBody: body !== null,
      body,
      src: this.ref(node),
    };
  }

  stateVariable(declaration: Node): ParsedStateVariable[] {
    return nodes(declaration['variables']).flatMap((v) => {
      const name = str(v['name']);
      if (name === null) return [];
      const typeName = v['typeName'];
      return [
        {
          name,
          typeName: this.text(typeName),
          visibility: visibilityOf(str(v['visibility'])),
          isConstant: v['isDeclaredConst'] === true,
          isImmutable: v['isImmutable'] === true,
          isTransient: v['isTransient'] === true,
          isMapping: isNode(typeName) && typeName['type'] === 'Mapping',
          // Single declarations carry the initialiser on the variable; a
          // tuple declaration carries it once on the statement.
          hasInitializer: isNode(v['expression']) || isNode(declaration['initialValue']),
          src: this.ref(v),
        },
      ];
    });
  }

  fileLevelConstant(node: Node): ParsedStateVariable | null {
    const name = str(node['name']);
    if (name === null) return null;
    return {
      name,
      typeName: this.text(node['typeName']),
      visibility: 'default',
      isConstant: node['isDeclaredConst'] === true,
      isImmutable: node['isImmutable'] === true,
      isTransient: false,
      isMapping: false,
      hasInitializer: isNode(node['initialValue']),
      src: this.ref(node),
    };
  }

  event(node: Node): ParsedEvent | null {
    const name = str(node['name']);
    if (name === null) return null;
    return {
      name,
      params: this.params(node['parameters']),
      isAnonymous: node['isAnonymous'] === true,
      src: this.ref(node),
    };
  }

  error(node: Node): ParsedError | null {
    const name = str(node['name']);
    if (name === null) return null;
    return { name, params: this.params(node['parameters']), src: this.ref(node) };
  }

  struct(node: Node): ParsedStruct | null {
    const name = str(node['name']);
    if (name === null) return null;
    return { name, members: this.params(node['members']), src: this.ref(node) };
  }

  enum(node: Node): ParsedEnum | null {
    const name = str(node['name']);
    if (name === null) return null;
    return {
      name,
      members: nodes(node['members']).flatMap((m) => {
        const memberName = str(m['name']);
        return memberName === null ? [] : [memberName];
      }),
      src: this.ref(node),
    };
  }

  userDefinedValueType(node: Node): ParsedUserDefinedValueType | null {
    const name = str(node['name']);
    if (name === null) return null;
    return { name, underlying: this.text(node['definition']), src: this.ref(node) };
  }

  usingFor(node: Node): ParsedUsingFor {
    return {
      libraryName: str(node['libraryName']),
      functions: Array.isArray(node['functions'])
        ? node['functions'].filter((f): f is string => typeof f === 'string')
        : [],
      // `using L for *` has no typeName.
      typeName: isNode(node['typeName']) ? this.text(node['typeName']) : null,
      isGlobal: node['isGlobal'] === true,
      src: this.ref(node),
    };
  }

  contract(node: Node): ParsedContract | null {
    const name = str(node['name']);
    if (name === null) return null;

    const contract: ParsedContract = {
      name,
      kind: contractKindOf(str(node['kind'])),
      bases: nodes(node['baseContracts']).flatMap((b) => {
        const baseName = isNode(b['baseName']) ? str(b['baseName']['namePath']) : null;
        return baseName === null ? [] : [{ name: baseName, src: this.ref(b) }];
      }),
      functions: [],
      stateVariables: [],
      events: [],
      errors: [],
      structs: [],
      enums: [],
      userDefinedValueTypes: [],
      usingFor: [],
      src: this.ref(node),
    };

    for (const sub of nodes(node['subNodes'])) {
      switch (sub['type']) {
        case 'FunctionDefinition':
        case 'ModifierDefinition':
          contract.functions.push(this.functionDef(sub));
          break;
        case 'StateVariableDeclaration':
          contract.stateVariables.push(...this.stateVariable(sub));
          break;
        case 'EventDefinition':
          pushIf(contract.events, this.event(sub));
          break;
        case 'CustomErrorDefinition':
          pushIf(contract.errors, this.error(sub));
          break;
        case 'StructDefinition':
          pushIf(contract.structs, this.struct(sub));
          break;
        case 'EnumDefinition':
          pushIf(contract.enums, this.enum(sub));
          break;
        case 'TypeDefinition':
          pushIf(contract.userDefinedValueTypes, this.userDefinedValueType(sub));
          break;
        case 'UsingForDeclaration':
          contract.usingFor.push(this.usingFor(sub));
          break;
        default:
          break;
      }
    }

    return contract;
  }

  import(node: Node): ParsedImport | null {
    const path = str(node['path']);
    if (path === null) return null;

    const symbols: ParsedImportSymbol[] = [];
    const aliases = node['symbolAliases'];
    if (Array.isArray(aliases)) {
      for (const entry of aliases) {
        if (!Array.isArray(entry)) continue;
        const name = str(entry[0]);
        if (name === null) continue;
        symbols.push({ name, alias: str(entry[1]) });
      }
    }

    return { path, symbols, unitAlias: str(node['unitAlias']), src: this.ref(node) };
  }
}

function pushIf<T>(target: T[], value: T | null): void {
  if (value !== null) target.push(value);
}

function functionSubkind(node: Node): FunctionSubkind {
  if (node['type'] === 'ModifierDefinition') return 'modifier';
  if (node['isConstructor'] === true) return 'constructor';
  if (node['isFallback'] === true) return 'fallback';
  if (node['isReceiveEther'] === true) return 'receive';
  return 'function';
}

function visibilityOf(value: string | null): Visibility {
  switch (value) {
    case 'public':
    case 'external':
    case 'internal':
    case 'private':
      return value;
    default:
      return 'default';
  }
}

function mutabilityOf(value: string | null): StateMutability {
  switch (value) {
    case 'pure':
    case 'view':
    case 'payable':
      return value;
    case 'constant':
      // Pre-0.5 spelling of `view`. §4 keeps 0.5+ best-effort.
      return 'view';
    default:
      return 'nonpayable';
  }
}

function contractKindOf(value: string | null): ContractKind {
  switch (value) {
    case 'interface':
    case 'library':
    case 'abstract':
      return value;
    default:
      return 'contract';
  }
}

export class AntlrSolidityParser implements SolidityParser {
  readonly id: ParserId = 'antlr';

  parse(file: string, text: string): ParseResult {
    const positions = new PositionIndex(file, text);
    const diagnostics: ParseDiagnostic[] = [];

    let ast: Node | null = null;
    try {
      ast = solidityParser.parse(text, {
        range: true,
        tolerant: true,
      }) as unknown as Node;
    } catch (error) {
      // Tolerant mode still throws on input it cannot even tokenise. Decision
      // #1 says that is a diagnostic, not a failure.
      diagnostics.push({
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
        src: null,
      });
      return { unit: emptyUnit(file), diagnostics, recovered: true };
    }

    const converter = new AntlrConverter(positions, text);

    for (const parseError of nodes(ast['errors'])) {
      const message = str(parseError['message']) ?? 'parse error';
      const line = parseError['line'];
      const column = parseError['column'];
      diagnostics.push({
        message,
        severity: 'error',
        src:
          typeof line === 'number' && typeof column === 'number'
            ? { file, offset: 0, length: 0, line, column }
            : null,
      });
    }

    const unit: ParsedSourceUnit = emptyUnit(file);

    for (const child of nodes(ast['children'])) {
      switch (child['type']) {
        case 'PragmaDirective':
          unit.pragmas.push({
            raw: converter.text(child),
            src: converter.ref(child),
          });
          break;
        case 'ImportDirective':
          pushIf(unit.imports, converter.import(child));
          break;
        case 'ContractDefinition':
          pushIf(unit.contracts, converter.contract(child));
          break;
        case 'FunctionDefinition':
          unit.functions.push(converter.functionDef(child));
          break;
        case 'FileLevelConstant':
          pushIf(unit.constants, converter.fileLevelConstant(child));
          break;
        case 'StructDefinition':
          pushIf(unit.structs, converter.struct(child));
          break;
        case 'EnumDefinition':
          pushIf(unit.enums, converter.enum(child));
          break;
        case 'CustomErrorDefinition':
          pushIf(unit.errors, converter.error(child));
          break;
        case 'TypeDefinition':
          pushIf(unit.userDefinedValueTypes, converter.userDefinedValueType(child));
          break;
        default:
          break;
      }
    }

    return { unit, diagnostics, recovered: diagnostics.length > 0 };
  }
}
