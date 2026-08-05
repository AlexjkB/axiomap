/**
 * `@axiomap/cli`'s programmatic surface.
 *
 * Every command is a function returning `{ text, exitCode }` rather than one
 * that writes and exits, so the whole surface is testable without spawning a
 * process — `bin.ts` is the only file that touches `process`. Phase 5
 * established the shape with `runDiff` and its exit-criterion test; Phase 6
 * keeps it for all eight commands.
 */

export {
  DIFF_JSON_SCHEMA_VERSION,
  runDiff,
  type DiffCommandOptions,
  type DiffCommandResult,
} from './commands/diff.js';
export { runBuild, renderDiagnostics, type BuildResult } from './commands/build.js';
export { runStats, type StatsResult } from './commands/stats.js';
export { runQuery, type QueryOptions, type QueryResult } from './commands/query.js';
export { runExport, type ExportOptions, type ExportResult } from './commands/export.js';
export {
  runReview,
  REVIEW_STATUSES,
  type ReviewOptions,
  type ReviewResult,
} from './commands/review.js';
export { runImportFindings, type ImportFindingsResult } from './commands/import-findings.js';

export { resolveRevision, RevisionError, type Revision } from './revisions.js';
export {
  analysisOptions,
  buildAndWrite,
  buildOptions,
  GRAPH_FILE,
  loadGraph,
  openProject,
  type CommonOptions,
  type LoadedGraph,
  type ProjectContext,
} from './context.js';
export { TEXT_FORMATS, toDot, toJson, toMermaid, type TextFormat } from './export/formats.js';
export * from './output.js';
