/**
 * The graph, in a VS Code webview.
 *
 * One panel per workspace folder, revealed rather than duplicated: two panels
 * over one graph would be two navigation histories claiming to be the same
 * session, and §11's back/forward is per-view state that lives in the UI.
 *
 * ### What crosses the boundary
 *
 * Requests in, answers out (`host.ts`), plus the three notifications an editor
 * can carry that a browser cannot (`@axiomap/webview`'s `editor.ts`): `reveal`
 * out of the webview, `select` and `refresh` into it. Nothing else. In
 * particular the graph does not cross: §9 rule 1 holds here exactly as it holds
 * over HTTP, and for the structural reason rather than by care — the webview
 * package cannot hold an `AxiomapGraph` at all (§5).
 *
 * ### `retainContextWhenHidden`
 *
 * On, and it is a real trade. It costs memory for a hidden panel; what it buys
 * is that switching to another tab and back does not throw away the laid-out
 * graph, the current view or the drilled-into directory. Rebuilding all of it on
 * every tab switch would also mean re-running ELK, which Phase 7b measured in
 * seconds on a dense map.
 */

import { isBridgeRequest, answer, type HostSources } from './host.js';
import { webviewBundle } from './assets.js';
import { nonce as makeNonce, webviewHtml } from './html.js';
import { rangeOfSite, revealNode, revealRange } from './navigation.js';
import type { AxiomapSession } from './session.js';
import { CHANNEL, type HostEvent, type RevealMessage } from '@axiomap/webview';
import * as vscode from 'vscode';

const VIEW_TYPE = 'axiomap.graph';

function isReveal(value: unknown): value is RevealMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<RevealMessage>;
  return message.channel === CHANNEL && message.event === 'reveal';
}

export class GraphPanel {
  static readonly open = new Map<string, GraphPanel>();

  readonly #panel: vscode.WebviewPanel;
  readonly #session: AxiomapSession;
  readonly #disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, session: AxiomapSession) {
    this.#panel = panel;
    this.#session = session;

    this.#disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.#onMessage(message);
      }),
    );
    panel.onDidDispose(() => {
      this.dispose();
    });
  }

  /**
   * Show the panel for a folder, building the graph if this is the first ask.
   *
   * The panel is created *before* the graph is loaded and shows the editor's own
   * progress notification while it builds, because a command that appears to do
   * nothing for four seconds reads as a broken extension.
   */
  static async show(
    extensionPath: string,
    session: AxiomapSession,
    column: vscode.ViewColumn = vscode.ViewColumn.Beside,
  ): Promise<GraphPanel> {
    const existing = GraphPanel.open.get(session.root);
    if (existing !== undefined) {
      existing.#panel.reveal(existing.#panel.viewColumn ?? column, true);
      return existing;
    }

    const bundle = webviewBundle(extensionPath);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Axiomap', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // The bundle only. A webview whose resource roots include the workspace
      // could read the client's source through a URL, and everything this UI
      // legitimately shows of it comes through the bridge (`source/slice.ts`).
      localResourceRoots: [vscode.Uri.file(bundle.dir)],
    });

    panel.webview.html = webviewHtml({
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.file(bundle.script)).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.file(bundle.style)).toString(),
      cspSource: panel.webview.cspSource,
      nonce: makeNonce(),
      elkWorker: bundle.elkWorker,
    });

    const opened = new GraphPanel(panel, session);
    GraphPanel.open.set(session.root, opened);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Axiomap: building the graph' },
      async () => {
        await session.ready();
      },
    );
    return opened;
  }

  get panel(): vscode.WebviewPanel {
    return this.#panel;
  }

  /** §11's inverse navigation: the editor's cursor landed on this node. */
  select(id: string, kind: string): void {
    const event: HostEvent = { channel: CHANNEL, event: 'select', id, kind };
    void this.#panel.webview.postMessage(event);
  }

  /** A command asked the graph to go somewhere: §11's "focus here". */
  focus(id: string, kind: string): void {
    const event: HostEvent = { channel: CHANNEL, event: 'focus', id, kind };
    void this.#panel.webview.postMessage(event);
  }

  /** The artifact watch: everything the UI is holding was about the old graph. */
  refresh(reason: string): void {
    const event: HostEvent = { channel: CHANNEL, event: 'refresh', reason };
    void this.#panel.webview.postMessage(event);
  }

  dispose(): void {
    GraphPanel.open.delete(this.#session.root);
    for (const disposable of this.#disposables) disposable.dispose();
    this.#disposables.length = 0;
    this.#panel.dispose();
  }

  /**
   * What the host knows, for one request.
   *
   * `buffer` is the unsaved-changes answer to 7d's open question: an editor is
   * the one host where the file on disk is routinely not what the user is
   * looking at, so the preview reads the open document when there is one.
   */
  #sources(): HostSources | null {
    const state = this.#session.state;
    if (state === null) return null;
    return {
      graph: state.graph,
      file: state.file,
      root: this.#session.root,
      renderCap: this.#session.renderCap,
      overlays: state.overlays,
      buffer: (file) => {
        const uri = vscode.Uri.joinPath(vscode.Uri.file(this.#session.root), ...file.split('/'));
        const open = vscode.workspace.textDocuments.find(
          (document) => document.uri.fsPath === uri.fsPath && document.isDirty,
        );
        return open?.getText();
      },
    };
  }

  async #onMessage(message: unknown): Promise<void> {
    if (isReveal(message)) {
      await this.#reveal(message);
      return;
    }
    if (!isBridgeRequest(message)) return;

    // A request that arrives before the graph is ready waits for it rather than
    // being refused: the webview mounts and asks for `meta` immediately, and the
    // build it is waiting on is the one the command already started.
    const state = await this.#session.ready();
    void state;
    const sources = this.#sources();
    if (sources === null) return;
    void this.#panel.webview.postMessage(answer(sources, message));
  }

  /** §11: click a node, land on its declaration; click an edge, land on the call. */
  async #reveal(message: RevealMessage): Promise<void> {
    const state = this.#session.state;
    if (state === null) return;
    const root = vscode.Uri.file(this.#session.root);

    if (message.target.kind === 'site') {
      const { file, line, column } = message.target;
      await revealRange(root, file, rangeOfSite({ line, column }));
      return;
    }

    await revealNode(root, state.graph, message.target.id);
  }
}
