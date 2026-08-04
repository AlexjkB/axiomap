import { AXIOMAP_DIR } from '@axiomap/core';

export {
  DIFF_JSON_SCHEMA_VERSION,
  runDiff,
  type DiffCommandOptions,
  type DiffCommandResult,
} from './commands/diff.js';
export { resolveRevision, RevisionError, type Revision } from './revisions.js';

/** Placeholder until Phase 6 builds the real command surface (AXIOMAP.md §12). */
export function describe(): string {
  return `axiomap writes its artifacts to ${AXIOMAP_DIR}/`;
}

export const USAGE = `axiomap — Solidity protocol visualizer

Phase 5 ships one command; the rest arrive in Phase 6 (AXIOMAP.md §12).

  axiomap diff <refA> <refB> [path] [--json]

    Diff two revisions of a project. Each ref is a git revision or a directory
    path; [path] is the project to graph, default the current directory.
    Exits 1 when anything changed, so it works as a CI gate.
`;
