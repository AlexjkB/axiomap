/**
 * The graph the extension is holding, and the rules for when it is stale.
 *
 * Everything the panel, the CodeLens provider and the navigation commands
 * answer from goes through here, so there is one graph per workspace folder
 * rather than one per feature — three features holding three graphs would
 * disagree the moment one of them rebuilt.
 *
 * ### No `vscode` import
 *
 * Deliberate. This file is the extension's *model*, and everything in it is
 * `core` plus `fs`: opening a project, loading a graph, reading the two
 * audit-state files. The editor-shaped parts — watchers, progress, commands —
 * are in the files that import `vscode`, which keeps this one testable without
 * an editor and keeps the seam between "what Axiomap knows" and "how VS Code
 * shows it" visible rather than assumed.
 *
 * ### The artifact policy is core's, not this file's
 *
 * `loadProjectGraph` decides whether `.axiomap/graph.json` is still true and
 * rebuilds when it is not — the same function `axiomap serve` calls, moved into
 * core in this phase precisely so that the editor and the terminal cannot
 * disagree about whether the graph on screen describes the code on disk.
 */

import {
  DEFAULT_RENDER_CAP,
  loadProjectGraph,
  openProject,
  overlayData,
  readOverlayFiles,
  type AxiomapGraph,
  type GraphFile,
  type OverlayData,
  type ProjectContext,
} from '@axiomap/core';

export interface SessionState {
  graph: AxiomapGraph;
  file: GraphFile;
  overlays: OverlayData;
  /** Where it came from, for the status line. */
  origin: 'built' | 'artifact';
  /** Set when a stored artifact was rebuilt, and why (§13, §4). */
  reason: string | null;
  /** Anything the config or the two overlay files had to say. */
  warnings: string[];
}

export interface SessionHooks {
  /** A build started; a long one wants a progress notification. */
  onBuildStart?: (root: string) => void;
  onBuildEnd?: () => void;
}

/**
 * One workspace folder's graph.
 *
 * `load` is separate from the constructor because building a graph is seconds
 * of work and a constructor that cannot be awaited would either block the
 * extension host or hand back an object that is not ready yet.
 */
export class AxiomapSession {
  readonly root: string;
  readonly context: ProjectContext;

  #state: SessionState | null = null;
  #loading: Promise<SessionState> | null = null;

  private constructor(context: ProjectContext) {
    this.context = context;
    this.root = context.root;
  }

  /** §13's config, read once per folder. Throws only if the folder is gone. */
  static open(root: string): AxiomapSession {
    return new AxiomapSession(openProject({ path: root }));
  }

  get state(): SessionState | null {
    return this.#state;
  }

  /** §13's `renderCap` (§9 rule 2), resolved the way every host resolves it. */
  get renderCap(): number {
    return this.context.config.renderCap ?? DEFAULT_RENDER_CAP;
  }

  /**
   * The graph, loading it if this is the first ask.
   *
   * Concurrent callers share one load: the panel, the CodeLens provider and a
   * cursor move can all arrive within a frame of each other on activation, and
   * three parallel ingests of the same project is three times the work for one
   * answer.
   */
  async ready(hooks: SessionHooks = {}): Promise<SessionState> {
    if (this.#state !== null) return this.#state;
    this.#loading ??= this.#load(false, hooks).finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  /**
   * Rebuild, whatever the artifact says.
   *
   * This is what the artifact watch and the explicit command both call. It does
   * not clear `#state` first: the old graph stays answerable while the new one
   * is being built, so a rebuild triggered by a save does not empty the panel
   * for the two seconds it takes.
   */
  async reload(hooks: SessionHooks = {}): Promise<SessionState> {
    this.#loading ??= this.#load(true, hooks).finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  /**
   * Re-read the two audit-state files and nothing else.
   *
   * `review.json` changes every time a reviewer marks a function, and the graph
   * it is keyed against has not moved. Rebuilding for that would put a
   * multi-second parse behind a keystroke in another window.
   */
  refreshOverlays(): SessionState | null {
    if (this.#state === null) return null;
    const files = readOverlayFiles(this.root);
    this.#state = {
      ...this.#state,
      overlays: overlayData(this.#state.graph, files),
      warnings: [...this.context.warnings, ...files.warnings],
    };
    return this.#state;
  }

  async #load(rebuild: boolean, hooks: SessionHooks): Promise<SessionState> {
    const loaded = await loadProjectGraph(
      this.context,
      rebuild ? { rebuild: true } : {},
      {
        onBuildStart: (root) => hooks.onBuildStart?.(root),
        onBuildEnd: () => hooks.onBuildEnd?.(),
      },
    );
    const files = readOverlayFiles(this.root);
    this.#state = {
      graph: loaded.graph,
      file: loaded.file,
      overlays: overlayData(loaded.graph, files),
      origin: loaded.origin,
      reason: loaded.reason,
      warnings: [...this.context.warnings, ...files.warnings],
    };
    return this.#state;
  }
}
