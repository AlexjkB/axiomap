/**
 * Build the global symbol table from parsed source units.
 *
 * Pure: takes parse results and a resolved project, returns a table. No I/O,
 * no parsing, no filesystem access — which is what makes the whole thing
 * testable against fixtures with hand-counted expectations, the Phase 1 exit
 * criterion.
 */

import type { ParsedContract, ParsedFunction, ParseResult } from '../parse/interface.js';
import type { DetectedProject } from '../project/detect.js';
import {
  describeUnresolvedImport,
  ImportResolver,
  type ResolvedImport,
} from '../project/imports.js';
import {
  contractId,
  errorId,
  eventId,
  functionId,
  modifierId,
  stateVariableId,
  typeId,
} from './ids.js';
import type {
  AnySymbol,
  ContractSymbol,
  FileSymbols,
  FunctionSymbol,
  SymbolBase,
  SymbolTable,
  SymbolTableStats,
} from './table.js';
import { classifyPragma, findSolidityPragma } from './version.js';

/** §10: `isTest` when the contract inherits Test/DSTest or lives under test/. */
const TEST_BASES = new Set(['Test', 'DSTest', 'StdAssertions', 'StdCheats']);
const TEST_DIR = /(^|\/)(test|tests)\//i;
const MOCK_HINT = /(^|\/)mocks?\//i;

function emptyStats(): SymbolTableStats {
  return {
    files: 0,
    parsedFiles: 0,
    filesWithErrors: 0,
    contracts: 0,
    interfaces: 0,
    libraries: 0,
    abstractContracts: 0,
    functions: 0,
    modifiers: 0,
    stateVariables: 0,
    events: 0,
    errors: 0,
    structs: 0,
    enums: 0,
    userDefinedValueTypes: 0,
    unresolvedImports: 0,
    bestEffortFiles: 0,
    unsupportedFiles: 0,
  };
}

/**
 * Constructors, fallbacks and receives have no name of their own. They still
 * need a stable, readable ID, so they get their keyword as the name — which is
 * also how an auditor refers to them.
 */
function functionName(fn: ParsedFunction): string {
  if (fn.name !== null && fn.name !== '') return fn.name;
  switch (fn.subkind) {
    case 'constructor':
      return 'constructor';
    case 'fallback':
      return 'fallback';
    case 'receive':
      return 'receive';
    default:
      return '<anonymous>';
  }
}

/**
 * Everything a `FunctionSymbol` copies verbatim from a `ParsedFunction`, in one
 * place. Three call sites build function symbols — file-level, contract
 * function, contract modifier — and Phase 2 added nine more fields to each.
 */
function functionBody(fn: ParsedFunction): Omit<FunctionSymbol, keyof SymbolBase | 'kind'> {
  return {
    subkind: fn.subkind,
    visibility: fn.visibility,
    stateMutability: fn.stateMutability,
    isVirtual: fn.isVirtual,
    isOverride: fn.isOverride,
    overrides: fn.overrides,
    modifierNames: fn.modifiers.map((m) => m.name),
    params: fn.params,
    returns: fn.returns,
    hasBody: fn.hasBody,
    body: fn.body,
    calls: fn.calls,
    identifiers: fn.identifiers,
    emits: fn.emits,
    reverts: fn.reverts,
    locals: fn.locals,
    flags: fn.flags,
    metrics: fn.metrics,
    bodyHash: fn.bodyHash,
    interfaceHash: fn.interfaceHash,
  };
}

export interface BuildSymbolTableInput {
  project: DetectedProject;
  /** Parse results keyed by project-relative posix path. */
  results: Map<string, ParseResult>;
}

export function buildSymbolTable(input: BuildSymbolTableInput): SymbolTable {
  const { project, results } = input;

  const table: SymbolTable = {
    root: project.root,
    files: new Map(),
    symbols: new Map(),
    byName: new Map(),
    contractsByName: new Map(),
    unresolvedImports: [],
    diagnostics: project.diagnostics.map((d) => ({ ...d })),
    stats: emptyStats(),
  };

  const resolver = new ImportResolver({
    files: results.keys(),
    remappings: project.remappings,
    sources: project.sources,
  });

  const index = (symbol: AnySymbol, fileSymbols: FileSymbols, topLevel: boolean): void => {
    if (table.symbols.has(symbol.id)) {
      // Two declarations with the same ID in one file is malformed Solidity;
      // keep the first and say so rather than silently overwriting.
      table.diagnostics.push({
        message: `Duplicate declaration id ${symbol.id} in ${symbol.file}; keeping the first.`,
        severity: 'warning',
      });
      return;
    }
    table.symbols.set(symbol.id, symbol);
    fileSymbols.declarations.push(symbol.id);

    const byName = table.byName.get(symbol.name);
    if (byName === undefined) table.byName.set(symbol.name, [symbol.id]);
    else byName.push(symbol.id);

    if (topLevel && !fileSymbols.exports.has(symbol.name)) {
      fileSymbols.exports.set(symbol.name, symbol.id);
    }
  };

  for (const [file, result] of results) {
    const { unit } = result;
    const pragma = findSolidityPragma(unit.pragmas);
    const version = classifyPragma(pragma);

    const fileSymbols: FileSymbols = {
      file,
      pragma,
      versionSupport: version.support,
      declarations: [],
      exports: new Map(),
      imported: new Map(),
      imports: [],
      bareImports: [],
      recovered: result.recovered,
      diagnosticCount: result.diagnostics.length,
    };
    table.files.set(file, fileSymbols);

    table.stats.files++;
    table.stats.parsedFiles++;
    if (result.diagnostics.length > 0) table.stats.filesWithErrors++;
    if (version.support === 'best-effort') table.stats.bestEffortFiles++;
    if (version.support === 'unsupported') {
      table.stats.unsupportedFiles++;
      table.diagnostics.push({
        message:
          `${file} declares "${(pragma ?? '').trim()}", below Axiomap's 0.5 hard floor (§4). ` +
          'Its graph would be subtly wrong, so it is parsed but excluded from the resolution score.',
        severity: 'warning',
      });
    }

    // --- imports -------------------------------------------------------
    for (const imported of unit.imports) {
      const resolved: ResolvedImport = resolver.resolve(file, imported.path);
      fileSymbols.imports.push(resolved);

      if (resolved.resolved === null) {
        table.unresolvedImports.push(resolved);
        table.stats.unresolvedImports++;
        table.diagnostics.push({
          message: describeUnresolvedImport(resolved, project.configFiles),
          severity: 'warning',
        });
        continue;
      }

      const fromFile = resolved.resolved;
      if (imported.symbols.length > 0) {
        for (const symbol of imported.symbols) {
          fileSymbols.imported.set(symbol.alias ?? symbol.name, {
            fromFile,
            originalName: symbol.name,
          });
        }
      } else if (imported.unitAlias !== null) {
        // `import * as L from "..."` — the alias names the whole unit.
        fileSymbols.imported.set(imported.unitAlias, { fromFile, originalName: '*' });
      } else {
        // A bare `import "..."` pulls in every top-level name. It is expanded
        // in `resolve/`, not here: the target file's exports may not be indexed
        // yet at this point in the loop.
        fileSymbols.bareImports.push(fromFile);
      }
    }

    // --- file-level declarations ---------------------------------------
    for (const fn of unit.functions) {
      const name = functionName(fn);
      index(
        {
          id: functionId(file, null, name, fn.params),
          kind: 'function',
          name,
          file,
          scope: null,
          src: fn.src,
          ...functionBody(fn),
        },
        fileSymbols,
        true,
      );
      table.stats.functions++;
    }

    for (const constant of unit.constants) {
      index(
        {
          id: stateVariableId(file, null, constant.name),
          kind: 'stateVariable',
          name: constant.name,
          file,
          scope: null,
          src: constant.src,
          typeName: constant.typeName,
          visibility: constant.visibility,
          isConstant: constant.isConstant,
          isImmutable: constant.isImmutable,
          isTransient: constant.isTransient,
          isMapping: constant.isMapping,
        },
        fileSymbols,
        true,
      );
      table.stats.stateVariables++;
    }

    for (const error of unit.errors) {
      index(
        {
          id: errorId(file, null, error.name, error.params),
          kind: 'error',
          name: error.name,
          file,
          scope: null,
          src: error.src,
          params: error.params,
        },
        fileSymbols,
        true,
      );
      table.stats.errors++;
    }

    for (const struct of unit.structs) {
      index(
        {
          id: typeId(file, null, struct.name),
          kind: 'struct',
          name: struct.name,
          file,
          scope: null,
          src: struct.src,
        },
        fileSymbols,
        true,
      );
      table.stats.structs++;
    }

    for (const enumeration of unit.enums) {
      index(
        {
          id: typeId(file, null, enumeration.name),
          kind: 'enum',
          name: enumeration.name,
          file,
          scope: null,
          src: enumeration.src,
        },
        fileSymbols,
        true,
      );
      table.stats.enums++;
    }

    for (const udvt of unit.userDefinedValueTypes) {
      index(
        {
          id: typeId(file, null, udvt.name),
          kind: 'userDefinedValueType',
          name: udvt.name,
          file,
          scope: null,
          src: udvt.src,
        },
        fileSymbols,
        true,
      );
      table.stats.userDefinedValueTypes++;
    }

    // --- contracts ------------------------------------------------------
    for (const contract of unit.contracts) {
      indexContract(contract, file, fileSymbols, table, index);
    }
  }

  return table;
}

function indexContract(
  contract: ParsedContract,
  file: string,
  fileSymbols: FileSymbols,
  table: SymbolTable,
  index: (symbol: AnySymbol, fileSymbols: FileSymbols, topLevel: boolean) => void,
): void {
  const id = contractId(file, contract.name);
  const scope = contract.name;

  const symbol: ContractSymbol = {
    id,
    kind: 'contract',
    name: contract.name,
    file,
    scope: null,
    src: contract.src,
    contractKind: contract.kind,
    baseNames: contract.bases.map((b) => b.name),
    members: [],
    usingFor: contract.usingFor.map((u) => ({
      libraryName: u.libraryName,
      functions: u.functions,
      typeName: u.typeName,
    })),
    isTest: contract.bases.some((b) => TEST_BASES.has(b.name)) || TEST_DIR.test(file),
    isMock: /mock/i.test(contract.name) || MOCK_HINT.test(file),
  };

  index(symbol, fileSymbols, true);

  const contractIds = table.contractsByName.get(contract.name);
  if (contractIds === undefined) table.contractsByName.set(contract.name, [id]);
  else contractIds.push(id);

  switch (contract.kind) {
    case 'interface':
      table.stats.interfaces++;
      break;
    case 'library':
      table.stats.libraries++;
      break;
    case 'abstract':
      table.stats.abstractContracts++;
      break;
    default:
      table.stats.contracts++;
      break;
  }

  const member = (memberSymbol: AnySymbol): void => {
    const before = table.symbols.size;
    index(memberSymbol, fileSymbols, false);
    if (table.symbols.size > before) symbol.members.push(memberSymbol.id);
  };

  for (const fn of contract.functions) {
    const name = functionName(fn);
    if (fn.subkind === 'modifier') {
      member({
        id: modifierId(file, scope, name),
        kind: 'modifier',
        name,
        file,
        scope: id,
        src: fn.src,
        ...functionBody(fn),
      });
      table.stats.modifiers++;
      continue;
    }

    member({
      id: functionId(file, scope, name, fn.params),
      kind: 'function',
      name,
      file,
      scope: id,
      src: fn.src,
      ...functionBody(fn),
    });
    table.stats.functions++;
  }

  for (const variable of contract.stateVariables) {
    member({
      id: stateVariableId(file, scope, variable.name),
      kind: 'stateVariable',
      name: variable.name,
      file,
      scope: id,
      src: variable.src,
      typeName: variable.typeName,
      visibility: variable.visibility,
      isConstant: variable.isConstant,
      isImmutable: variable.isImmutable,
      isTransient: variable.isTransient,
      isMapping: variable.isMapping,
    });
    table.stats.stateVariables++;
  }

  for (const event of contract.events) {
    member({
      id: eventId(file, scope, event.name, event.params),
      kind: 'event',
      name: event.name,
      file,
      scope: id,
      src: event.src,
      params: event.params,
      isAnonymous: event.isAnonymous,
    });
    table.stats.events++;
  }

  for (const error of contract.errors) {
    member({
      id: errorId(file, scope, error.name, error.params),
      kind: 'error',
      name: error.name,
      file,
      scope: id,
      src: error.src,
      params: error.params,
    });
    table.stats.errors++;
  }

  for (const struct of contract.structs) {
    member({
      id: typeId(file, scope, struct.name),
      kind: 'struct',
      name: struct.name,
      file,
      scope: id,
      src: struct.src,
    });
    table.stats.structs++;
  }

  for (const enumeration of contract.enums) {
    member({
      id: typeId(file, scope, enumeration.name),
      kind: 'enum',
      name: enumeration.name,
      file,
      scope: id,
      src: enumeration.src,
    });
    table.stats.enums++;
  }

  for (const udvt of contract.userDefinedValueTypes) {
    member({
      id: typeId(file, scope, udvt.name),
      kind: 'userDefinedValueType',
      name: udvt.name,
      file,
      scope: id,
      src: udvt.src,
    });
    table.stats.userDefinedValueTypes++;
  }
}
