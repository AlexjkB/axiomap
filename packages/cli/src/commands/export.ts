/**
 * `axiomap export --format dot|mermaid|json|html|svg [--view ...]` (§12).
 *
 * ### All five ship as of Phase 7d
 *
 * Three are text serializations of a `ViewSelection` and shipped in Phase 6.
 * The other two are a *rendered* graph, which needs a layout engine, and §7
 * puts `cytoscape` and `elkjs` in Phase 7 — so §16 deferred them twice with
 * that reason and named the trigger: "Phase 7, when there is a renderer to
 * embed". It is embedded now.
 *
 * - **`html`** is the webview in one self-contained file, with the answers a
 *   host would have given embedded in it and elkjs's attribution in the footer.
 *   §7's Phase 9 settles that shape when it says the file "redistributes"
 *   elkjs. See `../export/html.ts`.
 * - **`svg`** is the same `ViewSelection` laid out by the same ELK and written
 *   as SVG elements — a serializer beside `toDot`, not a second layout engine.
 *   See `../export/svg.ts`.
 *
 * The two differ in what they are *for*, which is why both exist rather than
 * one: `svg` goes into a report or a slide, and `html` is the thing an auditor
 * hands a client at the end of an engagement (§15's ninth item).
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  callDefaults,
  DEFAULT_RENDER_CAP,
  findingsPath,
  overlayData,
  readFindings,
  readReview,
  requireNode,
  reviewPath,
  selectView,
  VIEW_NAMES,
  type AggregatedViewOptions,
  type FindingsFile,
  type ProjectMeta,
  type ReviewState,
  type ViewName,
} from '@axiomap/core';

import { loadGraph, openProject, type CommonOptions } from '../context.js';
import { colour } from '../output.js';
import { buildPayload, renderHtml } from '../export/html.js';
import { toDot, toJson, toMermaid, TEXT_FORMATS } from '../export/formats.js';
import { toSvg } from '../export/svg.js';
import { exportBundle } from '../serve/assets.js';

/** §12's five. */
export const RENDERED_FORMATS = ['html', 'svg'] as const;
export const EXPORT_FORMATS = [...TEXT_FORMATS, ...RENDERED_FORMATS] as const;

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

/** §11's two file-backed overlays, so a deliverable carries the audit state too. */
function readOverlaySources(root: string): {
  review: ReviewState | null;
  findings: FindingsFile | null;
} {
  let review: ReviewState | null = null;
  try {
    const file = reviewPath(root);
    review = fs.existsSync(file) ? readReview(file) : null;
  } catch {
    // A malformed audit-state file is a missing overlay, not a failed export —
    // the same call `serve` makes, for the same reason.
  }
  let findings: FindingsFile | null = null;
  try {
    findings = readFindings(findingsPath(root));
  } catch {
    // As above.
  }
  return { review, findings };
}

export async function runExport(options: ExportOptions = {}): Promise<ExportResult> {
  const format = options.format ?? 'dot';

  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new Error(`Unknown format "${format}". Available: ${EXPORT_FORMATS.join(', ')}.`);
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

  if (format === 'html') {
    return exportHtml(context.root, loaded, view, focus, options);
  }

  const selection = selectView(loaded.graph, {
    view,
    ...(focus === undefined ? {} : { focus }),
    ...(options.up === undefined ? {} : { up: options.up }),
    ...(options.down === undefined ? {} : { down: options.down }),
    ...(options.includeTests === true ? { includeTests: true } : {}),
  });

  const text =
    format === 'svg'
      ? await toSvg(selection)
      : format === 'dot'
        ? toDot(selection)
        : format === 'mermaid'
          ? toMermaid(selection)
          : toJson(selection as never);

  if (options.out !== undefined) {
    return write(options.out, text, {
      note: selection.note,
      what: `${String(selection.nodes.length)} nodes and ${String(selection.edges.length)} edges`,
    });
  }

  return { text, exitCode: 0 };
}

function write(out: string, text: string, summary: { note: string; what: string }): ExportResult {
  const target = path.resolve(out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  return {
    text: `${colour.dim(summary.note)}\nWrote ${summary.what} to ${target}\n`,
    exitCode: 0,
  };
}

/**
 * The self-contained deliverable.
 *
 * It refuses to write to stdout. The other four formats are text a person pipes
 * into another tool; this one is two megabytes of bundle and base-encoded
 * payload, and dumping it into a terminal is never what was meant. §6's rule
 * about actionable errors applies: say what to do instead.
 */
async function exportHtml(
  root: string,
  loaded: Awaited<ReturnType<typeof loadGraph>>,
  view: ViewName,
  focus: string | undefined,
  options: ExportOptions,
): Promise<ExportResult> {
  if (options.out === undefined) {
    throw new Error(
      'The html export is a file, not a stream: pass --out <file.html>. ' +
        'It carries the whole UI and the graph it draws, which is not something to print.',
    );
  }

  const bundle = exportBundle();
  const overlaySources = readOverlaySources(root);

  /*
   * The hop limits this file was made with become its *defaults*.
   *
   * The UI initialises its steppers from `meta.callDefaults` and puts those
   * numbers on every call-view request (`navigation.ts`), so an export built
   * with `--down 5` and a meta saying 3 would open asking for a view it does
   * not contain. For this file, the export's hops are the defaults.
   */
  const hops = {
    up: options.up ?? callDefaults().up,
    down: options.down ?? callDefaults().down,
  };

  const meta: ProjectMeta = {
    schemaVersion: loaded.file.schemaVersion,
    generator: loaded.file.generator,
    project: loaded.file.project,
    mode: loaded.file.mode,
    modeReason: loaded.file.modeReason,
    score: loaded.file.score,
    diagnostics: loaded.file.diagnostics,
    root,
    renderCap: DEFAULT_RENDER_CAP,
    views: VIEW_NAMES,
    callDefaults: hops,
  };

  /*
   * The request the UI will make on load, spelled the way `toRequest` spells
   * it: hop limits on the call view and on nothing else. A mismatch here is not
   * an error — it is a file that opens on "this export does not hold that view".
   */
  const initial: AggregatedViewOptions = {
    view,
    ...(focus === undefined ? {} : { focus }),
    ...(view === 'call' ? hops : {}),
    ...(options.includeTests === true ? { includeTests: true } : {}),
  };

  const exportOptions = {
    graph: loaded.graph,
    meta,
    overlays: overlayData(loaded.graph, {
      review: overlaySources.review,
      findings: overlaySources.findings,
    }),
    root,
    initial,
    bundle,
    project: path.basename(root),
    /*
     * The graph's own provenance, not a marketing version: `generator` carries
     * no version field, and `generator.name` is the literal string "axiomap" —
     * which rendered as "Axiomap axiomap" in the footer. What a reader of a
     * deliverable months later actually needs is which parser and which schema
     * produced it, both of which decide whether the file can be reproduced.
     */
    version: `schema v${String(loaded.file.schemaVersion)}, ${loaded.file.generator.parser}`,
  };

  const payload = buildPayload(exportOptions);
  const html = renderHtml(payload, exportOptions);

  const target = path.resolve(options.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html, 'utf8');

  const size = `${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB`;
  const lines = [
    colour.dim(`${String(payload.views.length)} views, ` +
      `${String(Object.keys(payload.inspections).length)} nodes with attributes, ` +
      `${String(Object.keys(payload.sources).length)} with source`),
    `Wrote ${size} to ${target}`,
  ];
  // §4's habit: say what was left out rather than let the reader assume nothing
  // was.
  if (payload.limits.viewsOmitted > 0) {
    lines.push(
      colour.yellow(
        `${String(payload.limits.viewsOmitted)} further views did not fit the export budget; ` +
          'the file says so when one is asked for.',
      ),
    );
  }
  if (payload.limits.sourceTruncated) {
    lines.push(colour.yellow('Some source ranges did not fit; the preview says so where they are missing.'));
  }

  return { text: `${lines.join('\n')}\n`, exitCode: 0 };
}
