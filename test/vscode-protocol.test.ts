/**
 * The webview and the extension agree on what a message looks like.
 *
 * The fourth written-twice pair (`serve-protocol.test.ts` has the other three),
 * and the one whose two halves are furthest apart: `VsCodeBridge` posts from
 * inside a webview, and `answer` reads in the extension host. Neither package
 * can import the other's implementation of the format — §5 allows `vscode →
 * webview`, so the *types* are shared, but a type does not stop a host from
 * having no branch for a method a bridge sends.
 *
 * That is the failure this pins: it is silent. A request whose method nothing
 * answers produces a promise that never settles, which in a UI is a spinner
 * that never stops.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildProjectGraph, overlayData } from '@axiomap/core';
import { CHANNEL, VsCodeBridge, VSCODE_DIST, type BridgeRequest } from '@axiomap/webview';
import { answer, isBridgeRequest, type HostSources } from '@axiomap/vscode/host';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINIMAL = path.join(REPO, 'fixtures/minimal');

let sources: HostSources;

beforeAll(async () => {
  const built = await buildProjectGraph(MINIMAL, { cacheDir: null, workers: 1, enrich: false });
  sources = {
    graph: built.graph,
    file: built.file,
    root: MINIMAL,
    renderCap: 1500,
    overlays: overlayData(built.graph, { review: null, findings: null }),
  };
});

/** The real bridge, with the channel replaced by a recorder. */
function recordingBridge(): { bridge: VsCodeBridge; posted: unknown[] } {
  const posted: unknown[] = [];
  const bridge = new VsCodeBridge({
    api: {
      postMessage: (message: unknown) => {
        posted.push(message);
      },
    },
    target: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Window,
  });
  return { bridge, posted };
}

describe('the postMessage pair', () => {
  it('answers every request the bridge can send', async () => {
    const { bridge, posted } = recordingBridge();

    // One call per `HostBridge` method — the interface is six methods, and this
    // is all six. Nothing answers them here: what is under test is what went
    // out, so the rejections `dispose` produces are the expected end of each.
    const ignored = (): undefined => undefined;
    const inFlight = [
      bridge.meta(),
      bridge.view({ view: 'protocol' }),
      bridge.inspect('src/Vault.sol:Vault.deposit(uint256)'),
      bridge.overlays(),
      bridge.search('deposit'),
      bridge.source('src/Vault.sol:Vault.deposit(uint256)', 3),
    ].map((pending) => pending.catch(ignored));
    bridge.dispose();
    await Promise.all(inFlight);

    expect(posted).toHaveLength(6);
    const methods = new Set<string>();

    for (const message of posted) {
      // The host's own guard, on the host's own definition of ours.
      expect(isBridgeRequest(message)).toBe(true);
      const request = message as BridgeRequest;
      methods.add(request.method);

      const response = answer(sources, request);
      expect(response.channel).toBe(CHANNEL);
      expect(response.id).toBe(request.id);
      // Any answer will do — a refusal is an answer. What must not happen is
      // the host not knowing what it was asked.
      expect(response.error?.name, request.method).not.toBe('UnknownMethod');
      expect(response.result === undefined && response.error === undefined).toBe(false);
    }

    expect([...methods].sort()).toEqual([
      'inspect',
      'meta',
      'overlays',
      'search',
      'source',
      'view',
    ]);
  });

  it('carries a view request through the host’s decoder unchanged', async () => {
    const { bridge, posted } = recordingBridge();
    const request = {
      view: 'call' as const,
      focus: 'src/Vault.sol:Vault.deposit(uint256)',
      up: 1,
      down: 4,
      expand: ['src', 'src/lib'],
      includeTests: true,
    };
    const pending = bridge.view(request).catch((): undefined => undefined);
    bridge.dispose();
    await pending;

    const view = answer(sources, posted[0] as BridgeRequest).result as {
      view: string;
      nodes: { id: string }[];
    };
    // The view and its focus node both survived the round trip. The hop limits
    // and the expansion set are pinned field-by-field by the encode/decode test
    // in `serve-protocol.test.ts`, which this transport reuses rather than
    // reimplements — §9 rule 4 makes a call graph without its focus node an
    // impossible answer, so drawing it is the end-to-end evidence.
    expect(view.view).toBe('call');
    expect(view.nodes.map((node) => node.id)).toContain(request.focus);
  });

  it('agrees on where the VS Code bundle is', () => {
    // `assets.ts` duplicates the constant for the same §5 reason `serve` does.
    const assets = fs.readFileSync(path.join(REPO, 'packages/vscode/src/assets.ts'), 'utf8');
    expect(assets).toContain(`const VSCODE_DIST = '${VSCODE_DIST}'`);

    const config = fs.readFileSync(
      path.join(REPO, 'packages/webview/vite.vscode.config.ts'),
      'utf8',
    );
    expect(config).toContain(`outDir: '${VSCODE_DIST}'`);
  });
});

describe('the extension manifest', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, 'packages/vscode/package.json'), 'utf8'),
  ) as {
    contributes: {
      commands: { command: string }[];
      keybindings: { command: string }[];
      menus: Record<string, { command: string }[]>;
    };
  };
  const source = fs.readFileSync(path.join(REPO, 'packages/vscode/src/extension.ts'), 'utf8');
  const lens = fs.readFileSync(path.join(REPO, 'packages/vscode/src/codelens.ts'), 'utf8');

  const declared = manifest.contributes.commands.map((entry) => entry.command);
  const registered = [...`${source}${lens}`.matchAll(/'(axiomap\.[a-zA-Z]+)'/g)].map(
    (match) => match[1] as string,
  );

  /*
   * A command in the manifest with nothing registered behind it fails when
   * somebody clicks it — "command 'axiomap.x' not found" — and a command
   * registered but not declared cannot be reached from the palette at all.
   * Neither shows up in a unit test of either half.
   */
  it('declares exactly the commands the extension registers', () => {
    expect([...new Set(declared)].sort()).toEqual([...new Set(registered)].sort());
  });

  it('binds keys and menu entries only to commands it declares', () => {
    const bound = [
      ...manifest.contributes.keybindings.map((entry) => entry.command),
      ...Object.values(manifest.contributes.menus).flatMap((entries) =>
        entries.map((entry) => entry.command),
      ),
    ];
    for (const command of bound) expect(declared).toContain(command);
  });
});
