/**
 * §11's bidirectional link: the graph moves the editor, and the editor moves
 * the selection in the graph.
 *
 * > "Click node → reveal in editor. Click edge → reveal the **call site**." …
 * > "**VS Code inverse navigation:** editor cursor highlights the corresponding
 * > graph node. This bidirectional link is what makes it feel native rather than
 * > bolted on."
 *
 * ### Offsets are bytes, and this is the file where that bites
 *
 * §10 warns that getting this wrong "makes navigation land in the wrong place in
 * any file containing non-ASCII characters, and it will look like a random
 * intermittent bug". Both directions therefore go through `PositionIndex`, which
 * is the same conversion the parse used to *produce* the offsets — rather than
 * through `src.line`/`src.column`, which would be a second answer to the same
 * question, correct until the day it is not.
 *
 * The exception is a call site, which arrives from the webview as a line and a
 * column already (§10 records both on every `SourceRef`, in exactly the editor's
 * convention: 1-based line, 0-based UTF-16 column). There is nothing to convert
 * and nothing to be inconsistent with.
 */

import { PositionIndex, type GraphNode, type SourceRefRecord } from '@axiomap/core';
import * as vscode from 'vscode';

/** A range in the editor's own terms: 0-based line, 0-based UTF-16 character. */
export interface EditorRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/**
 * The byte range of a declaration, as a range in a buffer.
 *
 * Clamped rather than checked: a graph built before the last few edits can name
 * an offset past the end of a file that has since shrunk, and the honest
 * behaviour then is to land at the end of the file rather than to refuse to
 * navigate. The preview panel is where drift is *reported* (`source/slice.ts`);
 * a jump that lands approximately is better than one that does not happen.
 */
export function rangeOfRef(file: string, text: string, src: SourceRefRecord): EditorRange {
  const index = new PositionIndex(file, text);
  const from = index.utf16IndexAt(src.offset);
  const to = index.utf16IndexAt(src.offset + src.length);
  const start = index.ref(from, from);
  const end = index.ref(to, to);
  return {
    start: { line: start.line - 1, character: start.column },
    end: { line: end.line - 1, character: end.column },
  };
}

/**
 * Where a call site is, given what the edge carried.
 *
 * A zero-width range: the point is to put the cursor *at* the call, not to
 * select an expression whose extent the webview does not know.
 */
export function rangeOfSite(site: { line: number; column: number }): EditorRange {
  const position = { line: Math.max(0, site.line - 1), character: Math.max(0, site.column) };
  return { start: position, end: position };
}

function toRange(range: EditorRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character),
  );
}

/**
 * Open a file at a range, beside the graph rather than on top of it.
 *
 * `ViewColumn.One` and `preserveFocus: false`: clicking a node is a request to
 * *read the code*, so the cursor goes there. The panel keeps its column (see
 * `panel.ts`), which is what makes click-to-navigate feel like a split view
 * rather than like two tabs fighting.
 */
export async function revealRange(
  root: vscode.Uri,
  file: string,
  range: EditorRange,
): Promise<void> {
  const uri = vscode.Uri.joinPath(root, ...file.split('/'));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false,
    preview: true,
  });
  const target = toRange(range);
  editor.selection = new vscode.Selection(target.start, target.start);
  editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** A declaration's range in a document that is already open. */
export function rangeOfNode(document: vscode.TextDocument, node: GraphNode): EditorRange {
  return rangeOfRef(node.file, document.getText(), node.src);
}

/**
 * The byte offset of a cursor, for the inverse direction.
 *
 * The editor counts UTF-16 units and the graph counts bytes (§10), and this is
 * the one line that joins them. It is here rather than inline at the call site
 * so that there is one place to look when navigation lands one character off in
 * a file with a `π` in a comment.
 */
export function byteOffsetAt(document: vscode.TextDocument, position: vscode.Position): number {
  return new PositionIndex(document.fileName, document.getText()).byteOffsetAt(
    document.offsetAt(position),
  );
}
