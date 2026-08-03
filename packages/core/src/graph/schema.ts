/**
 * The graph data model (§10) and the on-disk shape of `graph.json`.
 *
 * `graph.json` is a **public artifact** — the webview reads it, `axiomap diff`
 * reads an old one against a new one, and users will script against it. §3
 * therefore requires a `schemaVersion` from day one and a refusal to load a
 * mismatch, which is what `serialize.ts` does with the zod schemas below.
 *
 * Zod is the source of truth and the TypeScript types are inferred from it.
 * The alternative — hand-written types plus a validator that has to be kept in
 * step — fails silently in the one direction that matters: a field added to
 * the type but not the schema is written and then rejected on read.
 *
 * ### Two model decisions worth stating
 *
 * **Unresolved edges get a real target.** §4 makes `unresolved` a first-class
 * answer, and "show me every unresolved external call" one of the most valuable
 * queries in the tool. An edge needs two endpoints, so an unresolved call
 * points at a synthetic `Unresolved` node named for the callee (`?call`,
 * `?transform`). These are marked `synthetic` and excluded from node counts;
 * they exist so an unresolved call is filterable and clickable rather than
 * being data hidden on an attribute. §10's node-kind list covers declarations,
 * and a placeholder is not one.
 *
 * **Repeated call sites collapse.** §10: one edge per (from, to, kind,
 * subkind), carrying `count` and every `SourceRef` in `sites`. `src` is the
 * first site, which is what the UI navigates to by default.
 */

import { z } from 'zod';

/** Bump on any change to the serialized shape. Loading a mismatch is refused. */
export const GRAPH_SCHEMA_VERSION = 1;

export const sourceRefSchema = z.object({
  file: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
});

export const nodeKindSchema = z.enum([
  'SourceUnit',
  'Contract',
  'Function',
  'StateVariable',
  'Event',
  'Error',
  'Struct',
  'Enum',
  'UserDefinedValueType',
  'Unresolved',
]);

export const edgeKindSchema = z.enum([
  'calls',
  'inherits',
  'overrides',
  'implements',
  'reads',
  'writes',
  'emits',
  'reverts',
  'modifiedBy',
  'creates',
  'declares',
]);

export const callSubkindSchema = z.enum([
  'internal',
  'external',
  'library',
  'super',
  'delegatecall',
  'lowlevel',
]);

export const resolutionSchema = z.enum(['semantic', 'heuristic', 'ambiguous', 'unresolved']);

export const paramSchema = z.object({
  name: z.string().nullable(),
  type: z.string(),
});

export const functionFlagsSchema = z.object({
  hasAssembly: z.boolean(),
  hasDelegatecall: z.boolean(),
  hasLowLevelCall: z.boolean(),
  hasSelfdestruct: z.boolean(),
  hasCreate: z.boolean(),
  sendsValue: z.boolean(),
  hasUnchecked: z.boolean(),
  hasTryCatch: z.boolean(),
  readsState: z.boolean(),
  writesState: z.boolean(),
});

export const functionMetricsSchema = z.object({
  sloc: z.number().int().nonnegative(),
  cyclomatic: z.number().int().positive(),
  maxDepth: z.number().int().nonnegative(),
});

const nodeBase = {
  id: z.string(),
  name: z.string(),
  file: z.string(),
  /** Containing contract id, or null at file scope. */
  scope: z.string().nullable(),
  src: sourceRefSchema,
};

export const sourceUnitNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal('SourceUnit'),
  pragma: z.string().nullable(),
  versionSupport: z.enum(['supported', 'best-effort', 'unsupported', 'unknown']),
  /** The parse recovered from at least one syntax error. */
  recovered: z.boolean(),
  unresolvedImports: z.array(z.string()),
});

export const contractNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal('Contract'),
  contractKind: z.enum(['contract', 'interface', 'library', 'abstract']),
  baseNames: z.array(z.string()),
  /** C3 order, most-derived first, including itself. Ids where resolvable. */
  linearizedBases: z.array(z.string()),
  linearizationCertainty: z.enum(['certain', 'ambiguous']),
  isFullyImplemented: z.boolean(),
  isTest: z.boolean(),
  isMock: z.boolean(),
});

export const functionNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal('Function'),
  subkind: z.enum(['function', 'constructor', 'fallback', 'receive', 'modifier']),
  visibility: z.enum(['public', 'external', 'internal', 'private', 'default']),
  stateMutability: z.enum(['pure', 'view', 'nonpayable', 'payable']),
  isVirtual: z.boolean(),
  isOverride: z.boolean(),
  modifiers: z.array(z.string()),
  params: z.array(paramSchema),
  returns: z.array(paramSchema),
  hasBody: z.boolean(),
  bodyHash: z.string(),
  interfaceHash: z.string(),
  metrics: functionMetricsSchema,
  flags: functionFlagsSchema,
});

export const stateVariableNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal('StateVariable'),
  type: z.string(),
  visibility: z.enum(['public', 'external', 'internal', 'private', 'default']),
  isConstant: z.boolean(),
  isImmutable: z.boolean(),
  isTransient: z.boolean(),
  isMapping: z.boolean(),
});

export const eventNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal('Event'),
  params: z.array(paramSchema),
  isAnonymous: z.boolean(),
});

export const errorNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal('Error'),
  params: z.array(paramSchema),
});

export const typeNodeSchema = z.object({
  ...nodeBase,
  kind: z.enum(['Struct', 'Enum', 'UserDefinedValueType']),
});

export const unresolvedNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal('Unresolved'),
  synthetic: z.literal(true),
  /** Why nothing could be bound. Feeds §16's "instrument why" backlog item. */
  reason: z.string(),
});

export const graphNodeSchema = z.discriminatedUnion('kind', [
  sourceUnitNodeSchema,
  contractNodeSchema,
  functionNodeSchema,
  stateVariableNodeSchema,
  eventNodeSchema,
  errorNodeSchema,
  typeNodeSchema,
  unresolvedNodeSchema,
]);

export const graphEdgeSchema = z.object({
  id: z.string(),
  kind: edgeKindSchema,
  subkind: callSubkindSchema.optional(),
  from: z.string(),
  to: z.string(),
  resolution: resolutionSchema,
  /** First call site. §10: clicking the edge lands *at the call*. */
  src: sourceRefSchema,
  sites: z.array(sourceRefSchema),
  count: z.number().int().positive(),
  /** Virtual dispatch and interface calls fan out to these. */
  possibleTargets: z.array(z.string()),
  crossTrustBoundary: z.boolean().optional(),
  linearizationIndex: z.number().int().nonnegative().optional(),
  /** Present on ambiguous and unresolved edges. */
  reason: z.string().optional(),
});

export const resolutionCountsSchema = z.object({
  semantic: z.number().int().nonnegative(),
  heuristic: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** (semantic + heuristic) / total, or 1 when there is nothing to resolve. */
  confident: z.number(),
});

export const resolutionScoreSchema = z.object({
  /** Every edge that required a name to be resolved (i.e. not `declares`). */
  overall: resolutionCountsSchema,
  /** `calls` and `creates` only — the score that selects the mode. */
  calls: resolutionCountsSchema,
  /** Files excluded from the score by §4's version policy. */
  excludedFiles: z.number().int().nonnegative(),
});

export const graphModeSchema = z.enum(['full', 'heuristic', 'structural']);

export const graphDiagnosticSchema = z.object({
  message: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
});

export const graphFileSchema = z.object({
  schemaVersion: z.literal(GRAPH_SCHEMA_VERSION),
  generator: z.object({
    name: z.literal('axiomap'),
    parser: z.string(),
    /** Bumping this invalidates stored review state; see `hash.ts`. */
    hashVersion: z.number().int().positive(),
  }),
  project: z.object({
    kind: z.string(),
    sources: z.array(z.string()),
    files: z.number().int().nonnegative(),
  }),
  mode: graphModeSchema,
  /** Why this mode, in words the UI can show verbatim. */
  modeReason: z.string(),
  score: resolutionScoreSchema,
  diagnostics: z.array(graphDiagnosticSchema),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
});

export type SourceRefRecord = z.infer<typeof sourceRefSchema>;
export type NodeKind = z.infer<typeof nodeKindSchema>;
export type EdgeKind = z.infer<typeof edgeKindSchema>;
export type CallSubkind = z.infer<typeof callSubkindSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type ContractNode = z.infer<typeof contractNodeSchema>;
export type FunctionNode = z.infer<typeof functionNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type ResolutionCounts = z.infer<typeof resolutionCountsSchema>;
export type ResolutionScore = z.infer<typeof resolutionScoreSchema>;
export type GraphMode = z.infer<typeof graphModeSchema>;
export type GraphFile = z.infer<typeof graphFileSchema>;

/** Edges that did not require resolving a name, and so do not affect the score. */
export const STRUCTURAL_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['declares']);

/** Edges the call graph is made of. Structural mode drops exactly these. */
export const CALL_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['calls', 'creates']);
