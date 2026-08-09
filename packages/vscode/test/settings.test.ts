/**
 * The two settings, and the rule about what a setting is allowed to be.
 *
 * `test/vscode-public-api.test.ts` at the repo root asserts the rule against
 * §13's schema — that no key here names a field of `axiomap.config.json`. This
 * file asserts the reading of them, which is where an unset key and a key set to
 * something odd are decided.
 */

import { describe, expect, it } from 'vitest';
import { workspace } from 'vscode';

import {
  CODE_LENS_ENABLED,
  FOLLOW_CURSOR,
  SETTING_DEFAULTS,
  readSettings,
  settingsFor,
} from '../src/settings.js';

describe('reading the settings', () => {
  /*
   * Both off, and asserted rather than left to the manifest: these are the only
   * two things the extension does outside its own panel, and an in-editor
   * surface that arrives switched on is one the user has to go and find the
   * switch for. Stated here so flipping either back is a deliberate edit.
   */
  it('defaults both off', () => {
    expect(readSettings(() => undefined)).toEqual(SETTING_DEFAULTS);
    expect(SETTING_DEFAULTS).toEqual({ codeLensEnabled: false, followCursor: false });
  });

  // Set to the opposite of the default, so a `readSettings` that ignored its
  // argument entirely would fail rather than agree by coincidence.
  it('takes a boolean at face value', () => {
    const values: Record<string, unknown> = {
      [CODE_LENS_ENABLED]: true,
      [FOLLOW_CURSOR]: true,
    };
    expect(readSettings((key) => values[key])).toEqual({
      codeLensEnabled: true,
      followCursor: true,
    });
  });

  it('treats a non-boolean as unset', () => {
    // `settings.json` is hand-edited, and `"false"` is a thing people type. The
    // default is a better answer than a coercion, which would read a
    // deliberately-quoted `"false"` as `true`.
    for (const odd of ['false', 0, null, {}, []]) {
      expect(readSettings(() => odd), JSON.stringify(odd)).toEqual(SETTING_DEFAULTS);
    }
  });

  it('reads them per resource, through the editor’s own configuration', () => {
    workspace.settings = { [CODE_LENS_ENABLED]: true };
    try {
      // The one that was set, and the one that was not.
      expect(settingsFor()).toEqual({ codeLensEnabled: true, followCursor: false });
    } finally {
      workspace.settings = {};
    }
  });
});
