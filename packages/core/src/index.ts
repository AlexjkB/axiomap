export {
  AXIOMAP_DIR,
  AXIOMAP_GITIGNORE,
  ensureAxiomapDir,
  type EnsureAxiomapDirResult,
} from './project/axiomap-dir.js';

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

export * from './symbols/index.js';

export { ingestProject, type IngestOptions, type IngestResult } from './ingest.js';
