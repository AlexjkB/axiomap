/**
 * §12's non-traversal queries — the ones that are a filter over the graph
 * rather than a walk through it: `writers-of`, `readers-of`, `externals`,
 * `unresolved`, and the summary behind `axiomap stats`.
 *
 * Every one of these is a pure function returning plain data, because both the
 * CLI table and the webview panel have to render the same answer (§5: `query/`
 * is "the API both CLI and webview consume") and a query that formats its own
 * output can only ever serve one of them.
 *
 * Nothing here re-derives an analysis. `externallyReachable`, `accessControl`
 * and `reentrancy` are on the Function nodes already, put there by Phase 4;
 * recomputing them would give a second answer that can disagree with the first,
 * which is the mistake §7 warns about twice.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type {
  FunctionNode,
  GraphEdge,
  GraphFile,
  NodeKind,
  SourceRefRecord,
  UnresolvedCategory,
} from '../graph/schema.js';

/** A function that touches a state variable, and where. */
export interface StateAccess {
  function: string;
  /** The access sites (§10: every edge carries its own `SourceRef`). */
  sites: SourceRefRecord[];
  count: number;
  resolution: GraphEdge['resolution'];
  /** The accessing function's own audit-relevant attributes, for the table. */
  visibility: FunctionNode['visibility'];
  externallyReachable: boolean;
  accessControl: FunctionNode['accessControl'];
}

function accessorsOf(
  graph: AxiomapGraph,
  variable: string,
  kind: 'reads' | 'writes',
): StateAccess[] {
  const out: StateAccess[] = [];
  graph.forEachInEdge(variable, (_key, edge) => {
    if (edge.kind !== kind) return;
    const node = graph.hasNode(edge.from) ? graph.getNodeAttributes(edge.from) : undefined;
    if (node === undefined || node.kind !== 'Function') return;
    out.push({
      function: node.id,
      sites: [...edge.sites],
      count: edge.count,
      resolution: edge.resolution,
      visibility: node.visibility,
      externallyReachable: node.externallyReachable,
      accessControl: node.accessControl,
    });
  });
  return out.sort((a, b) => a.function.localeCompare(b.function));
}

/** §12's `writers-of <var>` — §11's "who can touch this", the write half. */
export function writersOf(graph: AxiomapGraph, variable: string): StateAccess[] {
  return accessorsOf(graph, variable, 'writes');
}

/** §12's `readers-of <var>`. */
export function readersOf(graph: AxiomapGraph, variable: string): StateAccess[] {
  return accessorsOf(graph, variable, 'reads');
}

export interface ExternalsOptions {
  /**
   * §12's `--unprotected`. §15's third definition-of-done item: "identify every
   * externally reachable state-mutating function with no access control".
   *
   * Read it as what it is (§10): `accessControl.confidence === 'none'` means
   * *no recognised guard was found*, not that the function is unguarded. §13's
   * `accessControlModifiers` is what makes a protocol's own spelling
   * recognisable, and the CLI loads it from `axiomap.config.json`.
   */
  unprotected?: boolean;
  /** §12's `--payable`. */
  payable?: boolean;
}

export interface ExternalFunction {
  id: string;
  name: string;
  scope: string | null;
  file: string;
  src: SourceRefRecord;
  visibility: FunctionNode['visibility'];
  stateMutability: FunctionNode['stateMutability'];
  subkind: FunctionNode['subkind'];
  selector: string | undefined;
  mutatesState: boolean;
  accessControl: FunctionNode['accessControl'];
  reentrancy: FunctionNode['reentrancy'];
  flags: FunctionNode['flags'];
}

/**
 * §12's `externals` — the attack surface, as a list.
 *
 * "External" here means *declared* externally callable: `public` or `external`,
 * and not a modifier. That is deliberately not the same as
 * `externallyReachable`, which is the transitive answer and is true of internal
 * helpers too. This query answers "what can an external actor call directly",
 * which is §1's first question and the first column of the attack surface.
 */
export function externals(
  graph: AxiomapGraph,
  options: ExternalsOptions = {},
): ExternalFunction[] {
  const out: ExternalFunction[] = [];

  graph.forEachNode((_id, node) => {
    if (node.kind !== 'Function') return;
    if (node.subkind === 'modifier' || node.subkind === 'constructor') return;
    if (node.visibility !== 'public' && node.visibility !== 'external') return;

    const mutatesState =
      node.stateMutability !== 'view' && node.stateMutability !== 'pure';

    if (options.unprotected === true) {
      // Only state-mutating functions can be a §15 finding: a `view` with no
      // guard is a getter, not a hole.
      if (!mutatesState) return;
      if (node.accessControl.confidence !== 'none') return;
    }
    if (options.payable === true && node.stateMutability !== 'payable') return;

    out.push({
      id: node.id,
      name: node.name,
      scope: node.scope,
      file: node.file,
      src: node.src,
      visibility: node.visibility,
      stateMutability: node.stateMutability,
      subkind: node.subkind,
      selector: node.selector,
      mutatesState,
      accessControl: node.accessControl,
      reentrancy: node.reentrancy,
      flags: node.flags,
    });
  });

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface UnresolvedEdge {
  /** The caller. */
  from: string;
  /** The synthetic placeholder node (§10). */
  to: string;
  /** The callee name as written. */
  callee: string;
  category: UnresolvedCategory;
  reason: string;
  kind: GraphEdge['kind'];
  subkind: GraphEdge['subkind'];
  sites: SourceRefRecord[];
  count: number;
}

/**
 * §12's `unresolved`, and §15's eighth item: `axiomap query unresolved --json`
 * in CI, failing the build on a new unresolved external call.
 *
 * §4 is emphatic that this is a feature rather than an apology — "show me every
 * unresolved external call" is one of the most valuable queries an auditor can
 * run, and it is a graph query like any other precisely because Phase 2 gave
 * these edges a real target node to point at.
 */
export function unresolvedEdges(graph: AxiomapGraph): UnresolvedEdge[] {
  const out: UnresolvedEdge[] = [];

  graph.forEachEdge((_key, edge) => {
    if (edge.resolution !== 'unresolved') return;
    const target = graph.hasNode(edge.to) ? graph.getNodeAttributes(edge.to) : undefined;
    if (target === undefined || target.kind !== 'Unresolved') return;
    out.push({
      from: edge.from,
      to: edge.to,
      callee: target.name,
      category: target.category,
      reason: edge.reason ?? target.reason,
      kind: edge.kind,
      subkind: edge.subkind,
      sites: [...edge.sites],
      count: edge.count,
    });
  });

  return out.sort(
    (a, b) => a.category.localeCompare(b.category) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

export interface GraphStats {
  mode: GraphFile['mode'];
  modeReason: string;
  score: GraphFile['score'];
  files: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  edgesByResolution: Record<string, number>;
  contracts: {
    total: number;
    byKind: Record<string, number>;
    /** §1's fourth question: which of these are real and which are scaffolding. */
    test: number;
    mock: number;
    real: number;
  };
  functions: {
    total: number;
    externallyCallable: number;
    externallyReachable: number;
    /** State-mutating, externally callable, no recognised guard (§15). */
    unprotected: number;
    payable: number;
    withAssembly: number;
    withDelegatecall: number;
    withLowLevelCall: number;
    reentrancyShape: number;
  };
  unresolvedByCategory: Record<string, number>;
}

function tally(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

/**
 * §12's `axiomap stats`.
 *
 * The shape of this is chosen from §15: which contracts are real and which are
 * scaffolding (item 1), how much of the graph is certain versus inferred (item
 * 2), and how large the unguarded externally-reachable surface is (item 3). It
 * is the first thing to run on an unfamiliar protocol, so it answers the
 * questions §1 opens with rather than reporting everything countable.
 */
export function graphStats(graph: AxiomapGraph, file: GraphFile): GraphStats {
  const nodesByKind: Record<string, number> = {};
  const edgesByKind: Record<string, number> = {};
  const edgesByResolution: Record<string, number> = {};
  const byContractKind: Record<string, number> = {};
  const unresolvedByCategory: Record<string, number> = {};

  let contracts = 0;
  let test = 0;
  let mock = 0;
  let real = 0;
  let functions = 0;
  let externallyCallable = 0;
  let externallyReachable = 0;
  let unprotected = 0;
  let payable = 0;
  let withAssembly = 0;
  let withDelegatecall = 0;
  let withLowLevelCall = 0;
  let reentrancyShape = 0;

  graph.forEachNode((_id, node) => {
    tally(nodesByKind, node.kind);

    if (node.kind === 'Contract') {
      contracts += 1;
      tally(byContractKind, node.contractKind);
      // Counted independently, not subtracted: a contract can be both a test
      // and a mock, and `real` has to stay the count of contracts that are
      // neither rather than an arithmetic identity that goes negative.
      if (node.isTest) test += 1;
      if (node.isMock) mock += 1;
      if (!node.isTest && !node.isMock) real += 1;
    } else if (node.kind === 'Unresolved') {
      tally(unresolvedByCategory, node.category);
    } else if (node.kind === 'Function') {
      functions += 1;
      if (node.externallyReachable) externallyReachable += 1;
      if (node.flags.hasAssembly) withAssembly += 1;
      if (node.flags.hasDelegatecall) withDelegatecall += 1;
      if (node.flags.hasLowLevelCall) withLowLevelCall += 1;
      if (node.reentrancy.externalCallThenWrite) reentrancyShape += 1;
      if (node.stateMutability === 'payable') payable += 1;

      const callable =
        node.subkind !== 'modifier' &&
        node.subkind !== 'constructor' &&
        (node.visibility === 'public' || node.visibility === 'external');
      if (callable) {
        externallyCallable += 1;
        const mutates = node.stateMutability !== 'view' && node.stateMutability !== 'pure';
        if (mutates && node.accessControl.confidence === 'none') unprotected += 1;
      }
    }
  });

  graph.forEachEdge((_key, edge) => {
    tally(edgesByKind, edge.kind);
    tally(edgesByResolution, edge.resolution);
  });

  return {
    mode: file.mode,
    modeReason: file.modeReason,
    score: file.score,
    files: file.project.files,
    nodesByKind,
    edgesByKind,
    edgesByResolution,
    contracts: {
      total: contracts,
      byKind: byContractKind,
      test,
      mock,
      real,
    },
    functions: {
      total: functions,
      externallyCallable,
      externallyReachable,
      unprotected,
      payable,
      withAssembly,
      withDelegatecall,
      withLowLevelCall,
      reentrancyShape,
    },
    unresolvedByCategory,
  };
}

/** Node kinds a `writers-of`/`readers-of` reference may name. */
export const STATE_VARIABLE_KINDS: readonly NodeKind[] = ['StateVariable'];
