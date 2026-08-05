/**
 * `axiomap query <sub>` (§12) — the nine subcommands, in one file because they
 * are one command with nine shapes of answer.
 *
 * Every one of these is a thin renderer over `@axiomap/core`'s `query/` module
 * (§5: "the API both CLI and webview consume"). Nothing here computes anything
 * about the graph. That is not tidiness for its own sake — §7's Phase 7 builds
 * an inspector panel answering the same questions, and the moment a query's
 * logic lives in a CLI renderer, the panel gets a second implementation that
 * can disagree with this one.
 *
 * §15's eighth item is the reason `--json` is on all of them: "run
 * `axiomap query unresolved --json` in CI and fail the build on new unresolved
 * external calls".
 */

import {
  callPath,
  externals,
  readersOf,
  readFindings,
  findingsPath,
  readReview,
  requireNode,
  reviewPath,
  stalenessOf,
  traverse,
  unresolvedEdges,
  writersOf,
  type CallStep,
  type TraverseHit,
} from '@axiomap/core';

import { loadGraph, openProject, type CommonOptions } from '../context.js';
import {
  colour,
  count,
  definitions,
  heading,
  json,
  location,
  paintConfidence,
  paintResolution,
  table,
} from '../output.js';

export interface QueryResult {
  text: string;
  exitCode: number;
}

export interface QueryOptions extends CommonOptions {
  depth?: number;
  unprotected?: boolean;
  payable?: boolean;
}

/**
 * Exit codes. §15's eighth item makes this a CI gate, so "found nothing" and
 * "found something" have to be distinguishable without parsing the output.
 *
 * - 0 — the query ran and found nothing
 * - 1 — the query ran and found something
 * - 2 — the query could not run (bad node reference, unknown subcommand)
 *
 * `query externals` finding externals is not a failure in the moral sense, but
 * one exit code per outcome is what makes `axiomap query externals
 * --unprotected && echo clean` work, and every subcommand behaving the same way
 * is worth more than each one being individually clever.
 */
const FOUND = 1;
const EMPTY = 0;

function stepRow(step: CallStep): Record<string, string> {
  return {
    from: step.from,
    to: step.to,
    site: location(step.src),
    subkind: step.subkind ?? '',
    resolution: step.resolution,
    virtual: step.virtual ? 'possible-target' : '',
  };
}

function renderHits(hits: readonly TraverseHit[], singular: string): string {
  if (hits.length === 0) return colour.dim(`No ${singular}s.\n`);

  return (
    heading(count(hits.length, singular)) +
    table(hits, [
      { header: 'depth', get: (hit) => String(hit.depth), numeric: true },
      { header: 'node', get: (hit) => hit.id },
      {
        header: 'via',
        get: (hit) => {
          const last = hit.via[hit.via.length - 1];
          return last === undefined ? '' : location(last.src);
        },
      },
      {
        header: 'resolution',
        get: (hit) => {
          const last = hit.via[hit.via.length - 1];
          return last === undefined ? '' : last.resolution + (last.virtual ? ' (possible)' : '');
        },
        paint: (value, hit) => {
          const last = hit.via[hit.via.length - 1];
          return last === undefined ? value : paintResolution(value, last.resolution);
        },
      },
    ])
  );
}

export async function runQuery(
  subcommand: string,
  args: readonly string[],
  options: QueryOptions = {},
): Promise<QueryResult> {
  const context = openProject(options);
  const loaded = await loadGraph(context, options);
  const { graph } = loaded;
  const wantJson = options.json === true;
  const [first, second] = args;

  const needsNode = (value: string | undefined, what: string): string => {
    if (value === undefined) {
      throw new Error(`axiomap query ${subcommand} needs ${what}.`);
    }
    return value;
  };

  switch (subcommand) {
    case 'callers-of':
    case 'callees-of': {
      const node = requireNode(graph, needsNode(first, 'a node'));
      const direction = subcommand === 'callers-of' ? 'callers' : 'callees';
      // §12 gives these a `--depth`; the default is one hop, because the
      // unbounded downstream answer is `reachable-from` under another name.
      const hits = traverse(graph, node.id, direction, { depth: options.depth ?? 1 });
      if (wantJson) {
        return {
          text: json({ node: node.id, direction, depth: options.depth ?? 1, hits }),
          exitCode: hits.length > 0 ? FOUND : EMPTY,
        };
      }
      return {
        text:
          definitions([
            ['node', node.id],
            ['depth', String(options.depth ?? 1)],
          ]) +
          '\n' +
          renderHits(hits, direction === 'callers' ? 'caller' : 'callee'),
        exitCode: hits.length > 0 ? FOUND : EMPTY,
      };
    }

    case 'reachable-from': {
      const node = requireNode(graph, needsNode(first, 'a node'));
      const hits = traverse(graph, node.id, 'callees');
      if (wantJson) {
        return { text: json({ node: node.id, hits }), exitCode: hits.length > 0 ? FOUND : EMPTY };
      }
      return {
        text: definitions([['from', node.id]]) + '\n' + renderHits(hits, 'reachable function'),
        exitCode: hits.length > 0 ? FOUND : EMPTY,
      };
    }

    case 'path': {
      const from = requireNode(graph, needsNode(first, 'a source node'));
      const to = requireNode(graph, needsNode(second, 'a target node'));
      const steps = callPath(graph, from.id, to.id);
      if (wantJson) {
        return {
          text: json({ from: from.id, to: to.id, found: steps !== null, path: steps ?? [] }),
          exitCode: steps === null ? EMPTY : FOUND,
        };
      }
      if (steps === null) {
        return {
          text:
            colour.dim(
              `No call path from ${from.id} to ${to.id} over the edges this graph has ` +
                `(mode: ${loaded.file.mode}).\n`,
            ),
          exitCode: EMPTY,
        };
      }
      return {
        text:
          heading(count(steps.length, 'hop')) +
          table(steps.map(stepRow), [
            { header: 'from', get: (row) => row['from'] ?? '' },
            { header: 'to', get: (row) => row['to'] ?? '' },
            { header: 'site', get: (row) => row['site'] ?? '' },
            {
              header: 'resolution',
              get: (row) => row['resolution'] ?? '',
              paint: (value, row) => paintResolution(value, row['resolution'] ?? ''),
            },
            { header: '', get: (row) => row['virtual'] ?? '' },
          ]),
        exitCode: FOUND,
      };
    }

    case 'writers-of':
    case 'readers-of': {
      const node = requireNode(graph, needsNode(first, 'a state variable'), {
        kinds: ['StateVariable'],
      });
      const rows =
        subcommand === 'writers-of' ? writersOf(graph, node.id) : readersOf(graph, node.id);
      if (wantJson) {
        return {
          text: json({ variable: node.id, accessors: rows }),
          exitCode: rows.length > 0 ? FOUND : EMPTY,
        };
      }
      return {
        text:
          definitions([['variable', node.id]]) +
          '\n' +
          (rows.length === 0
            ? colour.dim(`No ${subcommand === 'writers-of' ? 'writers' : 'readers'}.\n`)
            : heading(count(rows.length, subcommand === 'writers-of' ? 'writer' : 'reader')) +
              table(rows, [
                { header: 'function', get: (row) => row.function },
                { header: 'vis', get: (row) => row.visibility },
                { header: 'reachable', get: (row) => (row.externallyReachable ? 'yes' : 'no') },
                {
                  header: 'guard',
                  get: (row) =>
                    row.accessControl.confidence === 'none'
                      ? 'none'
                      : `${row.accessControl.confidence}${row.accessControl.modifiers.length === 0 ? '' : ` (${row.accessControl.modifiers.join(', ')})`}`,
                  paint: (value, row) => paintConfidence(value, row.accessControl.confidence),
                },
                { header: 'sites', get: (row) => String(row.count), numeric: true },
                {
                  header: 'at',
                  get: (row) => (row.sites[0] === undefined ? '' : location(row.sites[0])),
                },
              ])),
        exitCode: rows.length > 0 ? FOUND : EMPTY,
      };
    }

    case 'externals': {
      const rows = externals(graph, {
        ...(options.unprotected === true ? { unprotected: true } : {}),
        ...(options.payable === true ? { payable: true } : {}),
      });
      if (wantJson) {
        return { text: json({ externals: rows }), exitCode: rows.length > 0 ? FOUND : EMPTY };
      }
      if (rows.length === 0) {
        return { text: colour.dim('No matching external functions.\n'), exitCode: EMPTY };
      }
      return {
        text:
          heading(
            count(rows.length, 'external function') +
              (options.unprotected === true ? ' with no recognised guard' : '') +
              (options.payable === true ? ', payable' : ''),
          ) +
          table(rows, [
            { header: 'function', get: (row) => row.id },
            { header: 'vis', get: (row) => row.visibility },
            { header: 'mutability', get: (row) => row.stateMutability },
            {
              header: 'guard',
              get: (row) =>
                row.accessControl.confidence === 'none'
                  ? 'none'
                  : `${row.accessControl.confidence}${row.accessControl.modifiers.length === 0 ? '' : ` (${row.accessControl.modifiers.join(', ')})`}`,
              paint: (value, row) => paintConfidence(value, row.accessControl.confidence),
            },
            {
              header: 'flags',
              get: (row) =>
                [
                  row.flags.hasAssembly ? 'asm' : '',
                  row.flags.hasDelegatecall ? 'delegatecall' : '',
                  row.flags.hasLowLevelCall ? 'lowlevel' : '',
                  row.flags.hasSelfdestruct ? 'selfdestruct' : '',
                  row.reentrancy.externalCallThenWrite
                    ? row.reentrancy.guarded
                      ? 'reentrancy(guarded)'
                      : 'reentrancy'
                    : '',
                ]
                  .filter((flag) => flag !== '')
                  .join(' '),
            },
            { header: 'at', get: (row) => location(row.src) },
          ]) +
          (options.unprotected === true
            ? colour.dim(
                '\n"none" means no guard this tool recognises (AXIOMAP.md §10), not that the ' +
                  'function is unguarded.\nTeach it your protocol\'s spelling with ' +
                  'accessControlModifiers in axiomap.config.json.\n',
              )
            : ''),
        exitCode: FOUND,
      };
    }

    case 'unresolved': {
      const rows = unresolvedEdges(graph);
      if (wantJson) {
        return { text: json({ unresolved: rows }), exitCode: rows.length > 0 ? FOUND : EMPTY };
      }
      if (rows.length === 0) {
        return { text: colour.dim('Nothing unresolved.\n'), exitCode: EMPTY };
      }
      return {
        text:
          heading(count(rows.length, 'unresolved edge')) +
          table(rows, [
            { header: 'category', get: (row) => row.category, paint: (v) => colour.yellow(v) },
            { header: 'from', get: (row) => row.from },
            { header: 'callee', get: (row) => row.callee },
            { header: 'sites', get: (row) => String(row.count), numeric: true },
            {
              header: 'at',
              get: (row) => (row.sites[0] === undefined ? '' : location(row.sites[0])),
            },
            { header: 'why', get: (row) => row.reason },
          ]) +
          colour.dim(
            '\nAn unresolved edge is a correct answer, not a failure (AXIOMAP.md §4).\n',
          ),
        exitCode: FOUND,
      };
    }

    case 'stale-reviews': {
      const state = readReview(reviewPath(context.root));
      const reports = stalenessOf(state, graph).filter((row) => row.staleness !== 'current');
      if (wantJson) {
        return {
          text: json({ reviews: Object.keys(state).length, stale: reports }),
          exitCode: reports.length > 0 ? FOUND : EMPTY,
        };
      }
      if (Object.keys(state).length === 0) {
        return {
          text: colour.dim(
            'No review state yet. Record some with: axiomap review <node> --status reviewed\n',
          ),
          exitCode: EMPTY,
        };
      }
      if (reports.length === 0) {
        return {
          text: colour.green(
            `All ${String(Object.keys(state).length)} reviews are current.\n`,
          ),
          exitCode: EMPTY,
        };
      }
      return {
        text:
          // §8: this is the flagship feature — "here is exactly what you must
          // look at again in v2".
          heading(
            `${count(reports.length, 'review')} ${reports.length === 1 ? 'needs' : 'need'} attention`,
          ) +
          table(reports, [
            {
              header: 'state',
              get: (row) => row.staleness,
              paint: (value, row) =>
                row.staleness === 'stale' ? colour.yellow(value) : colour.red(value),
            },
            { header: 'node', get: (row) => row.node },
            { header: 'status', get: (row) => row.entry.status },
            { header: 'reviewer', get: (row) => row.entry.reviewer ?? '' },
            { header: 'at', get: (row) => row.entry.at },
          ]) +
          colour.dim(
            '\nstale = the body changed since it was reviewed. ' +
              'orphaned = nothing in the graph has that id any more;\n' +
              'axiomap diff can usually say where it went.\n',
          ),
        exitCode: FOUND,
      };
    }

    case 'findings': {
      // Not in §12's list, but `import-findings` writes a file and a user is
      // entitled to read it back without opening JSON by hand.
      const stored = readFindings(findingsPath(context.root));
      const rows = stored?.findings ?? [];
      if (wantJson) {
        return { text: json(stored ?? { findings: [] }), exitCode: rows.length > 0 ? FOUND : EMPTY };
      }
      if (stored === null) {
        return {
          text: colour.dim(
            'No imported findings. Import some with: axiomap import-findings <slither.json>\n',
          ),
          exitCode: EMPTY,
        };
      }
      return {
        text:
          definitions([
            ['source', `${stored.source.tool} — ${stored.source.file}`],
            ['imported', stored.source.at],
          ]) +
          '\n' +
          table(rows, [
            { header: 'impact', get: (row) => row.impact },
            { header: 'check', get: (row) => row.check },
            { header: 'nodes', get: (row) => row.nodes.join(', ') },
          ]),
        exitCode: rows.length > 0 ? FOUND : EMPTY,
      };
    }

    default:
      throw new Error(
        `Unknown query "${subcommand}". Available: callers-of, callees-of, reachable-from, ` +
          'path, writers-of, readers-of, externals, unresolved, stale-reviews, findings.',
      );
  }
}
