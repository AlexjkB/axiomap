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

/**
 * Bump on any change to the serialized shape. Loading a mismatch is refused.
 *
 * - **2** — Phase 3. `selector` on Function and public StateVariable nodes,
 *   `slot`/`offset` on StateVariable, and `generator.compilers`. All optional
 *   and all absent without build artifacts, so a v1 and a v2 graph of the same
 *   uncompiled project differ only in this number — but a v1 *reader* would
 *   strip the new fields silently, which is the direction the version exists to
 *   refuse.
 * - **3** — Phase 4. §10's four analysis fields on Function nodes
 *   (`externallyReachable`, `entrypoints`, `accessControl`, `reentrancy`) and
 *   `flags.checksSender`. All defaulted, so an uncompiled project's graph gains
 *   only the lines where the analysis found something — but a v2 reader would
 *   drop them silently, and the whole point of the attack-surface and
 *   access-control overlays is that they are there.
 * - **4** — Phase 6. `generator.settings`: the §13 configuration that decided
 *   what is *in* this graph. Absent for a project with no config, so an
 *   uncompiled project's graph gains one number and nothing else — but without
 *   it, a stored artifact built with `exclude` or `--no-enrich` is
 *   indistinguishable from one built without, and `axiomap query` will happily
 *   answer a question about a guard list it was not built with. The version
 *   exists to refuse exactly that kind of silent mismatch.
 */
export const GRAPH_SCHEMA_VERSION = 4;

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

/**
 * Fields carrying a default are **omitted when they hold it**, and zod fills
 * them back in on read. At 200k SLOC that is a third of the artifact, and it
 * also makes a golden diff readable: a function node lists the flags that are
 * true rather than ten booleans of which eight are noise.
 *
 * The round-trip test in `graph.test.ts` asserts `parse(serialize(g))` deep-
 * equals `g` for every fixture, which is what stops the serializer and this
 * schema from drifting apart and losing data silently.
 */
export const paramSchema = z.object({
  name: z.string().nullable(),
  type: z.string(),
  /** Events only, but part of the ABI, so a change here is breaking. */
  indexed: z.boolean().default(false),
  storageLocation: z.enum(['memory', 'storage', 'calldata']).nullable().default(null),
});

export const functionFlagsSchema = z.object({
  hasAssembly: z.boolean().default(false),
  hasDelegatecall: z.boolean().default(false),
  hasLowLevelCall: z.boolean().default(false),
  hasSelfdestruct: z.boolean().default(false),
  hasCreate: z.boolean().default(false),
  sendsValue: z.boolean().default(false),
  hasUnchecked: z.boolean().default(false),
  hasTryCatch: z.boolean().default(false),
  readsState: z.boolean().default(false),
  writesState: z.boolean().default(false),
  /**
   * `msg.sender` or `tx.origin` compared with `==`/`!=` in the body. Not in
   * §10's list; it is the syntactic evidence behind `accessControl.confidence`
   * of `low`, recorded at parse because the resolver drops `require` as a
   * builtin and so no edge carries it. See `parse/interface.ts`.
   */
  checksSender: z.boolean().default(false),
});

/**
 * §11's access-control overlay, computed by `analysis/access-control.ts`.
 *
 * `high` means a modifier whose name is in the configured list (§13's
 * `accessControlModifiers`) — the tool recognises the guard. `low` means there
 * is evidence of an authorization check that is not a recognised modifier: an
 * inline comparison against `msg.sender`, or an unrecognised modifier that
 * makes one. `none` means neither was found, which is the finding §15's third
 * definition-of-done item asks for and not a claim that the function is
 * unguarded.
 */
export const accessControlSchema = z.object({
  /** Applied modifiers that are evidence of a guard, by name. */
  modifiers: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'low', 'none']).default('none'),
});

/**
 * §11's reentrancy surface, computed by `analysis/external-calls.ts`.
 *
 * A highlighter, not a detector (§11's own words). `externalCallThenWrite`
 * means a call leaving this contract is followed, by byte offset in this body,
 * by a write to storage — the shape, not the vulnerability.
 */
export const reentrancySchema = z.object({
  externalCallThenWrite: z.boolean().default(false),
  /** A modifier from §13's `reentrancyGuards` is applied. */
  guarded: z.boolean().default(false),
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
  /** `0x`-prefixed, semantic tier only (§10). Externally callable functions. */
  selector: z.string().optional(),
  bodyHash: z.string(),
  interfaceHash: z.string(),
  metrics: functionMetricsSchema,
  flags: functionFlagsSchema,

  // --- computed in Phase 4 (§10) ----------------------------------------
  /**
   * Reachable from an external entrypoint over the call edges this graph has.
   * In structural mode there are none, so this is true for entrypoints and
   * false for everything else — which is the honest answer for a graph with no
   * call edges, and `mode` is how a consumer knows that is why.
   */
  externallyReachable: z.boolean().default(false),
  /** Every entrypoint this function is reachable from, sorted. */
  entrypoints: z.array(z.string()).default([]),
  accessControl: accessControlSchema.default({ modifiers: [], confidence: 'none' }),
  reentrancy: reentrancySchema.default({ externalCallThenWrite: false, guarded: false }),
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
  /** Semantic tier only (§10). A public variable's getter has a selector too. */
  selector: z.string().optional(),
  /**
   * Storage slot, decimal, as a string — a slot is a uint256. Absent rather
   * than null when the compiler did not report a layout: `"0"` is a fact and
   * the absence of a slot is not one, and §16's storage-collision work needs to
   * tell them apart.
   */
  slot: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
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

/**
 * Why a name could not be bound, as a closed set.
 *
 * The category is part of the node's id (`?low-level:call`), not just an
 * attribute, because the id is what makes two placeholders the same node. Keyed
 * on the bare name alone, an unresolvable `.call` and an ordinary missing
 * function that happened to be called `call` would collapse onto one node
 * carrying one explanation — and `call` is a common enough function name that
 * this is a matter of when, not if.
 *
 * A closed set rather than the prose `reason` so that §16's "instrument *why*
 * edges are unresolved" is a count over categories, and so §15's CI query can
 * fail on a new `?low-level:*` while ignoring churn elsewhere.
 */
export const unresolvedCategorySchema = z.enum([
  /** `.call` / `.delegatecall` / `.send` / `.transfer` — target chosen at runtime. */
  'low-level',
  /** Called through a function pointer or a local value. */
  'function-pointer',
  /** The receiver is an expression with no syntactically declared type. */
  'dynamic-receiver',
  /** A member on a known non-contract type with no `using`-for attachment. */
  'unattached-member',
  /** The name is not declared anywhere the file can see. */
  'not-found',
]);

export const unresolvedNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal('Unresolved'),
  synthetic: z.literal(true),
  category: unresolvedCategorySchema,
  /** The human-readable form of `category`, with the specifics filled in. */
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
  /**
   * First call site. §10: clicking the edge lands *at the call*.
   *
   * Always `sites[0]`, so it is **not written to disk** — `serialize.ts` drops
   * it and `parseGraph` restores it through `storedGraphEdgeSchema` below. It
   * stays required on the type because §10 requires every edge to carry one.
   * `id` is kept on disk by contrast: it is identity rather than an alias, and
   * a public artifact people script against should not have to rebuild the
   * primary key before it can join on anything.
   */
  src: sourceRefSchema,
  sites: z.array(sourceRefSchema).nonempty(),
  count: z.number().int().positive(),
  /** Virtual dispatch and interface calls fan out to these. */
  possibleTargets: z.array(z.string()),
  crossTrustBoundary: z.boolean().optional(),
  linearizationIndex: z.number().int().nonnegative().optional(),
  /** Present on ambiguous and unresolved edges. */
  reason: z.string().optional(),
});

/**
 * The on-disk form of an edge: `src` absent, restored from `sites[0]`. The
 * transform's output is structurally identical to `graphEdgeSchema`'s, which is
 * what lets one `GraphEdge` type serve both.
 */
export const storedGraphEdgeSchema = graphEdgeSchema
  .extend({ src: sourceRefSchema.optional() })
  .transform((edge) => ({ ...edge, src: edge.src ?? edge.sites[0] }));

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

/**
 * The §13 settings that decided what is in this graph.
 *
 * Only the fields that change the graph's *content* — `renderCap` and `layout`
 * are the renderer's and are deliberately absent, so changing your layout
 * preference does not invalidate a stored artifact.
 *
 * Every field is optional and omitted when unset, so a project with no config
 * writes no `settings` block at all. That is what keeps the four uncompiled
 * goldens identical to their v3 form apart from `schemaVersion`.
 */
export const graphSettingsSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  entrypoints: z.array(z.string()).optional(),
  accessControlModifiers: z.array(z.string()).optional(),
  reentrancyGuards: z.array(z.string()).optional(),
  trustBoundaries: z.array(z.string()).optional(),
  /**
   * Recorded only when the semantic tier was disabled deliberately
   * (`--no-enrich`). `generator.compilers` says whether artifacts were *read*;
   * it cannot say whether they were declined, and the difference decides
   * whether a stored graph answers the question being asked of it.
   */
  enrich: z.literal(false).optional(),
});

export type GraphSettings = z.infer<typeof graphSettingsSchema>;

export const graphFileSchema = z.object({
  schemaVersion: z.literal(GRAPH_SCHEMA_VERSION),
  generator: z.object({
    name: z.literal('axiomap'),
    parser: z.string(),
    /** Bumping this invalidates stored review state; see `hash.ts`. */
    hashVersion: z.number().int().positive(),
    /**
     * solc versions whose build artifacts were read, empty when none were.
     * §4 requires a project to be able to mix them, so this is a list; it is
     * also the honest answer to "how much of this graph did a compiler see".
     */
    compilers: z.array(z.string()).default([]),
    /** §13's graph-affecting settings; absent when the project has no config. */
    settings: graphSettingsSchema.optional(),
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
  edges: z.array(storedGraphEdgeSchema),
});

export type SourceRefRecord = z.infer<typeof sourceRefSchema>;
export type NodeKind = z.infer<typeof nodeKindSchema>;
export type EdgeKind = z.infer<typeof edgeKindSchema>;
export type CallSubkind = z.infer<typeof callSubkindSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type ContractNode = z.infer<typeof contractNodeSchema>;
export type FunctionNode = z.infer<typeof functionNodeSchema>;
/** Named for the same reason as the two above: a consumer narrowing on `kind`. */
export type StateVariableNode = z.infer<typeof stateVariableNodeSchema>;
export type UnresolvedNode = z.infer<typeof unresolvedNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type AccessControl = z.infer<typeof accessControlSchema>;
export type Reentrancy = z.infer<typeof reentrancySchema>;
export type UnresolvedCategory = z.infer<typeof unresolvedCategorySchema>;
export type Param = z.infer<typeof paramSchema>;
export type ResolutionCounts = z.infer<typeof resolutionCountsSchema>;
export type ResolutionScore = z.infer<typeof resolutionScoreSchema>;
export type GraphMode = z.infer<typeof graphModeSchema>;
export type GraphDiagnostic = z.infer<typeof graphDiagnosticSchema>;
export type GraphFile = z.infer<typeof graphFileSchema>;

/** Edges that did not require resolving a name, and so do not affect the score. */
export const STRUCTURAL_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['declares']);

/** Edges the call graph is made of. Structural mode drops exactly these. */
export const CALL_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['calls', 'creates']);
