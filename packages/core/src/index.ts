export {
  AXIOMAP_DIR,
  AXIOMAP_GITIGNORE,
  ensureAxiomapDir,
  type EnsureAxiomapDirResult,
} from './project/axiomap-dir.js';

export { configureRuntime, runtimeAssets, type RuntimeAssets } from './runtime.js';

export * from './parse/index.js';
export { ParseCache, PARSE_SCHEMA_VERSION, getHasher, type ParseCacheStats } from './parse/cache.js';
export {
  parseFiles,
  type ParsePoolOptions,
  type ParseRun,
  type ParseRunStats,
} from './parse/workers.js';

export {
  detectProject,
  listSolidityFiles,
  type DetectedProject,
  type ProjectDiagnostic,
  type ProjectKind,
} from './project/detect.js';
export {
  describeUnresolvedImport,
  ImportResolver,
  type ResolvedImport,
} from './project/imports.js';
export {
  applyRemappings,
  parseRemappings,
  sortRemappings,
  type Remapping,
} from './project/remappings.js';
export { readFoundryConfig, type FoundryConfig } from './project/foundry.js';
export { readHardhatConfig, type HardhatConfig } from './project/hardhat.js';
export {
  axiomapConfigSchema,
  CONFIG_FILE,
  ConfigError,
  loadConfig,
  parseConfig,
  type AxiomapConfig,
  type LoadedConfig,
} from './project/config.js';
export { globToRegExp, matchesAny, pathFilter, type PathFilter } from './project/globs.js';
export {
  analysisOptions,
  buildOptions,
  GRAPH_FILE,
  loadProjectGraph,
  newestInput,
  openProject,
  type LoadedGraph,
  type ProjectContext,
  type SessionHooks,
  type SessionOptions,
} from './project/session.js';
export { readOverlayFiles, type OverlayFiles } from './project/overlay-sources.js';

export * from './symbols/index.js';

export * from './graph/index.js';
export * from './analysis/index.js';
export {
  resolveProject,
  ProjectScope,
  type EdgeDraft,
  type Linearization,
  type ResolveResult,
  type UnresolvedTarget,
} from './resolve/index.js';

export * from './diff/index.js';
export * from './review/index.js';
export * from './query/index.js';
export * from './source/index.js';
export * from './findings/index.js';

export {
  buildInfoDirectories,
  discoverBuildInfo,
  loadSemanticOverlay,
  readBuildInfo,
  type BuildInfo,
  type LoadSemanticOverlayOptions,
  type SemanticOverlayLoad,
} from './enrich/index.js';

export {
  buildProjectGraph,
  effectiveSettings,
  ingestProject,
  type BuildProjectGraphOptions,
  type IngestOptions,
  type IngestResult,
  type ProjectGraphResult,
} from './ingest.js';
