/**
 * What Phase 9 makes permanent.
 *
 * Publishing an extension freezes four things that are cheap to change today
 * and cannot be changed afterwards without breaking somebody's installed copy:
 * the `<publisher>.<name>` id, the command ids, the webview view type, and the
 * settings keys. `vscode-protocol.test.ts` already pins the commands against
 * the code that registers them; this file pins the rest, and one rule about
 * what a setting is allowed to be.
 *
 * ### The rule that cannot be taken back
 *
 * §13's `axiomap.config.json` is a committed, shared, per-project file, and §13
 * itself settles the principle in the diff case: "the question `axiomap diff`
 * answers is what changed in the protocol", not what changed in Axiomap's
 * settings. A VS Code setting that overrode one of its keys would mean two
 * auditors with the same checkout looking at two different graphs, and the one
 * who was wrong would be the one whose settings nobody else can see.
 *
 * So: **no setting may name a §13 field.** Asserted against
 * `axiomapConfigSchema` rather than against a list typed here, so a field added
 * to §13 later is covered by this test the day it is added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { axiomapConfigSchema, CONFIG_FILE } from '@axiomap/core';

import { EXTENSION_NAME, PUBLISHER, publishedManifest } from '../scripts/package-vsix.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VSCODE = path.join(REPO, 'packages/vscode');

function read(file: string): string {
  return fs.readFileSync(path.join(VSCODE, file), 'utf8');
}

const manifest = JSON.parse(read('package.json')) as {
  contributes: {
    configuration: { properties: Record<string, { type: string; default: unknown }> };
  };
};

describe('the extension’s public surface, which Phase 9 freezes', () => {
  it('publishes as axiomap.axiomap, from a CommonJS entry', () => {
    const published = publishedManifest(JSON.parse(read('package.json')));

    expect(`${PUBLISHER}.${EXTENSION_NAME}`).toBe('axiomap.axiomap');
    expect(published.publisher).toBe(PUBLISHER);
    expect(published.name).toBe(EXTENSION_NAME);
    // The workspace name is a pnpm scope and is not a legal extension name; the
    // published one is set by the packaging step, which is the whole reason the
    // manifest is derived rather than copied.
    expect(published.name).not.toContain('/');

    // §7's Phase 8 wants an installable `.vsix`, and the host `require`s the
    // entry: an ESM manifest field would make every install fail at load.
    expect(published.main).toBe('./dist/extension.cjs');
    expect(published.type).toBeUndefined();
    expect(published.private).toBeUndefined();
    expect(published.files).toBeUndefined();
  });

  it('keeps the webview view type stable', () => {
    // A `WebviewPanelSerializer` (§16's restart entry) keys on this string, so
    // changing it later silently orphans whatever state was saved under it.
    expect(read('src/panel.ts')).toContain("const VIEW_TYPE = 'axiomap.graph'");
  });

  it('contributes exactly the settings settings.ts knows about', () => {
    const source = read('src/settings.ts');
    const keys = Object.keys(manifest.contributes.configuration.properties).sort();

    expect(keys).toEqual(['axiomap.codeLens.enabled', 'axiomap.followCursor']);
    for (const key of keys) {
      expect(source, `settings.ts does not name ${key}`).toContain(`'${key}'`);
    }
    // Defaults live in two places by necessity — the manifest is what VS Code
    // reads, `SETTING_DEFAULTS` is what an unset key falls back to — and they
    // disagreeing is a setting that does one thing until somebody toggles it
    // twice.
    for (const key of keys) {
      expect(manifest.contributes.configuration.properties[key]?.default).toBe(false);
    }
    expect(source).toContain('codeLensEnabled: false');
    expect(source).toContain('followCursor: false');
  });

  it('has no setting that names a field of axiomap.config.json (§13)', () => {
    const fields = Object.keys(axiomapConfigSchema.shape);
    expect(fields.length).toBeGreaterThan(0);

    const settings = Object.keys(manifest.contributes.configuration.properties).map((key) =>
      key.replace(/^axiomap\./, ''),
    );

    for (const setting of settings) {
      for (const field of fields) {
        expect(
          setting.split('.')[0]?.toLowerCase(),
          `the setting "axiomap.${setting}" collides with ${CONFIG_FILE}'s "${field}"`,
        ).not.toBe(field.toLowerCase());
      }
    }
  });

  it('states the rule in the file a future setting would be added to', () => {
    // The test above catches a collision; this catches the reason for it being
    // deleted along with the paragraph that explains it.
    const source = read('src/settings.ts');
    expect(source).toContain(CONFIG_FILE);
    expect(source).toMatch(/no setting .*may name a §13 field/i);
  });
});
