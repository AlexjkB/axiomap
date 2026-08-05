/**
 * `axiomap import-findings <slither.json>` (§12).
 *
 * Decision #4's positive half. Axiomap does not depend on Slither and does not
 * invoke it — §2's reasoning is that Slither needs a successful compile, which
 * is unavailable in exactly the case decision #1 exists for — but Slither's
 * detectors are valuable and the auditor is already running them. This maps
 * their output onto graph nodes so §11's imported-findings overlay has
 * something to draw and `axiomap query findings` has something to list.
 *
 * The mapping itself, and why it joins on byte offsets rather than names, is in
 * `core/src/findings/slither.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  ensureAxiomapDir,
  findingsPath,
  importSlitherFindings,
  writeFindings,
  type FindingsFile,
} from '@axiomap/core';

import { loadGraph, openProject, type CommonOptions } from '../context.js';
import { colour, definitions, heading, json, paintSeverity, table } from '../output.js';

export interface ImportFindingsResult {
  text: string;
  exitCode: number;
}

export async function runImportFindings(
  input: string,
  options: CommonOptions = {},
): Promise<ImportFindingsResult> {
  const source = path.resolve(input);
  if (!fs.existsSync(source)) {
    throw new Error(
      `No such file: ${source}. Produce one with: slither . --json ${path.basename(input)}`,
    );
  }

  const context = openProject(options);
  const loaded = await loadGraph(context, options);

  const raw: unknown = JSON.parse(fs.readFileSync(source, 'utf8'));
  const imported = importSlitherFindings(loaded.graph, raw, source);

  await ensureAxiomapDir(context.root);
  const target = findingsPath(context.root);
  const file: FindingsFile = {
    schemaVersion: 1,
    source: { tool: 'slither', file: source, at: new Date().toISOString() },
    findings: imported.findings,
  };
  writeFindings(target, file);

  if (options.json === true) {
    return {
      text: json({
        target,
        total: imported.total,
        mapped: imported.findings.length,
        unmapped: imported.unmapped,
        findings: imported.findings,
      }),
      exitCode: 0,
    };
  }

  const sections: string[] = [
    definitions([
      ['source', source],
      ['results', String(imported.total)],
      ['mapped', String(imported.findings.length)],
      [
        'unmapped',
        imported.unmapped.length === 0
          ? colour.dim('0')
          : colour.yellow(String(imported.unmapped.length)),
      ],
      ['written', target],
    ]),
  ];

  if (imported.findings.length > 0) {
    sections.push(
      `\n${heading('findings')}` +
        table(imported.findings, [
          {
            header: 'impact',
            get: (row) => row.impact,
            paint: (value, row) => paintSeverity(value, row.impact),
          },
          { header: 'confidence', get: (row) => row.confidence },
          { header: 'check', get: (row) => row.check },
          { header: 'nodes', get: (row) => row.nodes.join(', ') },
        ]),
    );
  }

  if (imported.unmapped.length > 0) {
    // Reported rather than dropped: a finding Axiomap could not place is a fact
    // about Axiomap's graph, and hiding it would let a real Slither result
    // vanish between two tools that each assumed the other had it.
    sections.push(
      `\n${heading(`unmapped (${String(imported.unmapped.length)})`)}` +
        table(imported.unmapped, [
          { header: 'check', get: (row) => row.check },
          { header: 'why', get: (row) => row.reason },
        ]),
    );
  }

  return { text: sections.join(''), exitCode: 0 };
}
