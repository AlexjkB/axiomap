/**
 * The parser backend — `web-tree-sitter` over a vendored `tree-sitter-solidity`
 * grammar.
 *
 * Won the Phase 1 bake-off on error recovery and cold-parse throughput; see
 * `docs/decisions/0001-parser.md`.
 *
 * **WASM rather than the native binding**, which is a packaging decision, not a
 * performance one. The native `tree-sitter` package builds through `node-gyp`
 * at install and needs per-platform prebuilds shipped inside a `.vsix`, and
 * `tree-sitter-solidity` lists `yarn` in its runtime dependencies — which puts
 * `http`/`https`/`net`/`dns` in `@axiomap/core`'s production tree and breaks
 * §3's zero-network invariant. `web-tree-sitter` has neither problem, and the
 * grammar's `.wasm` is 508 KB of MIT-licensed data in `vendor/`. The node API
 * is identical between the two, so everything below this header is unchanged
 * from the native version.
 *
 * Structural notes that the code below depends on:
 *
 * 1. `startIndex`/`endIndex` are **UTF-16 code units** when parsing a JS
 *    string, not bytes, despite tree-sitter being byte-oriented internally.
 *    They go through `PositionIndex`, which is what makes `SourceRef.offset` a
 *    byte offset. `endIndex` is exclusive.
 * 2. Several modifiers are **anonymous tokens**, not named nodes: `abstract`,
 *    `constant`, `anonymous`, `fallback`, `receive`. `virtual`, `immutable`
 *    and `state_location` are named. Anything reading only `namedChildren`
 *    silently loses the anonymous ones, so this file walks `children`.
 * 3. Import forms are flat — `import {A, B as C} from "..."` yields three
 *    sibling identifiers with no grouping. The `{`, `*` and `as` tokens are
 *    the only way to tell `import D from` (unit alias) from `import {D} from`
 *    (symbol), so imports are reconstructed by walking tokens in order.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Language, Parser, type Node } from 'web-tree-sitter';

import { hashBody, hashInterface } from '../graph/hash.js';
import { getHasher, type Hasher } from './cache.js';
import { analyseBody } from './treesitter-bodies.js';
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

type TsNode = Node;

/**
 * The grammar, resolved relative to this module.
 *
 * `src/parse/` and `dist/parse/` sit at the same depth under the package root,
 * so one relative path works for the built CLI, for vitest running TypeScript
 * straight from source, and for anything importing the package — no build-time
 * copy step, and nothing to keep in sync. `vendor/` is listed in the package's
 * `files`, so it ships. Bundling it into a `.vsix` is Phase 8's problem, but
 * the path stays valid as long as `vendor/` sits beside `dist/`.
 */
const GRAMMAR_WASM = new URL('../../vendor/tree-sitter-solidity.wasm', import.meta.url);

/**
 * `Parser.init()` loads the tree-sitter runtime and `Language.load` compiles
 * the grammar; both are async and both are process-wide. Memoised on the
 * promise rather than the result so concurrent callers share one load — each
 * worker thread pays this once, and the test suite pays it once per process
 * instead of once per `createParser`.
 */
let languagePromise: Promise<Language> | null = null;

export async function loadSolidityLanguage(): Promise<Language> {
  languagePromise ??= (async () => {
    await Parser.init();
    return Language.load(fs.readFileSync(fileURLToPath(GRAMMAR_WASM)));
  })();
  return languagePromise;
}

const STORAGE_LOCATIONS = new Set(['memory', 'storage', 'calldata']);
const VISIBILITIES = new Set(['public', 'external', 'internal', 'private']);
const MUTABILITIES = new Set(['pure', 'view', 'payable', 'constant']);

/** First anonymous token whose text is one of `words`. */
function anonymousKeyword(node: TsNode, words: ReadonlySet<string>): TsNode | null {
  return node.children.find((c) => !c.isNamed && words.has(c.type)) ?? null;
}

function childrenOfType(node: TsNode, type: string): TsNode[] {
  return node.children.filter((c) => c.type === type);
}

function firstOfType(node: TsNode, type: string): TsNode | null {
  return node.children.find((c) => c.type === type) ?? null;
}

function hasToken(node: TsNode, token: string): boolean {
  return node.children.some((c) => !c.isNamed && c.type === token);
}

function identifierText(node: TsNode | null): string | null {
  return node === null ? null : node.text;
}

class TreeSitterConverter {
  readonly #positions: PositionIndex;
  readonly #hasher: Hasher;

  constructor(positions: PositionIndex, hasher: Hasher) {
    this.#positions = positions;
    this.#hasher = hasher;
  }

  ref(node: TsNode): SourceRef {
    // tree-sitter's endIndex is already exclusive.
    return this.#positions.ref(node.startIndex, node.endIndex);
  }

  #paramFrom(node: TsNode): ParsedParam {
    const type = node.childForFieldName('type') ?? firstOfType(node, 'type_name');
    const nameNode = node.childForFieldName('name') ?? firstOfType(node, 'identifier');

    // On a `parameter` the location is an anonymous `memory`/`calldata`/
    // `storage` token; on a `state_variable_declaration` it is a named
    // `state_location` node. Both spellings have to be read.
    const location = node.children.find(
      (c) =>
        STORAGE_LOCATIONS.has(c.text) && (!c.isNamed || c.type === 'state_location'),
    );
    const locationText = location?.text ?? null;

    return {
      name: identifierText(nameNode),
      typeName: type?.text ?? '',
      storageLocation:
        locationText === 'memory' || locationText === 'storage' || locationText === 'calldata'
          ? locationText
          : null,
      indexed: hasToken(node, 'indexed'),
      // A `struct_member` swallows its terminating `;`; a parameter has none.
      // Trimming it keeps member ranges to the declaration itself.
      src: this.#refWithoutTerminator(node),
    };
  }

  /** Node range excluding a trailing `;`, if the grammar included one. */
  #refWithoutTerminator(node: TsNode): SourceRef {
    const last = node.children[node.children.length - 1];
    if (last !== undefined && last.type === ';') {
      const previous = node.children[node.children.length - 2];
      if (previous !== undefined) {
        return this.#positions.ref(node.startIndex, previous.endIndex);
      }
    }
    return this.ref(node);
  }

  #params(node: TsNode, type: string): ParsedParam[] {
    return childrenOfType(node, type).map((p) => this.#paramFrom(p));
  }

  #returns(node: TsNode): ParsedParam[] {
    const returnType =
      node.childForFieldName('return_type') ?? firstOfType(node, 'return_type_definition');
    return returnType === null ? [] : this.#params(returnType, 'parameter');
  }

  #modifierInvocations(node: TsNode): ParsedModifierInvocation[] {
    return childrenOfType(node, 'modifier_invocation').flatMap((m) => {
      const name = identifierText(firstOfType(m, 'identifier'));
      return name === null ? [] : [{ name, src: this.ref(m) }];
    });
  }

  functionDef(node: TsNode): ParsedFunction {
    const subkind = subkindOf(node);
    const body = firstOfType(node, 'function_body');
    const override = firstOfType(node, 'override_specifier');
    // On a `function_definition` these are named nodes. On a
    // `constructor_definition` they are anonymous keyword tokens — which is
    // how pre-0.7 `constructor() public` is spelled, and §4 keeps 0.5–0.7
    // best-effort rather than ignoring it.
    const visibility = firstOfType(node, 'visibility') ?? anonymousKeyword(node, VISIBILITIES);
    const mutability =
      firstOfType(node, 'state_mutability') ?? anonymousKeyword(node, MUTABILITIES);

    const nameNode =
      subkind === 'function' || subkind === 'modifier'
        ? (node.childForFieldName('name') ?? firstOfType(node, 'identifier'))
        : null;

    const name = identifierText(nameNode);
    const params = this.#params(node, 'parameter');
    const returns = this.#returns(node);
    const modifiers = this.#modifierInvocations(node);
    const visibilityValue = visibilityOf(visibility?.text ?? null);
    const mutabilityValue = mutabilityOf(mutability?.text ?? null);
    const analysis = analyseBody(this.#positions, body, params, returns);

    return {
      name,
      subkind,
      visibility: visibilityValue,
      stateMutability: mutabilityValue,
      isVirtual: firstOfType(node, 'virtual') !== null,
      isOverride: override !== null,
      overrides:
        override === null
          ? []
          : childrenOfType(override, 'user_defined_type').map((t) => t.text),
      modifiers,
      params,
      returns,
      hasBody: body !== null,
      body: body === null ? null : this.ref(body),
      src: this.ref(node),
      calls: analysis.calls,
      identifiers: analysis.identifiers,
      emits: analysis.emits,
      reverts: analysis.reverts,
      locals: analysis.locals,
      flags: analysis.flags,
      metrics: analysis.metrics,
      bodyHash: hashBody(this.#hasher, analysis.tokens),
      interfaceHash: hashInterface(this.#hasher, {
        name: name ?? subkind,
        subkind,
        visibility: visibilityValue,
        stateMutability: mutabilityValue,
        params: params.map((p) => p.typeName),
        returns: returns.map((p) => p.typeName),
        modifiers: modifiers.map((m) => m.name),
      }),
    };
  }

  stateVariable(node: TsNode): ParsedStateVariable | null {
    const nameNode = node.childForFieldName('name') ?? firstOfType(node, 'identifier');
    const name = identifierText(nameNode);
    if (name === null) return null;

    const type = node.childForFieldName('type') ?? firstOfType(node, 'type_name');
    const visibility = firstOfType(node, 'visibility');
    const location = firstOfType(node, 'state_location');

    return {
      name,
      typeName: type?.text ?? '',
      visibility: visibilityOf(visibility?.text ?? null),
      // `constant` is an anonymous token; `immutable` is a named node.
      isConstant: hasToken(node, 'constant'),
      isImmutable: firstOfType(node, 'immutable') !== null,
      isTransient: location?.text === 'transient',
      isMapping: type?.text.startsWith('mapping') === true,
      hasInitializer:
        node.childForFieldName('value') !== null || firstOfType(node, 'expression') !== null,
      src: this.ref(node),
    };
  }

  /** File-level `uint256 constant K = 1;`. */
  fileLevelConstant(node: TsNode): ParsedStateVariable | null {
    const name = identifierText(firstOfType(node, 'identifier'));
    if (name === null) return null;
    const type = node.childForFieldName('type') ?? firstOfType(node, 'type_name');
    return {
      name,
      typeName: type?.text ?? '',
      visibility: 'default',
      isConstant: true,
      isImmutable: false,
      isTransient: false,
      isMapping: false,
      hasInitializer:
        node.childForFieldName('value') !== null || firstOfType(node, 'expression') !== null,
      src: this.ref(node),
    };
  }

  event(node: TsNode): ParsedEvent | null {
    const name = identifierText(node.childForFieldName('name') ?? firstOfType(node, 'identifier'));
    if (name === null) return null;
    return {
      name,
      params: this.#params(node, 'event_parameter'),
      isAnonymous: hasToken(node, 'anonymous'),
      src: this.ref(node),
    };
  }

  error(node: TsNode): ParsedError | null {
    const name = identifierText(node.childForFieldName('name') ?? firstOfType(node, 'identifier'));
    if (name === null) return null;
    return { name, params: this.#params(node, 'error_parameter'), src: this.ref(node) };
  }

  struct(node: TsNode): ParsedStruct | null {
    const name = identifierText(node.childForFieldName('name') ?? firstOfType(node, 'identifier'));
    if (name === null) return null;
    const body = firstOfType(node, 'struct_body');
    return {
      name,
      members: body === null ? [] : this.#params(body, 'struct_member'),
      src: this.ref(node),
    };
  }

  enum(node: TsNode): ParsedEnum | null {
    const name = identifierText(node.childForFieldName('name') ?? firstOfType(node, 'identifier'));
    if (name === null) return null;
    const body = firstOfType(node, 'enum_body');
    return {
      name,
      members: body === null ? [] : childrenOfType(body, 'enum_value').map((v) => v.text),
      src: this.ref(node),
    };
  }

  userDefinedValueType(node: TsNode): ParsedUserDefinedValueType | null {
    const name = identifierText(firstOfType(node, 'identifier'));
    if (name === null) return null;
    const underlying = firstOfType(node, 'primitive_type') ?? firstOfType(node, 'type_name');
    return { name, underlying: underlying?.text ?? '', src: this.ref(node) };
  }

  usingFor(node: TsNode): ParsedUsingFor {
    const alias = firstOfType(node, 'type_alias');
    const target = firstOfType(node, 'type_name');
    return {
      libraryName: alias === null ? null : alias.text,
      functions: childrenOfType(node, 'using_alias').map((u) => u.text),
      // `using L for *` parses the target as `any_source_type`; null means "any".
      typeName: target === null ? null : target.text,
      isGlobal: hasToken(node, 'global'),
      src: this.ref(node),
    };
  }

  contract(node: TsNode): ParsedContract | null {
    const name = identifierText(node.childForFieldName('name') ?? firstOfType(node, 'identifier'));
    if (name === null) return null;

    const contract: ParsedContract = {
      name,
      kind: contractKindOf(node),
      bases: childrenOfType(node, 'inheritance_specifier').flatMap((spec) => {
        const ancestor =
          spec.childForFieldName('ancestor') ?? firstOfType(spec, 'user_defined_type');
        return ancestor === null ? [] : [{ name: ancestor.text, src: this.ref(spec) }];
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

    const body = node.childForFieldName('body') ?? firstOfType(node, 'contract_body');
    if (body === null) return contract;

    for (const member of body.namedChildren) {
      switch (member.type) {
        case 'function_definition':
        case 'modifier_definition':
        case 'constructor_definition':
        case 'fallback_receive_definition':
          contract.functions.push(this.functionDef(member));
          break;
        case 'state_variable_declaration':
          pushIf(contract.stateVariables, this.stateVariable(member));
          break;
        case 'event_definition':
          pushIf(contract.events, this.event(member));
          break;
        case 'error_declaration':
          pushIf(contract.errors, this.error(member));
          break;
        case 'struct_declaration':
          pushIf(contract.structs, this.struct(member));
          break;
        case 'enum_declaration':
          pushIf(contract.enums, this.enum(member));
          break;
        case 'user_defined_type_definition':
          pushIf(contract.userDefinedValueTypes, this.userDefinedValueType(member));
          break;
        case 'using_directive':
          contract.usingFor.push(this.usingFor(member));
          break;
        default:
          break;
      }
    }

    return contract;
  }

  /**
   * Imports are flat in this grammar, so read the tokens in order.
   *
   * `{` opens a symbol list; inside it `as` binds an alias to the previous
   * identifier. Outside a symbol list, a bare identifier or `* as X` is a unit
   * alias. Anything else is a plain `import "path"`.
   */
  import(node: TsNode): ParsedImport | null {
    const source = firstOfType(node, 'string');
    if (source === null) return null;

    const path = source.text.replace(/^["']|["']$/g, '');
    const symbols: ParsedImportSymbol[] = [];
    let unitAlias: string | null = null;

    let inBraces = false;
    let sawStar = false;
    let pendingAs = false;

    for (const child of node.children) {
      if (child.type === '{') {
        inBraces = true;
        continue;
      }
      if (child.type === '}') {
        inBraces = false;
        continue;
      }
      if (child.type === '*') {
        sawStar = true;
        continue;
      }
      if (child.type === 'as') {
        pendingAs = true;
        continue;
      }
      if (child.type !== 'identifier') continue;

      if (pendingAs) {
        pendingAs = false;
        if (inBraces) {
          const last = symbols[symbols.length - 1];
          if (last !== undefined) last.alias = child.text;
        } else {
          unitAlias = child.text;
        }
        continue;
      }

      if (inBraces) symbols.push({ name: child.text, alias: null });
      else if (!sawStar) unitAlias = child.text;
    }

    return { path, symbols, unitAlias, src: this.ref(node) };
  }
}

function pushIf<T>(target: T[], value: T | null): void {
  if (value !== null) target.push(value);
}

function subkindOf(node: TsNode): FunctionSubkind {
  switch (node.type) {
    case 'modifier_definition':
      return 'modifier';
    case 'constructor_definition':
      return 'constructor';
    case 'fallback_receive_definition':
      // The grammar folds both into one node; the leading keyword disambiguates.
      return hasToken(node, 'receive') ? 'receive' : 'fallback';
    default:
      return 'function';
  }
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
      return 'view';
    default:
      return 'nonpayable';
  }
}

function contractKindOf(node: TsNode): ContractKind {
  if (node.type === 'interface_declaration') return 'interface';
  if (node.type === 'library_declaration') return 'library';
  if (hasToken(node, 'abstract')) return 'abstract';
  return 'contract';
}

/** Collect ERROR and MISSING nodes without recursing into clean subtrees. */
function collectDiagnostics(
  node: TsNode,
  converter: TreeSitterConverter,
  out: ParseDiagnostic[],
  limit = 50,
): void {
  if (out.length >= limit) return;
  if (!node.hasError) return;

  if (node.type === 'ERROR') {
    out.push({
      message: `unexpected input: ${JSON.stringify(node.text.slice(0, 60))}`,
      severity: 'error',
      src: converter.ref(node),
    });
    return;
  }
  if (node.isMissing) {
    out.push({
      message: `missing ${node.type}`,
      severity: 'error',
      src: converter.ref(node),
    });
    return;
  }
  for (const child of node.children) collectDiagnostics(child, converter, out, limit);
}

export class TreeSitterSolidityParser implements SolidityParser {
  readonly id: ParserId = 'treesitter';

  readonly #parser: Parser;

  readonly #hasher: Hasher;

  private constructor(parser: Parser, hasher: Hasher) {
    this.#parser = parser;
    this.#hasher = hasher;
  }

  /**
   * Async because the grammar has to be loaded and compiled first, and because
   * §8's body hashes need the xxhash WASM module. Both are memoised
   * process-wide, so a worker thread pays them once. `parse` itself stays
   * synchronous, which is what keeps the pool's inner loop tight.
   */
  static async create(): Promise<TreeSitterSolidityParser> {
    // Order matters: `Parser.init()` runs inside `loadSolidityLanguage`, and
    // the constructor throws if the runtime has not been initialised yet.
    const language = await loadSolidityLanguage();
    const hasher = await getHasher();
    const parser = new Parser();
    parser.setLanguage(language);
    return new TreeSitterSolidityParser(parser, hasher);
  }

  parse(file: string, text: string): ParseResult {
    const positions = new PositionIndex(file, text);
    const diagnostics: ParseDiagnostic[] = [];

    let root: TsNode;
    try {
      const tree = this.#parser.parse(text);
      if (tree === null) {
        // Documented as possible when the parser is cancelled or has no
        // language. Neither should happen here, but decision #1 says a file
        // that cannot be parsed is a diagnostic, never a throw.
        diagnostics.push({
          message: 'parser returned no tree',
          severity: 'error',
          src: null,
        });
        return { unit: emptyUnit(file), diagnostics, recovered: true };
      }
      root = tree.rootNode;
    } catch (error) {
      diagnostics.push({
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
        src: null,
      });
      return { unit: emptyUnit(file), diagnostics, recovered: true };
    }

    const converter = new TreeSitterConverter(positions, this.#hasher);
    if (root.hasError) collectDiagnostics(root, converter, diagnostics);

    const unit: ParsedSourceUnit = emptyUnit(file);

    for (const child of root.namedChildren) {
      switch (child.type) {
        case 'pragma_directive':
          unit.pragmas.push({ raw: child.text, src: converter.ref(child) });
          break;
        case 'import_directive':
          pushIf(unit.imports, converter.import(child));
          break;
        case 'contract_declaration':
        case 'interface_declaration':
        case 'library_declaration':
          pushIf(unit.contracts, converter.contract(child));
          break;
        case 'function_definition':
          unit.functions.push(converter.functionDef(child));
          break;
        case 'constant_variable_declaration':
          pushIf(unit.constants, converter.fileLevelConstant(child));
          break;
        case 'struct_declaration':
          pushIf(unit.structs, converter.struct(child));
          break;
        case 'enum_declaration':
          pushIf(unit.enums, converter.enum(child));
          break;
        case 'error_declaration':
          pushIf(unit.errors, converter.error(child));
          break;
        case 'user_defined_type_definition':
          pushIf(unit.userDefinedValueTypes, converter.userDefinedValueType(child));
          break;
        default:
          break;
      }
    }

    return { unit, diagnostics, recovered: diagnostics.length > 0 };
  }
}
