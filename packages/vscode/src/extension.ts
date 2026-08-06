/**
 * The extension (§7's Phase 8): the panel, the two navigation directions, the
 * CodeLens provider, the commands, and the artifact watch.
 *
 * This file is wiring and nothing else. Every decision it looks like it is
 * making is made somewhere with a test: what the graph is (`session.ts`), what a
 * request answers with (`host.ts`), where the cursor goes (`navigation.ts`),
 * what a lens says (`codelens.ts`), what the document is (`html.ts`).
 *
 * ### One session per workspace folder
 *
 * A multi-root workspace is two protocols, and §13's config, `.axiomap/` and the
 * artifact are all per folder. Sessions are created lazily — opening an editor
 * on a `.sol` file does not build a graph (see the note in `codelens.ts`); only
 * a command does.
 *
 * ### The activation event is a command, not a language
 *
 * `onLanguage:solidity` would start this extension for anyone who opens a `.sol`
 * file, and the first thing it would want to do is parse their repository.
 * Axiomap is a tool you *reach for*, and the price of it — seconds of CPU on a
 * 200k-SLOC project — should be paid when it is asked for. §9 rule 5's budget is
 * about how long that takes, not about doing it uninvited.
 */

import { AxiomapSession } from './session.js';
import { AxiomapLensProvider, FOCUS_COMMAND } from './codelens.js';
import { GraphPanel } from './panel.js';
import { byteOffsetAt, revealNode } from './navigation.js';
import { configureEngine } from './runtime.js';
import { settingsFor } from './settings.js';
import { nodeAtOffset } from '@axiomap/core';
import * as vscode from 'vscode';

const OPEN_COMMAND = 'axiomap.open';
const REBUILD_COMMAND = 'axiomap.rebuild';
const REVEAL_COMMAND = 'axiomap.revealInGraph';
const REVEAL_NODE_COMMAND = 'axiomap.revealNode';

/** Sessions, keyed by workspace folder path. */
const sessions = new Map<string, AxiomapSession>();

function folderOf(uri: vscode.Uri | undefined): vscode.WorkspaceFolder | undefined {
  if (uri !== undefined) {
    const owner = vscode.workspace.getWorkspaceFolder(uri);
    if (owner !== undefined) return owner;
  }
  const folders = vscode.workspace.workspaceFolders;
  return folders === undefined || folders.length === 0 ? undefined : folders[0];
}

function sessionFor(uri: vscode.Uri | undefined): AxiomapSession | undefined {
  const folder = folderOf(uri);
  if (folder === undefined) return undefined;
  const root = folder.uri.fsPath;
  let session = sessions.get(root);
  if (session === undefined) {
    session = AxiomapSession.open(root);
    sessions.set(root, session);
  }
  return session;
}

/** The folder's panel, opening one if there is none. */
async function panelFor(
  extensionPath: string,
  uri: vscode.Uri | undefined,
): Promise<GraphPanel | undefined> {
  const session = sessionFor(uri);
  if (session === undefined) {
    void vscode.window.showWarningMessage(
      'Axiomap: open a folder containing a Solidity project first.',
    );
    return undefined;
  }
  try {
    return await GraphPanel.show(extensionPath, session);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Axiomap: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const extensionPath = context.extensionPath;
  /*
   * Before anything parses. The grammar `.wasm` and the parse pool's worker are
   * resolved by core relative to its own module, which a bundle breaks — see
   * `runtime.ts`. A source checkout configures nothing and keeps core's
   * defaults.
   */
  configureEngine(extensionPath);
  const lenses = new AxiomapLensProvider((uri) => sessions.get(folderOf(uri)?.uri.fsPath ?? ''));

  context.subscriptions.push(
    lenses,
    /*
     * Selected by *path*, not by language id. `solidity` is contributed by
     * whichever Solidity extension the user happens to have installed, and a
     * lens provider bound to a language id shows nothing at all for somebody who
     * has none — a failure that looks like the extension being broken rather
     * than like a missing dependency. A `.sol` file is a `.sol` file.
     */
    vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**/*.sol' }, lenses),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMAND, async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const panel = await panelFor(extensionPath, uri);
      if (panel !== undefined) lenses.refresh();
    }),

    /*
     * §12's `build`, from the editor. Explicit rather than automatic on every
     * save: `session.ready` already rebuilds when the artifact is behind the
     * sources (core's policy, one place), and re-parsing a protocol on every
     * keystroke-triggered save is the thing §16's incremental-reparse entry is
     * deferred until somebody needs it.
     */
    vscode.commands.registerCommand(REBUILD_COMMAND, async () => {
      const session = sessionFor(vscode.window.activeTextEditor?.document.uri);
      if (session === undefined) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Axiomap: rebuilding the graph' },
        async () => {
          await session.reload();
        },
      );
      lenses.refresh();
      GraphPanel.open.get(session.root)?.refresh('graph rebuilt');
    }),

    /** A CodeLens click, and the palette command: §11's "focus here". */
    vscode.commands.registerCommand(FOCUS_COMMAND, async (id: unknown) => {
      if (typeof id !== 'string') return;
      const panel = await panelFor(extensionPath, vscode.window.activeTextEditor?.document.uri);
      const session = sessionFor(vscode.window.activeTextEditor?.document.uri);
      const node = session?.state?.graph.hasNode(id) === true
        ? session.state.graph.getNodeAttributes(id)
        : undefined;
      panel?.focus(id, node?.kind ?? 'Function');
    }),

    /**
     * §11's other direction, as a command: put the cursor on a node.
     *
     * The panel already does this when the webview posts a `reveal`; this is the
     * same navigation reachable from a keybinding, a task, or another extension,
     * and it is the symmetric twin of `axiomap.focusNode`. Hidden from the
     * palette for the same reason that one is — a command that requires a node
     * id is not something to be picked from a list.
     */
    vscode.commands.registerCommand(REVEAL_NODE_COMMAND, async (id: unknown) => {
      if (typeof id !== 'string') return;
      const session = sessionFor(vscode.window.activeTextEditor?.document.uri);
      const state = session?.state;
      if (session === undefined || state === undefined || state === null) return;
      const found = await revealNode(vscode.Uri.file(session.root), state.graph, id);
      if (!found) {
        void vscode.window.showInformationMessage(
          `Axiomap: ${id} is not a node this graph can open.`,
        );
      }
    }),

    /** The cursor's node, on demand, for a keybinding rather than a click. */
    vscode.commands.registerCommand(REVEAL_COMMAND, async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) return;
      const panel = await panelFor(extensionPath, editor.document.uri);
      const session = sessionFor(editor.document.uri);
      const state = session?.state;
      if (panel === undefined || state === undefined || state === null) return;

      const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
      const node = nodeAtOffset(
        state.graph,
        relative,
        byteOffsetAt(editor.document, editor.selection.active),
      );
      if (node === null) {
        void vscode.window.showInformationMessage(
          `Axiomap: nothing in the graph covers this position in ${relative}.`,
        );
        return;
      }
      panel.focus(node.id, node.kind);
    }),
  );

  /*
   * §11's inverse navigation: "editor cursor highlights the corresponding graph
   * node".
   *
   * Only when a panel is open — the whole point is the link between two things
   * on screen — and only a *highlight*, never a navigation (see `vscode.ts`'s
   * note on why `select` and `focus` are two events).
   */
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const document = event.textEditor.document;
      if (!document.uri.path.endsWith('.sol')) return;
      if (!settingsFor(document.uri).followCursor) return;
      const session = sessions.get(folderOf(document.uri)?.uri.fsPath ?? '');
      const state = session?.state;
      if (session === undefined || state === undefined || state === null) return;
      const panel = GraphPanel.open.get(session.root);
      if (panel === undefined) return;

      const relative = vscode.workspace.asRelativePath(document.uri, false);
      const node = nodeAtOffset(
        state.graph,
        relative,
        byteOffsetAt(document, event.selections[0]?.active ?? event.textEditor.selection.active),
      );
      if (node !== null) panel.select(node.id, node.kind);
    }),
  );

  /*
   * §7's artifact watch.
   *
   * Three files, three different answers, because they cost three different
   * things:
   *
   * - **`.axiomap/graph.json`** — somebody ran `axiomap build` in a terminal, so
   *   the artifact the session may be holding is superseded. Reload it.
   * - **`.axiomap/review.json` and `findings.json`** — §11's two file-backed
   *   overlays. The graph has not moved; re-reading two small files is the whole
   *   update, and rebuilding for it would put a multi-second parse behind
   *   somebody else marking a function reviewed.
   * - **`.sol` files** are deliberately *not* watched. Core's freshness rule
   *   already rebuilds when the sources are newer than the artifact, at the
   *   moment a graph is next asked for; rebuilding on every save would be a
   *   parse of the whole project per keystroke-save, which is §16's
   *   incremental-reparse entry, deferred.
   */
  const watcher = vscode.workspace.createFileSystemWatcher('**/.axiomap/*.json');
  const onArtifact = (uri: vscode.Uri): void => {
    const session = sessions.get(folderOf(uri)?.uri.fsPath ?? '');
    if (session === undefined || session.state === null) return;
    const panel = GraphPanel.open.get(session.root);

    if (uri.fsPath.endsWith('graph.json')) {
      void session.reload().then(() => {
        lenses.refresh();
        panel?.refresh('graph rebuilt outside the editor');
      });
      return;
    }
    session.refreshOverlays();
    lenses.refresh();
    panel?.refresh('review state reloaded');
  };
  watcher.onDidChange(onArtifact);
  watcher.onDidCreate(onArtifact);
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  for (const panel of GraphPanel.open.values()) panel.dispose();
  sessions.clear();
}
