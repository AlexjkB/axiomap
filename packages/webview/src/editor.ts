/**
 * The half of a host that is not request/response.
 *
 * `HostBridge` is six questions and six answers, which is everything a browser
 * tab or a self-contained file can be. An editor is a live host with a cursor
 * in it, and §11 asks for three things that are not questions about the graph:
 *
 * - "Click node → reveal in editor. Click edge → reveal the **call site**."
 * - "**VS Code inverse navigation:** editor cursor highlights the corresponding
 *   graph node. This bidirectional link is what makes it feel native rather
 *   than bolted on."
 * - and Phase 8's artifact watch, which is the host saying the graph changed
 *   under the UI rather than the UI asking whether it did.
 *
 * So they are a *separate, optional* interface. `App` takes one when it has one
 * and behaves exactly as before when it does not, which is what keeps browser
 * mode and the HTML export unaffected by a feature only an editor can offer.
 * `VsCodeBridge` implements both this and `HostBridge`; nothing requires one
 * object to do so.
 *
 * ### Highlighting is not navigating
 *
 * `onSelect` fires when the *editor's* cursor lands on a declaration, and the
 * UI answers it by selecting that node and opening the inspector — not by
 * navigating, and pointedly not by revealing back. A cursor move that caused a
 * reveal would drag the editor to wherever the graph decided, which is a
 * feedback loop between two things the user is steering by hand.
 */

import type { RevealTarget } from './vscode.js';

export interface EditorLink {
  /** Fire-and-forget: the answer is an editor moving, not a value. */
  reveal(target: RevealTarget): void;
  /** The editor's cursor moved onto a node. Returns an unsubscribe. */
  onSelect(listener: (id: string, kind: string) => void): () => void;
  /**
   * A command asked for a node — a CodeLens click, "reveal in graph".
   *
   * Separate from `onSelect` because it is a different request: a cursor says
   * "highlight", a command says "go there". See `vscode.ts`.
   */
  onFocus(listener: (id: string, kind: string) => void): () => void;
  /** The host rebuilt the graph. Returns an unsubscribe. */
  onRefresh(listener: (reason: string) => void): () => void;
}

export type { RevealTarget };
