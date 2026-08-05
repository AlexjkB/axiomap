/**
 * Symbol table + resolved edges → the graph (§10).
 *
 * `graphology` is the model per §3, chosen because it is rendering-agnostic and
 * ships the traversals Phase 4's analysis passes need. It is built here and
 * handed on; nothing downstream reaches back into the symbol table.
 *
 * The two jobs that are not just copying fields:
 *
 * - **Collapsing repeated call sites.** §10: one edge per (from, to, kind,
 *   subkind), with `count` and every `SourceRef` in `sites`. Twenty calls to
 *   `_mint` from one function is one edge weighted twenty, not twenty edges —
 *   but the score still counts twenty, because twenty unresolved call sites is
 *   twenty unresolved call sites.
 * - **Applying the mode.** Structural mode (§4) drops `calls` and `creates`
 *   edges and says so. Four of the five views survive that, which is the whole
 *   argument for the mode existing.
 */

// The named export, not the default: `graphology`'s package is CJS-first with
// no `exports` map, so under NodeNext a default import resolves to the module
// namespace rather than the class.
import { MultiDirectedGraph } from 'graphology';

import { analyseGraph, applyAnalysis, type AnalysisOptions } from '../analysis/index.js';
import type { ParsedParam } from '../parse/interface.js';
import type { SourceRef } from '../parse/positions.js';
import type { DetectedProject } from '../project/detect.js';
import { matchesAny } from '../project/globs.js';
import { resolveProject, type EdgeDraft, type ProjectScope } from '../resolve/index.js';
import type { NodeId } from '../symbols/ids.js';
import type { AnySymbol, ContractSymbol, SymbolTable } from '../symbols/table.js';
import {
  CALL_EDGE_KINDS,
  GRAPH_SCHEMA_VERSION,
  type GraphDiagnostic,
  type GraphEdge,
  type GraphFile,
  type GraphNode,
  type Param,
  type GraphSettings,
  type Resolution,
} from './schema.js';
import { HASH_VERSION } from './hash.js';
import { GraphSchemaError } from './serialize.js';
import { DEFAULT_CALL_RESOLUTION_THRESHOLD, scoreEdges, selectMode } from './score.js';
import {
  applySemanticNodeAttributes,
  applySemanticOverlay,
  type SemanticOverlay,
} from './semantic.js';

export type AxiomapGraph = MultiDirectedGraph<GraphNode, GraphEdge>;

/**
 * Nodes and edges into a graphology graph.
 *
 * Shared by `buildGraph` and `graphFromFile` so there is one definition of what
 * an `AxiomapGraph` is — self-loops allowed (a recursive function calls
 * itself), edges keyed by their own id, node and edge attributes held by
 * reference.
 */
function assemble(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): AxiomapGraph {
  const graph: AxiomapGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({
    allowSelfLoops: true,
  });
  for (const node of nodes) graph.addNode(node.id, node);
  for (const edge of edges) graph.addDirectedEdgeWithKey(edge.id, edge.from, edge.to, edge);
  return graph;
}

/**
 * A `graph.json` that has been read back, as a graph again.
 *
 * `buildGraph` is the only other thing that produces an `AxiomapGraph`, and it
 * needs a project on disk to do it. Everything downstream of Phase 4 consumes
 * the graph rather than the sources — the analysis passes, `axiomap query`,
 * the diff engine reading a stored revision — and asking them to re-ingest a
 * project they already have the artifact for would be both slow and a lie: the
 * sources may have moved on since the artifact was written.
 *
 * The file is assumed to have come through `parseGraph`, which is what applies
 * the schema, restores defaulted fields and rebuilds each edge's `src` from
 * `sites[0]`. The one thing checked here is internal consistency, because an
 * edge with a missing endpoint is what a hand-filtered or hand-edited artifact
 * produces and graphology's own error for it names neither the edge nor the
 * file.
 */
export function graphFromFile(file: GraphFile, source = '<memory>'): AxiomapGraph {
  const known = new Set(file.nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];

  for (const edge of file.edges) {
    const missing = !known.has(edge.from) ? edge.from : !known.has(edge.to) ? edge.to : null;
    if (missing !== null) {
      throw new GraphSchemaError(
        `${source} has edge "${edge.id}" pointing at "${missing}", which is not a node in the ` +
          `same file. Rebuild the graph with "axiomap build".`,
      );
    }
    // Restated rather than asserted: `parseGraph` fills `src` from `sites[0]`,
    // but the schema's transform types it as optional, and §10 requires every
    // edge to carry a call site. An edge with neither is a malformed artifact,
    // not something to paper over with a placeholder location.
    const src = edge.src ?? edge.sites[0];
    if (src === undefined) {
      throw new GraphSchemaError(
        `${source} has edge "${edge.id}" with no source location. ` +
          `Rebuild the graph with "axiomap build".`,
      );
    }
    edges.push({ ...edge, src });
  }

  return assemble(file.nodes, edges);
}

export interface BuiltGraph {
  graph: AxiomapGraph;
  /** The serializable form; `serialize.ts` writes exactly this. */
  file: GraphFile;
  scope: ProjectScope;
}

export interface BuildGraphOptions {
  project: DetectedProject;
  table: SymbolTable;
  parserId?: string;
  /** Override §4's measured threshold. */
  callResolutionThreshold?: number;
  /**
   * The semantic tier, when one could be loaded. Absent is the ordinary case
   * (§4: everything below `GRAPH (usable)` is optional), and the graph built
   * without it is the same graph with honest heuristic labels.
   */
  semantic?: SemanticOverlay;
  /** Diagnostics from loading it, merged into the file's own.  */
  semanticDiagnostics?: readonly GraphDiagnostic[];
  /** §13's `entrypoints`, `accessControlModifiers` and `reentrancyGuards`. */
  analysis?: AnalysisOptions;
  /**
   * §13's `trustBoundaries`. A call whose target lives under one of these
   * globs leaves the code under audit, which is exactly what §10's
   * `crossTrustBoundary` marks — the resolver already sets it for interface
   * calls, where the boundary is inferred; this is the same fact stated by the
   * user for a directory.
   */
  trustBoundaries?: { external?: readonly string[] };
  /**
   * The §13 settings to record in the artifact, so a later reader can tell
   * whether this graph answers the question being asked of it. Recorded rather
   * than re-derived: `include`/`exclude` are applied during ingest and are not
   * recoverable from the graph they produced.
   */
  settings?: GraphSettings;
}

/** Confidence order, weakest last. Merging two edges keeps the weakest. */
const CONFIDENCE: Record<Resolution, number> = {
  semantic: 3,
  heuristic: 2,
  ambiguous: 1,
  unresolved: 0,
};

/**
 * `indexed` and `storageLocation` are carried through because they are part of
 * the declared interface: flipping `indexed` on an event parameter changes the
 * ABI and breaks every log consumer, which is a §8 breaking change rather than
 * a re-review trigger. Both hold their default on most parameters, so the
 * serializer drops them and costs nothing at rest.
 */
function paramRecords(params: readonly ParsedParam[]): Param[] {
  return params.map((p) => ({
    name: p.name,
    type: p.typeName,
    indexed: p.indexed,
    storageLocation: p.storageLocation,
  }));
}

function fileRef(file: string): SourceRef {
  return { file, offset: 0, length: 0, line: 1, column: 0 };
}

const TYPE_KINDS = {
  struct: 'Struct',
  enum: 'Enum',
  userDefinedValueType: 'UserDefinedValueType',
} as const;

/**
 * A contract is fully implemented when every function reachable through its
 * linearization has a body. Interfaces are therefore never fully implemented,
 * which is correct and is what the UI wants to show.
 */
function isFullyImplemented(scope: ProjectScope, contract: ContractSymbol): boolean {
  if (contract.contractKind === 'interface') return false;
  const seen = new Set<string>();
  for (const ancestorId of scope.linearization(contract.id).order) {
    const ancestor = scope.contract(ancestorId);
    if (ancestor === null) continue;
    for (const memberId of ancestor.members) {
      const member = scope.table.symbols.get(memberId);
      if (member === undefined || member.kind !== 'function') continue;
      if (member.subkind === 'constructor') continue;
      const key = `${member.name}(${member.params.map((p) => p.typeName).join(',')})`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!member.hasBody) return false;
    }
  }
  return true;
}

function nodeFor(symbol: AnySymbol, scope: ProjectScope): GraphNode | null {
  const base = {
    id: symbol.id,
    name: symbol.name,
    file: symbol.file,
    scope: symbol.scope,
    src: symbol.src,
  };

  switch (symbol.kind) {
    case 'contract': {
      const linearization = scope.linearization(symbol.id);
      return {
        ...base,
        kind: 'Contract',
        contractKind: symbol.contractKind,
        baseNames: symbol.baseNames,
        linearizedBases: linearization.order,
        linearizationCertainty: linearization.certainty,
        isFullyImplemented: isFullyImplemented(scope, symbol),
        isTest: symbol.isTest,
        isMock: symbol.isMock,
      };
    }
    case 'function':
    case 'modifier':
      return {
        ...base,
        kind: 'Function',
        subkind: symbol.subkind,
        visibility: symbol.visibility,
        stateMutability: symbol.stateMutability,
        isVirtual: symbol.isVirtual,
        isOverride: symbol.isOverride,
        modifiers: [],
        params: paramRecords(symbol.params),
        returns: paramRecords(symbol.returns),
        hasBody: symbol.hasBody,
        bodyHash: symbol.bodyHash,
        interfaceHash: symbol.interfaceHash,
        metrics: symbol.metrics,
        flags: {
          hasAssembly: symbol.flags.hasAssembly,
          hasDelegatecall: symbol.flags.hasDelegatecall,
          hasLowLevelCall: symbol.flags.hasLowLevelCall,
          hasSelfdestruct: symbol.flags.hasSelfdestruct,
          hasCreate: symbol.flags.hasCreate,
          sendsValue: symbol.flags.sendsValue,
          hasUnchecked: symbol.flags.hasUnchecked,
          hasTryCatch: symbol.flags.hasTryCatch,
          // Filled from resolved edges below; assembly contributes directly
          // because a `sstore` names no variable to bind.
          readsState: symbol.flags.assemblyReadsState,
          writesState: symbol.flags.assemblyWritesState,
          checksSender: symbol.flags.checksSender,
        },
        // Phase 4's fields, filled by `applyAnalysis` once every node and edge
        // exists. They hold their defaults until then; a partially-built graph
        // must not be able to report a function unreachable.
        externallyReachable: false,
        entrypoints: [],
        accessControl: { modifiers: [], confidence: 'none' },
        reentrancy: { externalCallThenWrite: false, guarded: false },
      };
    case 'stateVariable':
      return {
        ...base,
        kind: 'StateVariable',
        type: symbol.typeName,
        visibility: symbol.visibility,
        isConstant: symbol.isConstant,
        isImmutable: symbol.isImmutable,
        isTransient: symbol.isTransient,
        isMapping: symbol.isMapping,
      };
    case 'event':
      return {
        ...base,
        kind: 'Event',
        params: paramRecords(symbol.params),
        isAnonymous: symbol.isAnonymous,
      };
    case 'error':
      return { ...base, kind: 'Error', params: paramRecords(symbol.params) };
    case 'struct':
    case 'enum':
    case 'userDefinedValueType':
      return { ...base, kind: TYPE_KINDS[symbol.kind] };
    default:
      return null;
  }
}

function edgeKey(draft: EdgeDraft): string {
  return `${draft.from}|${draft.to}|${draft.kind}|${draft.subkind ?? ''}`;
}

/** Collapse per §10 and keep the weakest confidence of the sites merged. */
function collapse(drafts: readonly EdgeDraft[], known: ReadonlySet<NodeId>): GraphEdge[] {
  const byKey = new Map<string, GraphEdge>();

  for (const draft of drafts) {
    if (!known.has(draft.from) || !known.has(draft.to)) continue;
    const key = edgeKey(draft);
    const existing = byKey.get(key);

    if (existing === undefined) {
      byKey.set(key, {
        id: key,
        kind: draft.kind,
        from: draft.from,
        to: draft.to,
        resolution: draft.resolution,
        src: draft.src,
        sites: [draft.src],
        count: 1,
        possibleTargets: draft.possibleTargets ?? [],
        ...(draft.subkind === undefined ? {} : { subkind: draft.subkind }),
        ...(draft.crossTrustBoundary === true ? { crossTrustBoundary: true } : {}),
        ...(draft.linearizationIndex === undefined
          ? {}
          : { linearizationIndex: draft.linearizationIndex }),
        ...(draft.reason === undefined ? {} : { reason: draft.reason }),
      });
      continue;
    }

    existing.count++;
    existing.sites.push(draft.src);
    if (CONFIDENCE[draft.resolution] < CONFIDENCE[existing.resolution]) {
      existing.resolution = draft.resolution;
      if (draft.reason !== undefined) existing.reason = draft.reason;
    }
    if (draft.crossTrustBoundary === true) existing.crossTrustBoundary = true;
    for (const target of draft.possibleTargets ?? []) {
      if (!existing.possibleTargets.includes(target)) existing.possibleTargets.push(target);
    }
  }

  return [...byKey.values()];
}

export function buildGraph(options: BuildGraphOptions): BuiltGraph {
  const { project, table } = options;
  const resolved = resolveProject(table);
  const scope = resolved.scope;
  const diagnostics: GraphDiagnostic[] = [
    ...table.diagnostics.map((d) => ({ ...d })),
    ...(options.semanticDiagnostics ?? []).map((d) => ({ ...d })),
  ];

  // The semantic tier upgrades the resolver's drafts *before* they collapse,
  // so a confirmed site and an unseen one merge under §10's existing
  // weakest-wins rule. See `semantic.ts` for what it may and may not change.
  let drafts = resolved.edges;
  if (options.semantic !== undefined) {
    const applied = applySemanticOverlay(drafts, options.semantic);
    drafts = applied.drafts;
    for (const warning of applied.warnings) {
      diagnostics.push({ severity: 'warning', message: warning });
    }
  }

  // --- nodes ------------------------------------------------------------
  const nodes: GraphNode[] = [];

  for (const file of table.files.values()) {
    nodes.push({
      id: file.file,
      kind: 'SourceUnit',
      name: file.file,
      file: file.file,
      scope: null,
      src: fileRef(file.file),
      pragma: file.pragma,
      versionSupport: file.versionSupport,
      recovered: file.recovered,
      unresolvedImports: file.imports.filter((i) => i.resolved === null).map((i) => i.raw),
    });
  }

  for (const symbol of table.symbols.values()) {
    const node = nodeFor(symbol, scope);
    if (node !== null) nodes.push(node);
  }

  for (const target of resolved.unresolvedTargets.values()) {
    nodes.push({
      id: target.id,
      kind: 'Unresolved',
      name: target.name,
      file: target.file,
      scope: null,
      src: target.src,
      synthetic: true,
      category: target.category,
      reason: target.reason,
    });
  }

  const known = new Set(nodes.map((n) => n.id));
  const edges = collapse(drafts, known);

  // §13's declared trust boundaries. Additive only: the resolver already marks
  // interface calls, and a user saying "lib/** is external" is more evidence
  // rather than a correction, so a marked edge is never unmarked here.
  const external = options.trustBoundaries?.external;
  if (external !== undefined && external.length > 0) {
    const byIdForBoundaries = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of edges) {
      if (edge.crossTrustBoundary === true || !CALL_EDGE_KINDS.has(edge.kind)) continue;
      const target = byIdForBoundaries.get(edge.to);
      if (target !== undefined && matchesAny(target.file, external)) {
        edge.crossTrustBoundary = true;
      }
    }
  }

  // Selectors and storage slots (§10), which have no syntactic equivalent.
  if (options.semantic !== undefined) applySemanticNodeAttributes(nodes, options.semantic);

  // --- derived node attributes -----------------------------------------
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const edge of edges) {
    const from = byId.get(edge.from);
    if (from?.kind !== 'Function') continue;
    if (edge.kind === 'reads') from.flags.readsState = true;
    if (edge.kind === 'writes') from.flags.writesState = true;
    if (edge.kind === 'modifiedBy' && !from.modifiers.includes(edge.to)) {
      from.modifiers.push(edge.to);
    }
  }

  // --- score and mode ---------------------------------------------------
  const excludedFiles = new Set<string>();
  for (const file of table.files.values()) {
    if (file.versionSupport !== 'supported') excludedFiles.add(file.file);
  }

  const score = scoreEdges({ edges, excludedFiles });
  const decision = selectMode(
    score,
    options.callResolutionThreshold ?? DEFAULT_CALL_RESOLUTION_THRESHOLD,
  );

  const kept =
    decision.mode === 'structural' ? edges.filter((e) => !CALL_EDGE_KINDS.has(e.kind)) : edges;

  // Synthetic targets only exist to carry an edge; drop the orphans that
  // structural mode leaves behind rather than shipping unreachable nodes.
  const referenced = new Set<NodeId>();
  for (const edge of kept) {
    referenced.add(edge.from);
    referenced.add(edge.to);
  }
  const keptNodes = nodes.filter((n) => n.kind !== 'Unresolved' || referenced.has(n.id));

  // --- graphology -------------------------------------------------------
  const graph = assemble(keptNodes, kept);

  // --- Phase 4's analysis passes ----------------------------------------
  // Run against the graph as it will ship, not as it was assembled: in
  // structural mode the call edges are already gone, and reachability over a
  // graph with no call edges is the entrypoints and nothing else. The nodes
  // are mutated in place, so `file.nodes` and the graph's attributes are the
  // same objects and cannot drift.
  applyAnalysis(keptNodes, analyseGraph(graph, options.analysis ?? {}));

  const file: GraphFile = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generator: {
      name: 'axiomap',
      parser: options.parserId ?? 'treesitter',
      hashVersion: HASH_VERSION,
      compilers: [...(options.semantic?.compilers ?? [])],
      // Omitted entirely when nothing was configured, which is what keeps a
      // default build's artifact byte-identical to its v3 form.
      ...(options.settings === undefined || Object.keys(options.settings).length === 0
        ? {}
        : { settings: options.settings }),
    },
    project: {
      kind: project.kind,
      sources: [...project.sources],
      files: table.files.size,
    },
    mode: decision.mode,
    modeReason: decision.reason,
    score,
    diagnostics,
    nodes: sortNodes(keptNodes),
    edges: sortEdges(kept),
  };

  return { graph, file, scope };
}

/** Deterministic order: golden files must diff on content, never on ordering. */
function sortNodes(nodes: readonly GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  return [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
