/**
 * `axiomap diff <refA> <refB> [path]` (§12).
 *
 * Phase 5's exit criterion is this command run between two commits of the
 * `defi/` fixture, so it ships here rather than waiting for Phase 6's full
 * command surface. It is deliberately the whole command and nothing else: no
 * argument-parsing framework, no colour, no other subcommands. Phase 6 owns
 * those, and adding half of each now would be the same mistake as building the
 * UI early.
 *
 * Both revisions are graphed with the analysis passes on, because three of
 * §8's findings are comparisons of Phase 4 fields. Neither is written to disk —
 * a diff is a question about two revisions, not a build of either.
 *
 * ### One config, applied to both sides
 *
 * §13's `accessControlModifiers` and `reentrancyGuards` are inputs to the
 * analysis passes, and `accessControl` is one of the attributes the diff
 * compares. So a revision that renamed its guard modifier in
 * `axiomap.config.json` — and nothing else — would otherwise produce an
 * `access-control-weakened` finding on every function using it.
 *
 * Both revisions are therefore analysed with **one** configuration, and
 * §13 fixes which one: the invoking working tree's. Reading each checkout's own
 * config would make the tool's own settings part of the changeset, and the
 * question `axiomap diff` answers is what changed in the *protocol*.
 *
 * Phase 6 implements it: `openProject` loads the config from the target
 * directory as it stands now, and the same `buildOptions` object is handed to
 * both `buildProjectGraph` calls below. The checked-out revisions have their
 * own `axiomap.config.json` on disk and it is deliberately never read.
 */

import {
  buildProjectGraph,
  diffGraphs,
  migrateReview,
  readReview,
  reviewPath,
  writeReview,
  type AxiomapDiff,
  type ChangeStatus,
  type DiffFinding,
  type NodeChange,
} from '@axiomap/core';

import { buildOptions, openProject, type CommonOptions } from '../context.js';
import { resolveRevision } from '../revisions.js';

/**
 * The version of the `--json` shape below.
 *
 * §3 gives `graph.json` a `schemaVersion` from day one because it is a public
 * artifact people script against, and §15's eighth item makes this output
 * exactly that: `axiomap query unresolved --json` in CI, failing a build on
 * what changed. The argument is the same and so is the field. Adding it now
 * costs a line; adding it once people have parsers pointed at this is a
 * breaking change to somebody's pipeline.
 *
 * Bump on any change to the shape that a consumer could notice.
 */
export const DIFF_JSON_SCHEMA_VERSION = 1;

export interface DiffCommandOptions extends CommonOptions {
  /**
   * Project to diff. Default: the current directory.
   *
   * Kept alongside `CommonOptions.path`, which means the same thing, because
   * Phase 5 shipped this name and `packages/cli/test/diff.test.ts` — the Phase
   * 5 exit criterion — is written against it. `path` wins when both are given.
   */
  target?: string;
  /** Update `.axiomap/review.json` to follow renames and moves (§8). */
  updateReview?: boolean;
}

export interface DiffCommandResult {
  text: string;
  /**
   * Non-zero when anything changed, so `axiomap diff` is usable as a CI gate
   * the way §15's eighth item asks for.
   */
  exitCode: number;
  diff: AxiomapDiff;
}

const STATUS_ORDER: ChangeStatus[] = ['removed', 'added', 'renamed', 'moved', 'modified'];

function describeChange(change: NodeChange): string {
  const from = change.match !== null && change.match.before !== change.match.after
    ? `${change.match.before} → `
    : '';
  const tier =
    change.match !== null && change.match.tier !== 'exact'
      ? `  [${change.match.tier} ${change.match.confidence}]`
      : '';
  const what = change.changes.length === 0 ? '' : `  {${change.changes.join(', ')}}`;
  return `  ${change.status.padEnd(8)} ${change.kind.padEnd(14)} ${from}${change.id}${what}${tier}`;
}

function describeFinding(finding: DiffFinding): string {
  const evidence = finding.evidence === 'consequence' ? ' (consequence)' : '';
  return `  ${finding.severity.padEnd(6)} ${finding.kind.padEnd(28)} ${finding.message}${evidence}`;
}

function render(diff: AxiomapDiff, before: string, after: string, target: string): string {
  const lines: string[] = [];
  lines.push(`axiomap diff  ${before} → ${after}   (${target})`, '');

  const n = diff.nodeSummary;
  lines.push(
    `nodes  ${n.added} added · ${n.removed} removed · ${n.modified} modified · ` +
      `${n.moved} moved · ${n.renamed} renamed · ${n.unchanged} unchanged`,
  );
  const e = diff.edgeSummary;
  lines.push(
    `edges  ${e.added} added · ${e.removed} removed · ${e.modified} modified · ${e.unchanged} unchanged`,
    '',
  );

  if (diff.findings.length === 0) {
    lines.push('findings  none', '');
  } else {
    lines.push(`findings (${diff.findings.length})`);
    for (const finding of diff.findings) lines.push(describeFinding(finding));
    lines.push('');
  }

  const changed = diff.nodes.filter((node) => node.status !== 'unchanged');
  if (changed.length === 0) {
    lines.push('changes  none');
  } else {
    lines.push(`changes (${changed.length})`);
    const rank = (status: ChangeStatus): number => STATUS_ORDER.indexOf(status);
    for (const change of [...changed].sort(
      (a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id),
    )) {
      lines.push(describeChange(change));
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The `--json` shape, and it is deliberately not the whole diff.
 *
 * A `GraphDiff` holds every node object from both graphs; emitting it would
 * make the output larger than either `graph.json`. What a script wants is the
 * findings and the change list, so that is what this is — and it is a stable
 * surface people can pipe into `jq` without reading the schema.
 */
function toJson(diff: AxiomapDiff, before: string, after: string, target: string): unknown {
  return {
    schemaVersion: DIFF_JSON_SCHEMA_VERSION,
    before,
    after,
    target,
    nodeSummary: diff.nodeSummary,
    edgeSummary: diff.edgeSummary,
    findings: diff.findings,
    changes: diff.nodes
      .filter((node) => node.status !== 'unchanged')
      .map((node) => ({
        status: node.status,
        kind: node.kind,
        id: node.id,
        ...(node.match === null || node.match.before === node.match.after
          ? {}
          : { previousId: node.match.before }),
        ...(node.match === null || node.match.tier === 'exact'
          ? {}
          : { matchTier: node.match.tier, matchConfidence: node.match.confidence }),
        changes: node.changes,
      })),
  };
}

/**
 * §8's review migration, wired to the command that produces a matching.
 *
 * A renamed or moved function has not been un-reviewed, so its review follows
 * it; a body that changed on the way comes out remapped *and* stale, which puts
 * it on the re-review list for the right reason. `migrateReview` keeps an entry
 * it could not match under its old id rather than deleting it — the note is the
 * auditor's, not the matcher's.
 */
function migrate(root: string, diff: AxiomapDiff): string {
  const file = reviewPath(root);
  const state = readReview(file);
  if (Object.keys(state).length === 0) {
    return 'review  no review state to migrate';
  }

  const migration = migrateReview(state, diff.matching);
  writeReview(file, migration.state);
  return (
    `review  ${String(migration.remapped.length)} entries followed a rename or move, ` +
    `${String(migration.dropped.length)} kept under an unmatched id → ${file}`
  );
}

export async function runDiff(
  refA: string,
  refB: string,
  options: DiffCommandOptions = {},
): Promise<DiffCommandResult> {
  const target = options.path ?? options.target ?? process.cwd();

  // §13: one config governs both revisions, and it is this working tree's.
  const context = openProject({ ...options, path: target });
  const shared = buildOptions(context, options);

  const before = resolveRevision(refA, target);
  try {
    const after = resolveRevision(refB, target);
    try {
      const [a, b] = await Promise.all([
        buildProjectGraph(before.root, { ...shared, cacheDir: null }),
        buildProjectGraph(after.root, { ...shared, cacheDir: null }),
      ]);
      const diff = diffGraphs(a.graph, b.graph);
      const changed =
        diff.nodes.some((node) => node.status !== 'unchanged') ||
        diff.edges.some((edge) => edge.status !== 'unchanged');

      const migrated = options.updateReview === true ? migrate(context.root, diff) : null;

      const text =
        options.json === true
          ? `${JSON.stringify(toJson(diff, before.label, after.label, target), null, 2)}\n`
          : render(diff, before.label, after.label, target) +
            (migrated === null ? '' : `\n${migrated}\n`);
      return { text, exitCode: changed ? 1 : 0, diff };
    } finally {
      after.dispose();
    }
  } finally {
    before.dispose();
  }
}
