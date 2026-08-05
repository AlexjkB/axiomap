/**
 * `axiomap stats` (§12) — the first thing to run on an unfamiliar protocol.
 *
 * §15's definition of done opens with "run `axiomap` on an unfamiliar
 * 30-contract protocol that does not build, and within 60 seconds see which
 * contracts are real and which are scaffolding", and follows it with "see
 * honestly how much of the graph is certain vs. inferred". This command is
 * those two sentences, which is why it leads with the mode and the score rather
 * than with node counts.
 */

import { describeScore, graphStats, type GraphStats } from '@axiomap/core';

import { loadGraph, openProject, type CommonOptions } from '../context.js';
import { colour, definitions, heading, json, paintMode, table } from '../output.js';

export interface StatsResult {
  text: string;
  exitCode: number;
  stats: GraphStats;
}

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return colour.dim('none');
  return entries.map(([key, value]) => `${key} ${String(value)}`).join(' · ');
}

export async function runStats(options: CommonOptions = {}): Promise<StatsResult> {
  const context = openProject(options);
  const loaded = await loadGraph(context, options);
  const stats = graphStats(loaded.graph, loaded.file);

  if (options.json === true) {
    return { text: json(stats), exitCode: 0, stats };
  }

  const sections: string[] = [];

  sections.push(
    definitions([
      ['project', `${context.root} (${loaded.file.project.kind})`],
      ['source', loaded.origin === 'artifact' ? '.axiomap/graph.json' : 'freshly built'],
      ['files', String(stats.files)],
      ['mode', paintMode(stats.mode, stats.mode)],
      ['', colour.dim(stats.modeReason)],
      ['resolution', describeScore(loaded.file)],
    ]),
  );

  sections.push(
    `\n${heading('contracts')}` +
      definitions([
        ['total', String(stats.contracts.total)],
        ['by kind', counts(stats.contracts.byKind)],
        // §1's fourth question, and §15's first item.
        [
          'real / test / mock',
          `${colour.bold(String(stats.contracts.real))} · ${String(stats.contracts.test)} test · ${String(stats.contracts.mock)} mock`,
        ],
      ]),
  );

  const f = stats.functions;
  sections.push(
    `\n${heading('functions')}` +
      definitions([
        ['total', String(f.total)],
        ['externally callable', String(f.externallyCallable)],
        ['externally reachable', String(f.externallyReachable)],
        [
          'unguarded',
          // §15's third item. The wording is deliberate: `accessControl: none`
          // means no *recognised* guard (§10), and §13's list is what makes a
          // protocol's own spelling recognisable.
          f.unprotected === 0
            ? colour.green('0')
            : `${colour.red(String(f.unprotected))} state-mutating externals with no recognised guard  ${colour.dim('(axiomap query externals --unprotected)')}`,
        ],
        ['payable', String(f.payable)],
        [
          'danger ops',
          `assembly ${String(f.withAssembly)} · delegatecall ${String(f.withDelegatecall)} · low-level ${String(f.withLowLevelCall)}`,
        ],
        ['reentrancy shape', `${String(f.reentrancyShape)} ${colour.dim('(external call then state write; a highlighter, not a detector)')}`],
      ]),
  );

  sections.push(
    `\n${heading('graph')}` +
      definitions([
        ['nodes', counts(stats.nodesByKind)],
        ['edges', counts(stats.edgesByKind)],
        ['by resolution', counts(stats.edgesByResolution)],
      ]),
  );

  const unresolved = Object.entries(stats.unresolvedByCategory).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (unresolved.length > 0) {
    sections.push(
      `\n${heading('unresolved, by category')}` +
        table(unresolved, [
          { header: 'category', get: ([key]) => key },
          { header: 'nodes', get: ([, value]) => String(value), numeric: true },
        ]) +
        colour.dim('An unresolved edge is a correct answer (AXIOMAP.md §4). ') +
        colour.dim('See them with: axiomap query unresolved\n'),
    );
  }

  return { text: `${sections.join('')}`, exitCode: 0, stats };
}
