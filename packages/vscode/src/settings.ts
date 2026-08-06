/**
 * `contributes.configuration`, and the rule that decides what may be in it.
 *
 * ### Settings do not compose with `axiomap.config.json`. They do not touch it.
 *
 * §13's config file is a **project** fact: `include`, `exclude`, `entrypoints`,
 * `accessControlModifiers`, `reentrancyGuards`, `trustBoundaries`, `renderCap`,
 * `layout`. It is committed, it is shared across an audit team, and §13 already
 * settles one case of this exact question — in a diff, one config governs both
 * revisions, "because the question `axiomap diff` answers is what changed in the
 * protocol" rather than what changed in Axiomap's settings.
 *
 * A VS Code setting that overrode any of those keys would mean two auditors with
 * the same checkout looking at two different graphs, with nothing on screen
 * saying so, and the one who was wrong would be the one whose settings nobody
 * can see. That is the confident-wrong answer §6 rules out, and — the reason it
 * is settled here rather than after Phase 9 — a settings key that has shipped
 * cannot be taken back.
 *
 * **The rule: no setting in this extension may name a §13 field, and no setting
 * may change what the graph contains.** What is left is genuinely editor
 * behaviour — whether a lens is drawn, whether the cursor drives a highlight —
 * for which §13 has no equivalent and no opinion, because neither is a fact
 * about the protocol. `test/settings.test.ts` asserts the first half of the rule
 * against §13's own field list, so a future key that breaks it fails a build
 * rather than a code review.
 *
 * A project knob therefore goes in `axiomap.config.json`, where it is committed
 * beside the code it describes.
 */

import * as vscode from 'vscode';

/** The two keys, exactly as `package.json` contributes them. */
export const CODE_LENS_ENABLED = 'axiomap.codeLens.enabled';
export const FOLLOW_CURSOR = 'axiomap.followCursor';

export interface AxiomapSettings {
  /** Draw §11's CodeLens line. */
  codeLensEnabled: boolean;
  /** Let the editor's cursor highlight a node (§11's inverse navigation). */
  followCursor: boolean;
}

export const SETTING_DEFAULTS: AxiomapSettings = {
  codeLensEnabled: true,
  followCursor: true,
};

/**
 * Read them from any source of values.
 *
 * Takes a getter rather than a `WorkspaceConfiguration` so the decision — what
 * counts as unset, and what an unset key falls back to — is testable without an
 * editor. A non-boolean is treated as unset: `settings.json` is hand-edited, and
 * the default is a better answer than a coercion.
 */
export function readSettings(get: (key: string) => unknown): AxiomapSettings {
  const boolean = (key: string, fallback: boolean): boolean => {
    const value = get(key);
    return typeof value === 'boolean' ? value : fallback;
  };

  return {
    codeLensEnabled: boolean(CODE_LENS_ENABLED, SETTING_DEFAULTS.codeLensEnabled),
    followCursor: boolean(FOLLOW_CURSOR, SETTING_DEFAULTS.followCursor),
  };
}

/**
 * The settings in force for one file.
 *
 * Resource-scoped, because a multi-root workspace is two protocols (see
 * `extension.ts`) and VS Code lets a folder answer differently.
 */
export function settingsFor(resource?: vscode.Uri): AxiomapSettings {
  const config = vscode.workspace.getConfiguration(undefined, resource);
  return readSettings((key) => config.get(key));
}
