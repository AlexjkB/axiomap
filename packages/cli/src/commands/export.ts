/**
 * `axiomap export --format dot|mermaid|json [--view ...]` (§12).
 *
 * ### `html` and `svg` are not here, and that is a deferral with a reason
 *
 * §12 lists five formats and §7 gives Phase 6 "all export formats". Three ship;
 * `html` and `svg` do not, because both are a *rendered* graph and rendering is
 * a layout engine. §7's Phase 7 is where `cytoscape` and `elkjs` arrive, and
 * §7's Phase 9 settles what the HTML export actually is when it says the
 * self-contained HTML file "redistributes" elkjs and needs its attribution in
 * the footer — that is the webview in one file, not a second renderer.
 *
 * Building a throwaway layout engine here to fill the gap would be both the UI
 * work this phase is told twice not to do (§6: "do not skip ahead to the UI")
 * and a second implementation to delete in Phase 7. Appended to §16 with that
 * rationale rather than punted silently.
 *
 * The three that ship are the three that are text, and they are the ones a
 * terminal workflow actually reaches for: `dot` into Graphviz, `mermaid` into a
 * markdown report, `json` into `jq`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireNode, selectView, VIEW_NAMES, type ViewName } from '@axiomap/core';

import { loadGraph, openProject, type CommonOptions } from '../context.js';
import { colour } from '../output.js';
import { toDot, toJson, toMermaid, TEXT_FORMATS, type TextFormat } from '../export/formats.js';

/** §12's five, so the error message can name what is deferred rather than deny it. */
const DEFERRED_FORMATS = ['html', 'svg'] as const;

export interface ExportOptions extends CommonOptions {
  format?: string;
  view?: string;
  focus?: string;
  up?: number;
  down?: number;
  includeTests?: boolean;
  /** Write here instead of stdout. */
  out?: string;
}

export interface ExportResult {
  text: string;
  exitCode: number;
}

export async function runExport(options: ExportOptions = {}): Promise<ExportResult> {
  const format = (options.format ?? 'dot') as TextFormat;

  if ((DEFERRED_FORMATS as readonly string[]).includes(format)) {
    throw new Error(
      `The "${format}" export needs a layout engine and ships with the renderer in Phase 7 ` +
        '(AXIOMAP.md §16). Available now: ' +
        `${TEXT_FORMATS.join(', ')} — "dot" piped through Graphviz gives you an image today.`,
    );
  }
  if (!(TEXT_FORMATS as readonly string[]).includes(format)) {
    throw new Error(`Unknown format "${format}". Available: ${TEXT_FORMATS.join(', ')}.`);
  }

  const view = (options.view ?? 'protocol') as ViewName;
  if (!(VIEW_NAMES as readonly string[]).includes(view)) {
    throw new Error(`Unknown view "${view}". Available: ${VIEW_NAMES.join(', ')}.`);
  }

  const context = openProject(options);
  const loaded = await loadGraph(context, options);

  // A focus may be typed the short way, like every other node reference.
  const focus =
    options.focus === undefined ? undefined : requireNode(loaded.graph, options.focus).id;

  const selection = selectView(loaded.graph, {
    view,
    ...(focus === undefined ? {} : { focus }),
    ...(options.up === undefined ? {} : { up: options.up }),
    ...(options.down === undefined ? {} : { down: options.down }),
    ...(options.includeTests === true ? { includeTests: true } : {}),
  });

  const text =
    format === 'dot' ? toDot(selection) : format === 'mermaid' ? toMermaid(selection) : toJson(selection);

  if (options.out !== undefined) {
    const target = path.resolve(options.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    return {
      text:
        `${colour.dim(selection.note)}\n` +
        `Wrote ${String(selection.nodes.length)} nodes and ${String(selection.edges.length)} edges to ${target}\n`,
      exitCode: 0,
    };
  }

  return { text, exitCode: 0 };
}
