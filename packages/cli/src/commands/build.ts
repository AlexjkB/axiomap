/**
 * `axiomap build [path]` (§12) — the graph, on disk, with the score printed.
 *
 * §4 requires the resolution score on every build and is emphatic about why:
 * "Ingest reports a resolution score per project ... Print it on every build."
 * The mode line beside it is the other half — §4's three degradation modes are
 * designed states with their own copy, and `modeReason` is written to be shown
 * verbatim rather than paraphrased here.
 */

import {
  describeScore,
  type GraphDiagnostic,
  type GraphFile,
} from '@axiomap/core';

import { buildAndWrite, openProject, type CommonOptions } from '../context.js';
import { colour, definitions, heading, json, paintMode, table } from '../output.js';

export interface BuildResult {
  text: string;
  exitCode: number;
  file: GraphFile;
}

function severityRank(severity: GraphDiagnostic['severity']): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

export function renderDiagnostics(diagnostics: readonly GraphDiagnostic[]): string {
  if (diagnostics.length === 0) return '';
  const sorted = [...diagnostics].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.message.localeCompare(b.message),
  );
  return (
    `\n${heading(`diagnostics (${String(sorted.length)})`)}` +
    table(sorted, [
      {
        header: 'severity',
        get: (d) => d.severity,
        paint: (value, d) =>
          d.severity === 'error'
            ? colour.red(value)
            : d.severity === 'warning'
              ? colour.yellow(value)
              : colour.dim(value),
      },
      { header: 'message', get: (d) => d.message },
    ])
  );
}

export async function runBuild(options: CommonOptions = {}): Promise<BuildResult> {
  const context = openProject(options);
  const { file, files, artifact } = await buildAndWrite(context, options);

  if (options.json === true) {
    return {
      text: json({
        artifact,
        project: file.project,
        mode: file.mode,
        modeReason: file.modeReason,
        score: file.score,
        generator: file.generator,
        diagnostics: file.diagnostics,
        configFile: context.configFile,
      }),
      exitCode: 0,
      file,
    };
  }

  const lines: string[] = [];
  lines.push(
    definitions([
      ['project', `${context.root} (${file.project.kind})`],
      ['config', context.configFile ?? 'none (AXIOMAP.md §13 defaults)'],
      ['files', `${String(files.length)} .sol`],
      ['graph', artifact],
      ['mode', paintMode(file.mode, file.mode)],
      // §4's own words, shown rather than summarised.
      ['', colour.dim(file.modeReason)],
      ['resolution', describeScore(file)],
      [
        'compilers',
        file.generator.compilers.length === 0
          ? colour.dim('none — no build artifacts were read')
          : file.generator.compilers.join(', '),
      ],
    ]),
  );

  for (const warning of context.warnings) lines.push(colour.yellow(warning));
  const diagnostics = renderDiagnostics(file.diagnostics);
  if (diagnostics !== '') lines.push(diagnostics.replace(/\n$/, ''));

  return { text: `${lines.join('\n')}\n`, exitCode: 0, file };
}
