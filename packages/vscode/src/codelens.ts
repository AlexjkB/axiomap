/**
 * §11's CodeLens: `▸ 3 callers · 2 external calls · writes 4 vars · reviewed`.
 *
 * The one part of this extension that is useful without opening the panel — it
 * puts the graph's answer above the function you are already reading, which is
 * where §1's first two questions get asked in practice.
 *
 * ### The counts are core's, the sentence is this file's
 *
 * `fileLenses` returns numbers (`query/lenses.ts`); the wording is here, because
 * core has no UI (§6). What that split buys is that the inspector and the lens
 * cannot disagree about how many callers a function has, while the line above it
 * stays something a person tuned by looking at it.
 *
 * ### What it does not say
 *
 * A zero is left out rather than printed. "0 callers · 0 external calls · writes
 * 0 vars" on every `pure` helper in a library is noise with a number in it, and
 * §11's density rule — every pixel earning its place — applies hardest to a line
 * the editor inserts into somebody's source. A function with nothing to report
 * gets its visibility and reachability, which is the fact an auditor is scanning
 * for.
 *
 * `accessControl: 'none'` deliberately reads as **no recognised guard** rather
 * than as "unguarded" (§10): §13's `accessControlModifiers` is what makes a
 * protocol's own spelling recognisable, and this line is not the place to
 * overstate what the analysis found.
 */

import { fileLenses, type FileLens } from '@axiomap/core';
import * as vscode from 'vscode';

import type { AxiomapSession } from './session.js';
import { rangeOfRef } from './navigation.js';
import { settingsFor } from './settings.js';

/** The command a lens invokes: focus this node in the graph panel. */
export const FOCUS_COMMAND = 'axiomap.focusNode';

function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * One lens's text.
 *
 * Exported because it is the whole of what this file decides, and a test that
 * has to construct a `TextDocument` to check a sentence tests the wrong thing.
 */
export function lensTitle(lens: FileLens): string {
  const parts: string[] = [];

  if (lens.callers > 0) parts.push(plural(lens.callers, 'caller'));
  if (lens.externalCalls > 0) parts.push(plural(lens.externalCalls, 'external call'));
  if (lens.writes > 0) parts.push(`writes ${plural(lens.writes, 'var')}`);

  // §11's attack surface, in words: an externally callable, state-mutating
  // function with no recognised guard is §15's third item, and it belongs on
  // the line whether or not anything else does.
  if (lens.visibility === 'public' || lens.visibility === 'external') {
    if (lens.accessControl.confidence === 'none' && lens.subkind !== 'constructor') {
      parts.push('no recognised guard');
    } else if (lens.accessControl.modifiers.length > 0) {
      parts.push(lens.accessControl.modifiers.join(', '));
    }
  } else if (!lens.externallyReachable) {
    // Reachability over the edges the graph has (§10). Worth saying only when
    // it is surprising, which is on a function nothing calls.
    parts.push('unreachable');
  }

  if (lens.review !== null) {
    parts.push(
      lens.review.staleness === 'stale'
        ? `${lens.review.status} — body changed, needs re-review`
        : lens.review.status,
    );
  }
  if (lens.findings > 0) parts.push(plural(lens.findings, 'finding'));

  return `▸ ${parts.length === 0 ? 'no callers, no calls out' : parts.join(' · ')}`;
}

export class AxiomapLensProvider implements vscode.CodeLensProvider {
  readonly #sessionFor: (uri: vscode.Uri) => AxiomapSession | undefined;
  readonly #changed = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.#changed.event;

  constructor(sessionFor: (uri: vscode.Uri) => AxiomapSession | undefined) {
    this.#sessionFor = sessionFor;
  }

  /** The graph moved: every open document's lenses are now out of date. */
  refresh(): void {
    this.#changed.fire();
  }

  dispose(): void {
    this.#changed.dispose();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    // Editor behaviour, not a fact about the protocol — see `settings.ts` for
    // why that is the only kind of setting this extension has.
    if (!settingsFor(document.uri).codeLensEnabled) return [];

    const session = this.#sessionFor(document.uri);
    if (session === undefined) return [];

    /*
     * The graph is *not* built to answer a lens request. Opening a `.sol` file
     * in a 200k-SLOC repo would otherwise start a multi-second ingest nobody
     * asked for, in the extension host, on a keystroke. Lenses appear once the
     * panel (or the explicit command) has loaded the graph, and the provider is
     * refreshed then.
     */
    const state = session.state;
    if (state === null) return [];

    const relative = vscode.workspace.asRelativePath(document.uri, false);
    const lenses = fileLenses(state.graph, relative, { auditState: state.auditState });
    const text = document.getText();

    return lenses.map((lens) => {
      const range = rangeOfRef(relative, text, lens.src);
      return new vscode.CodeLens(
        new vscode.Range(
          new vscode.Position(range.start.line, range.start.character),
          new vscode.Position(range.start.line, range.start.character),
        ),
        {
          title: lensTitle(lens),
          command: FOCUS_COMMAND,
          arguments: [lens.id],
          tooltip: `Focus ${lens.id} in the Axiomap graph`,
        },
      );
    });
  }
}
