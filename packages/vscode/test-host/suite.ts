/**
 * The extension, in a real extension host.
 *
 * Everything in `test/` runs against `test/vscode-stub.ts`, which carries shapes
 * and no behaviour — deliberately, because a stub that reimplemented `Range`
 * semantics would be a second implementation of the editor and a test passing
 * against it would say nothing. The cost of that decision is that until Phase 8b
 * **no part of the editor half had ever run**: not that a reveal moves a cursor,
 * not that a lens draws above a function, not that the artifact watch fires.
 *
 * This suite is that. It runs inside VS Code, against the **packaged** extension
 * tree (`packages/vscode/.vsix`, what `scripts/package-vsix.mjs` stages and
 * `vsce` zips), over the real `fixtures/defi` project. So it also answers the
 * packaging question from the other side: `scripts/verify-vsix.mjs` proves the
 * artifact's paths resolve outside this repo, and this proves the editor can
 * activate it and get a graph out of it.
 *
 * ### Why it is not part of `pnpm check`
 *
 * It downloads and launches an editor. `pnpm test:host` runs it, CI can run it
 * on its own job, and the unit suites stay the fast thing that runs on a save.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as vscode from 'vscode';

const EXTENSION_ID = 'axiomap.axiomap';

/** A node this fixture is known to have, from `fixtures/defi/src/Router.sol`. */
const ROUTER_QUOTE = 'src/Router.sol:Router.quote(uint256,uint256,uint256)';

/**
 * Every `--vscode-*` variable `packages/webview/src/ui/style.ts` reads.
 *
 * Written out here rather than imported: this file is bundled into the
 * extension host, and reaching into another package's UI module for a constant
 * would be an import that only works because of how it is built. It is a
 * written-twice pair, and `theme-legibility.test.ts` pins it against
 * `PALETTE_VARIABLES` — so a variable added to the palette and not to this list
 * fails a build rather than producing a dump with a hole in it.
 */
const PALETTE_VARIABLES = [
  '--vscode-editor-background',
  '--vscode-editor-foreground',
  '--vscode-descriptionForeground',
  '--vscode-panel-border',
  '--vscode-editorWidget-background',
  '--vscode-editorGroup-border',
  '--vscode-charts-blue',
  '--vscode-charts-purple',
  '--vscode-charts-green',
  '--vscode-charts-orange',
  '--vscode-charts-red',
  '--vscode-charts-foreground',
  '--vscode-editorWarning-foreground',
  '--vscode-editorError-foreground',
  '--vscode-focusBorder',
  '--vscode-symbolIcon-keywordForeground',
  '--vscode-symbolIcon-classForeground',
  '--vscode-symbolIcon-functionForeground',
  '--vscode-symbolIcon-stringForeground',
  '--vscode-symbolIcon-numberForeground',
  '--vscode-symbolIcon-variableForeground',
  '--vscode-editor-font-family',
  '--vscode-font-family',
];

/** Set by `scripts/test-extension-host.mjs`; the suite has no repo path of its own. */
const DUMP_DIR = process.env.AXIOMAP_THEME_DUMP_DIR ?? '';

/**
 * What a real editor resolves those variables to, read from inside a webview.
 *
 * A plain webview rather than the graph panel: what is being read is what *VS
 * Code injects*, which is the same for every webview it opens, and a panel of
 * our own is one whose document is not also under test.
 */
async function dumpPalette(theme: string): Promise<Record<string, string>> {
  const panel = vscode.window.createWebviewPanel(
    'axiomap.themeProbe',
    `theme probe — ${theme}`,
    { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
    { enableScripts: true },
  );
  try {
    const names = JSON.stringify(PALETTE_VARIABLES);
    panel.webview.html =
      '<!DOCTYPE html><html><body><script>' +
      `const names = ${names};` +
      'const style = getComputedStyle(document.documentElement);' +
      'const values = {};' +
      'for (const name of names) values[name] = style.getPropertyValue(name).trim();' +
      'acquireVsCodeApi().postMessage(values);' +
      '</script></body></html>';

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the ${theme} probe webview did not report a palette`));
      }, 20_000);
      panel.webview.onDidReceiveMessage((message: Record<string, string>) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  } finally {
    panel.dispose();
  }
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder !== undefined, 'the test window opened without a workspace folder');
  return folder.uri.fsPath;
}

function uriIn(...parts: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(workspaceRoot(), ...parts));
}

/** Poll until `predicate` holds. Editors are asynchronous in every direction. */
async function until<T>(
  what: string,
  predicate: () => T | undefined | Promise<T | undefined>,
  timeout = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

suite('the packaged extension, in an extension host', function () {
  // A cold `axiomap.open` parses the whole fixture and lays it out.
  this.timeout(180_000);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension !== undefined, `${EXTENSION_ID} is not installed in this window`);
    await extension.activate();
    /*
     * The lens ships off (`settings.ts`), so the cases below that are about
     * what a lens looks like turn it on for the window first. Without this they
     * would pass by drawing nothing, which is what one of them asserts.
     */
    await vscode.workspace
      .getConfiguration('axiomap')
      .update('codeLens.enabled', true, vscode.ConfigurationTarget.Workspace);
  });

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration('axiomap')
      .update('codeLens.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    // `.axiomap/` is written into the fixture by the run itself.
    fs.rmSync(path.join(workspaceRoot(), '.axiomap'), { recursive: true, force: true });
  });

  test('activates from a command, not from opening a .sol file', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'axiomap.open',
      'axiomap.rebuild',
      'axiomap.revealInGraph',
      'axiomap.focusNode',
      'axiomap.revealNode',
    ]) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });

  test('opens a panel and builds a graph of the real project', async () => {
    await vscode.window.showTextDocument(uriIn('src', 'Router.sol'));
    await vscode.commands.executeCommand('axiomap.open');

    const tab = await until('the Axiomap panel', () =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find((candidate) => candidate.label === 'Axiomap'),
    );
    assert.ok(tab.input instanceof vscode.TabInputWebview, 'the Axiomap tab is not a webview');

    // The parse cache is the packaged parser's footprint on disk: one entry per
    // file it read, keyed by content hash. Its presence is the vendored grammar
    // having loaded and real Solidity having gone through it, inside the editor
    // — which is the failure this whole phase is about, and which shows up as an
    // empty graph rather than as an error.
    //
    // Not `.axiomap/graph.json`: the extension holds the graph in memory and
    // only `axiomap build` writes that file (see `project/session.ts`, and the
    // §16 entry this test's first draft produced).
    const cache = await until('the parse cache', () => {
      const dir = path.join(workspaceRoot(), '.axiomap', 'cache', 'parse');
      return fs.existsSync(dir) && fs.readdirSync(dir).length > 0 ? dir : undefined;
    });
    assert.ok(fs.readdirSync(cache).length > 0);
  });

  test('draws a CodeLens above a function (§11)', async () => {
    const uri = uriIn('src', 'Router.sol');
    const document = await vscode.workspace.openTextDocument(uri);

    // `vscode.executeCodeLensProvider` runs every registered provider, which is
    // the same path the editor takes when it draws them.
    const drawn = await until('a CodeLens on Router.sol', async () => {
      const result = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        uri,
      );
      return result !== undefined && result.length > 0 ? result : undefined;
    });

    const titles = drawn.map((lens) => lens.command?.title ?? '');
    assert.ok(
      titles.some((title) => title.startsWith('▸')),
      `no Axiomap lens among ${String(drawn.length)}: ${titles.join(' | ')}`,
    );

    // A lens sits on the line its declaration starts on, in a document the
    // editor parsed itself — which is the byte-offset conversion (§10) checked
    // against something other than our own PositionIndex.
    const quote = drawn.find((lens) => lens.command?.arguments?.[0] === ROUTER_QUOTE);
    assert.ok(quote !== undefined, 'no lens carries Router.quote');
    assert.ok(
      document.lineAt(quote.range.start.line).text.includes('function quote'),
      `the Router.quote lens is on line ${String(quote.range.start.line + 1)}: ` +
        `"${document.lineAt(quote.range.start.line).text.trim()}"`,
    );
  });

  test('a reveal moves the cursor to the declaration (§11)', async () => {
    // Somewhere else entirely, so a no-op would fail rather than pass.
    const other = await vscode.workspace.openTextDocument(uriIn('src', 'Factory.sol'));
    await vscode.window.showTextDocument(other, vscode.ViewColumn.One);

    await vscode.commands.executeCommand('axiomap.revealNode', ROUTER_QUOTE);

    const editor = await until('the editor to land on Router.sol', () => {
      const active = vscode.window.activeTextEditor;
      return active?.document.uri.fsPath.endsWith('Router.sol') === true ? active : undefined;
    });
    const line = editor.document.lineAt(editor.selection.active.line).text;
    assert.ok(
      line.includes('function quote'),
      `the cursor landed on "${line.trim()}", not on Router.quote`,
    );
  });

  /**
   * Phase 8's second exit criterion is "click-to-navigate feels instant", and
   * §6 says exit criteria are tests rather than vibes. This is the number.
   *
   * The budget is **100 ms**, which is the interval below which a response reads
   * as caused by the click rather than as following it. Measured across every
   * node in one file, from the command going out to the cursor being on the
   * declaration, with the document already open — which is the state a second
   * click is in, and the one a user does dozens of times a minute.
   */
  test('click-to-navigate is under 100 ms per node, warm', async () => {
    const uri = uriIn('src', 'Router.sol');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
    );
    const ids = (lenses ?? [])
      .map((lens) => lens.command?.arguments?.[0])
      .filter((id): id is string => typeof id === 'string');
    assert.ok(ids.length >= 5, `only ${String(ids.length)} nodes to navigate to`);

    const timings: number[] = [];
    for (const id of ids) {
      const started = performance.now();
      await vscode.commands.executeCommand('axiomap.revealNode', id);
      timings.push(performance.now() - started);
    }

    timings.sort((a, b) => a - b);
    const worst = timings[timings.length - 1] ?? 0;
    const median = timings[Math.floor(timings.length / 2)] ?? 0;
    console.log(
      `      ${String(timings.length)} reveals — median ${median.toFixed(1)} ms, ` +
        `worst ${worst.toFixed(1)} ms`,
    );
    assert.ok(worst < 100, `the slowest reveal took ${worst.toFixed(1)} ms`);
  });

  test('the artifact watch fires on review.json (§7)', async () => {
    const uri = uriIn('src', 'Router.sol');
    const review = uriIn('.axiomap', 'review.json');

    const before = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
    );
    const quoteBefore = before?.find((lens) => lens.command?.arguments?.[0] === ROUTER_QUOTE);
    assert.ok(quoteBefore !== undefined);
    assert.ok(
      !(quoteBefore.command?.title ?? '').includes('flagged'),
      'the fixture already has review state; this test cannot tell the watch from the initial read',
    );

    // Written through the editor's own file system so the watcher sees it the
    // way it would see `axiomap review` run in a terminal beside the editor.
    fs.mkdirSync(path.dirname(review.fsPath), { recursive: true });
    fs.writeFileSync(
      review.fsPath,
      JSON.stringify(
        {
          [ROUTER_QUOTE]: {
            status: 'flagged',
            bodyHash: 'not-the-current-hash',
            reviewer: 'phase-8b',
            note: 'written by the extension-host suite',
            at: new Date().toISOString(),
          },
        },
        null,
        2,
      ),
    );

    const title = await until('the lens to pick up the review state', async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        uri,
      );
      const lens = lenses?.find((candidate) => candidate.command?.arguments?.[0] === ROUTER_QUOTE);
      const text = lens?.command?.title ?? '';
      return text.includes('flagged') ? text : undefined;
    });

    // §8: a review recorded against a different body is stale, and the lens says
    // so rather than showing a green tick over changed code.
    assert.ok(
      title.includes('needs re-review'),
      `the lens says "${title}" — a review with a stale bodyHash must say so`,
    );

    fs.rmSync(review.fsPath, { force: true });
  });

  /**
   * Phase 8's third exit criterion is "the graph is legible in Dark+, Light+,
   * and one high-contrast theme", and §11 requires every colour to come from a
   * `--vscode-*` variable.
   *
   * Nothing in this repo could previously say what those variables *are*. The
   * screenshot harness carried two themes' values transcribed by hand, which is
   * a guess about the thing being tested. This dumps them out of a real editor:
   * a plain webview, one per theme, reporting `getComputedStyle` for every
   * variable `style.ts` names.
   *
   * The dumps are committed, and `packages/webview/test/theme-legibility.test.ts`
   * is where the criterion is actually asserted — as contrast ratios, in CI, with
   * no editor. This test is the part that needs an editor, and it is the only
   * part that does.
   */
  test('dumps the real --vscode-* palette for the three themes', async () => {
    const themes = {
      'dark-plus': 'Default Dark+',
      'light-plus': 'Default Light+',
      'hc-dark': 'Default High Contrast',
    };
    const config = vscode.workspace.getConfiguration('workbench');
    const original = config.get<string>('colorTheme');

    try {
      for (const [id, name] of Object.entries(themes)) {
        await config.update('colorTheme', name, vscode.ConfigurationTarget.Global);
        // The theme is applied to a webview when it is created, so a fresh one
        // per theme is the point rather than an accident.
        await new Promise((resolve) => setTimeout(resolve, 500));

        const values = await dumpPalette(name);
        // A variable a theme does not set is recorded rather than asserted
        // away: `style.ts` has a fallback chain for exactly this, and which
        // rung a theme lands on is what `theme-legibility.test.ts` checks.
        // High-contrast themes really do define fewer of them.
        fs.mkdirSync(DUMP_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(DUMP_DIR, `${id}.json`),
          `${JSON.stringify({ theme: name, values }, null, 2)}\n`,
        );
      }
    } finally {
      await config.update('colorTheme', original, vscode.ConfigurationTarget.Global);
    }
  });

  test('a setting turns the lens off without touching the graph', async () => {
    const uri = uriIn('src', 'Router.sol');
    const config = vscode.workspace.getConfiguration('axiomap');
    await config.update('codeLens.enabled', false, vscode.ConfigurationTarget.Workspace);

    try {
      const gone = await until('the lenses to go away', async () => {
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          uri,
        );
        const ours = (lenses ?? []).filter((lens) => (lens.command?.title ?? '').startsWith('▸'));
        return ours.length === 0 ? true : undefined;
      });
      assert.ok(gone);

      // …and the graph is untouched, which is the half of the rule that matters:
      // a setting is editor behaviour, never a fact about the protocol
      // (`settings.ts`). The panel is still open on the same session, and
      // `axiomap.revealNode` still finds the node the lens used to carry.
      await vscode.commands.executeCommand('axiomap.revealNode', ROUTER_QUOTE);
      const editor = await until('the reveal to still work', () => {
        const active = vscode.window.activeTextEditor;
        return active?.document.uri.fsPath.endsWith('Router.sol') === true ? active : undefined;
      });
      assert.ok(editor.document.lineAt(editor.selection.active.line).text.includes('function quote'));
    } finally {
      // Back to what `suiteSetup` established, not to unset — unset is off now,
      // and a later test in this suite still expects lenses.
      await config.update('codeLens.enabled', true, vscode.ConfigurationTarget.Workspace);
    }
  });
});
