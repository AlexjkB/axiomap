/**
 * Graph objects, built by hand.
 *
 * This package cannot import core's *functions* (§5), so it cannot build a
 * graph the way core's own tests do. That is not a gap: what these tests check
 * is the translation from an `AggregatedView` to something drawable, and a
 * hand-built view states exactly which fields the translation is supposed to
 * read.
 */

import type {
  AggregatedView,
  ContractNode,
  FunctionNode,
  GraphEdge,
  SourceRefRecord,
  StateVariableNode,
} from '@axiomap/core';

const src: SourceRefRecord = { file: 'src/Vault.sol', offset: 0, length: 10, line: 1, column: 0 };

export function contract(id: string, over: Partial<ContractNode> = {}): ContractNode {
  return {
    id,
    name: id.split(':').pop() ?? id,
    file: 'src/Vault.sol',
    scope: null,
    src,
    kind: 'Contract',
    contractKind: 'contract',
    baseNames: [],
    linearizedBases: [id],
    linearizationCertainty: 'certain',
    isFullyImplemented: true,
    isTest: false,
    isMock: false,
    ...over,
  };
}

export function fn(id: string, over: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id,
    name: id.split(':').pop()?.replace(/\(.*/, '').replace(/^.*\./, '') ?? id,
    file: 'src/Vault.sol',
    scope: 'src/Vault.sol:Vault',
    src,
    kind: 'Function',
    subkind: 'function',
    visibility: 'external',
    stateMutability: 'nonpayable',
    isVirtual: false,
    isOverride: false,
    modifiers: [],
    params: [{ name: 'amount', type: 'uint256', indexed: false, storageLocation: 'default' }],
    returns: [],
    hasBody: true,
    bodyHash: 'b1:0',
    interfaceHash: 'i1:0',
    metrics: { sloc: 3, cyclomatic: 1, maxDepth: 1 },
    flags: {
      hasAssembly: false,
      hasDelegatecall: false,
      hasLowLevelCall: false,
      hasSelfdestruct: false,
      hasCreate: false,
      sendsValue: false,
      hasUnchecked: false,
      hasTryCatch: false,
      readsState: false,
      writesState: false,
      assemblyReadsState: false,
      assemblyWritesState: false,
      checksSender: false,
    },
    externallyReachable: true,
    entrypoints: [],
    accessControl: { modifiers: [], confidence: 'none' },
    reentrancy: { externalCallThenWrite: false, guarded: false },
    ...over,
  };
}

export function stateVariable(
  id: string,
  over: Partial<StateVariableNode> = {},
): StateVariableNode {
  return {
    id,
    name: id.split(':').pop()?.replace(/^.*\./, '') ?? id,
    file: 'src/Vault.sol',
    scope: 'src/Vault.sol:Vault',
    src,
    kind: 'StateVariable',
    type: 'uint256',
    visibility: 'public',
    isConstant: false,
    isImmutable: false,
    isTransient: false,
    isMapping: false,
    ...over,
  };
}

export function edge(over: Partial<GraphEdge> & Pick<GraphEdge, 'id' | 'from' | 'to'>): GraphEdge {
  return {
    kind: 'calls',
    subkind: 'internal',
    resolution: 'heuristic',
    src,
    sites: [src],
    count: 1,
    possibleTargets: [],
    ...over,
  };
}

export function view(over: Partial<AggregatedView> = {}): AggregatedView {
  return {
    view: 'protocol',
    nodes: [],
    edges: [],
    elements: 0,
    cap: 1500,
    expanded: [],
    collapsed: [],
    note: 'note',
    ...over,
  };
}
