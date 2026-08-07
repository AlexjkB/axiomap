/**
 * The graph, in a real browser.
 *
 * Everything else about the renderer is testable without one — the elements
 * cytoscape is handed, the ELK graph, the positions that come back, the
 * component's data flow under jsdom — and all of it passed while the layout
 * engine was **completely dead**: a bundler interop problem left `new ELK()`
 * throwing inside the worker, the promise rejected into a `catch` that treated
 * it like a superseded request, and every view rendered in its unlaid-out
 * placeholder positions. Nothing in the suite noticed, because nothing in the
 * suite ran a browser.
 *
 * So this does the one thing the others cannot: load the page, wait, and check
 * that the layout actually landed and that the page logged no uncaught error.
 * It drives Chrome over the DevTools protocol with Node's built-in WebSocket —
 * no new dependency — and skips when there is no Chrome to drive, the way
 * `core`'s worker tests skip without a build.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runExport, startServe, type ServeSession } from '@axiomap/cli';
import { buildProjectGraph, overlayData } from '@axiomap/core';
import { CHANNEL } from '@axiomap/webview';
import { answer, isBridgeRequest, type HostSources } from '@axiomap/vscode/host';
import { webviewBundle } from '@axiomap/vscode/assets';
import { webviewHtml } from '@axiomap/vscode/html';

const CHROME = ['google-chrome', 'chromium', 'chromium-browser'].find(
  (candidate) => spawnSync(candidate, ['--version'], { timeout: 10_000 }).status === 0,
);

/** A minimal CDP client: enough to open a page, poll it, and read the console. */
class Page {
  private constructor(
    private readonly chrome: ChildProcess,
    private readonly socket: WebSocket,
    private readonly sessionId: string,
  ) {}

  private nextId = 1;
  private readonly pending = new Map<number, (result: unknown) => void>();
  readonly consoleErrors: string[] = [];

  static async open(binary: string): Promise<Page> {
    const chrome = spawn(
      binary,
      ['--headless=new', '--remote-debugging-port=0', '--window-size=1400,900', 'about:blank'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const wsUrl = await new Promise<string>((resolve, reject) => {
      let banner = '';
      const timer = setTimeout(() => {
        reject(new Error('Chrome never announced a DevTools endpoint.'));
      }, 30_000);
      chrome.stderr?.on('data', (chunk: Buffer) => {
        banner += chunk.toString();
        const match = /ws:\/\/\S+/.exec(banner);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });

    const socket = new WebSocket(wsUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    const page = new Page(chrome, socket, '');
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as {
        id?: number;
        method?: string;
        params?: { entry?: { level?: string; text?: string } };
        result?: unknown;
      };
      if (message.id !== undefined) {
        page.pending.get(message.id)?.(message.result);
        page.pending.delete(message.id);
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        page.consoleErrors.push(message.params.entry.text ?? '');
      }
    });

    const target = (await page.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const attached = (await page.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    const attachedPage = new Page(chrome, socket, attached.sessionId);
    // Reuse the one socket and its handlers; only the session differs.
    Object.assign(attachedPage, {
      pending: page.pending,
      consoleErrors: page.consoleErrors,
      nextId: page.nextId,
    });
    await attachedPage.send('Log.enable');
    // Required before `Page.addScriptToEvaluateOnNewDocument`, and its absence
    // is silent: the theme never arrives and the page looks like the fallback.
    await attachedPage.send('Page.enable');
    return attachedPage;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(this.sessionId === '' ? {} : { sessionId: this.sessionId }),
        }),
      );
    });
  }

  async evaluate(expression: string): Promise<string> {
    const result = (await this.send('Runtime.evaluate', { expression, returnByValue: true })) as {
      result?: { value?: unknown };
    };
    return String(result.result?.value ?? '');
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
  }

  /** Set a host's theme variables before the app boots, as VS Code does. */
  async theme(variables: Record<string, string>): Promise<void> {
    const source = Object.entries(variables)
      .map(
        ([name, value]) =>
          `document.documentElement.style.setProperty(${JSON.stringify(name)}, ${JSON.stringify(value)});`,
      )
      .join('\n');
    /*
     * Twice: once at document start, where the app will read it, and once on
     * `DOMContentLoaded` as the fallback for a document whose root element does
     * not exist yet. Only the first ordering actually themes the canvas — the
     * palette is read when the app mounts — and a silent `null` root is how the
     * first attempt at this quietly screenshotted the fallback palette.
     */
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        `const apply = () => {\n${source}\n};\n` +
        'if (document.documentElement) apply();\n' +
        "document.addEventListener('DOMContentLoaded', apply);",
    });
  }

  /** Poll until the predicate holds, or give up and return what it last saw. */
  async until(expression: string, holds: (value: string) => boolean, tries = 60): Promise<string> {
    let value = '';
    for (let attempt = 0; attempt < tries; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      value = await this.evaluate(expression);
      if (holds(value)) return value;
    }
    return value;
  }

  close(): void {
    this.socket.close();
    this.chrome.kill();
  }
}

const METRICS = "document.querySelector('.ax-metrics')?.textContent ?? ''";
const CURRENT_VIEW = "document.querySelector('.ax-view-current')?.textContent ?? ''";
const INSPECTOR = "document.querySelector('.ax-inspector')?.textContent ?? ''";

/** Click a node the way a mouse would — cytoscape draws to a canvas. */
function tap(selector: string): string {
  return `
    (() => {
      const cy = document.querySelector('.ax-canvas')._cyreg.cy;
      const node = cy.nodes(${JSON.stringify(selector)}).first();
      if (node.empty()) return '';
      node.emit('tap');
      return node.id();
    })()
  `;
}

let session: ServeSession;
let page: Page;

beforeAll(async () => {
  if (CHROME === undefined) return;
  session = await startServe({ path: 'fixtures/defi', port: 0, open: false });
  page = await Page.open(CHROME);
}, 120_000);

afterAll(async () => {
  page?.close();
  await session?.handle.close();
});

describe.skipIf(CHROME === undefined)('the graph in a browser', () => {
  it('draws the protocol map and lays it out in the worker (§9 rule 6)', async () => {
    await page.goto(session.handle.url);
    const metrics = await page.until(METRICS, (value) => /layout/.test(value));

    // The claim §9 rule 6 makes, checked where it is either true or false.
    expect(metrics).toMatch(/layout \d+ ms \(worker\)/);
    expect(metrics).not.toMatch(/layout failed/);
    expect(metrics).toMatch(/\d+ \/ 1500 elements/);
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  it('drills down when a contract is clicked', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout/.test(value));

    await page.evaluate(tap('[kind = "Contract"]'));

    const view = await page.until(CURRENT_VIEW, (value) => value === 'Contract detail');
    expect(view).toBe('Contract detail');
    expect(await page.until(METRICS, (value) => /layout/.test(value))).toMatch(/layout \d+ ms/);
  }, 120_000);

  /**
   * §11: "Palette derives entirely from VS Code CSS variables. No hard-coded
   * hex", and §7's Phase 8 makes the browser palette a *fallback* that maps onto
   * them. Every other test of that is a unit test of `readPalette` against a
   * stub, and nothing in this repo ever *set* one of those variables — so the
   * chain that matters in Phase 8 (a host sets a variable → `getComputedStyle`
   * → the palette → cytoscape's own colour parser) had never run end to end.
   * It is one navigation to check, and cheaper here than in the phase whose
   * exit criterion is three themes.
   */
  it('takes its colours from the host’s theme when one sets them', async () => {
    const themed = await Page.open(CHROME as string);
    try {
      await themed.theme({
        '--vscode-editor-background': '#ffffff',
        '--vscode-charts-blue': '#1a85ff',
      });
      await themed.goto(session.handle.url);
      await themed.until(METRICS, (value) => /layout \d+ ms/.test(value));

      // The page chrome, and the canvas, which reads the same variables through
      // a different path — cytoscape cannot parse `var(--x)`, so `style.ts`
      // resolves them itself and this is where that resolution is either right
      // or silently the fallback.
      const background = await themed.evaluate(
        "getComputedStyle(document.body).backgroundColor",
      );
      expect(background).toBe('rgb(255, 255, 255)');

      const border = await themed.evaluate(`
        (() => {
          const cy = document.querySelector('.ax-canvas')._cyreg.cy;
          return String(cy.nodes('[kind = "Contract"]').first().style('border-color'));
        })()
      `);
      expect(border.replace(/\s/g, '')).toBe('rgb(26,133,255)');
      expect(themed.consoleErrors.join('\n')).toBe('');
    } finally {
      themed.close();
    }
  }, 120_000);

  /**
   * §11's inspector, in a browser, because what is worth checking is that the
   * panel was filled from the host rather than from the drawn view — and the
   * drawn view lives on a canvas no unit test has.
   */
  it('fills the inspector from the host when a node is clicked', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout/.test(value));

    const id = await page.evaluate(tap('[kind = "Contract"]'));
    expect(id).not.toBe('');

    // `textContent`, so this is the markup's casing rather than the CSS's.
    const panel = await page.until(INSPECTOR, (value) => /Members\s*\d+/.test(value));
    expect(panel).toMatch(/Members\s*\d+/);
    // `linearization` is a §10 attribute of the node and not part of the
    // element the canvas was handed: it can only have come from /api/node.
    expect(panel).toMatch(/linearization/);
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  /**
   * §9 rule 3's drill-down, in the direction that was broken.
   *
   * 7a's auto-expansion opens directories nobody put in the `expand` set, so a
   * click that toggled *set membership* added a box that was visibly open —
   * one click did nothing, and only the second closed it. It was invisible to
   * the reducer's own tests, which had never been given a cluster that was open
   * without having been opened, and obvious the moment a 298-contract project
   * was on screen.
   */
  it('closes a directory the engine opened, on the first click', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout/.test(value));

    const count = async (): Promise<number> =>
      Number(
        await page.evaluate(
          "(() => document.querySelector('.ax-canvas')._cyreg.cy.nodes().length)()",
        ),
      );

    const before = await count();
    expect(before).toBeGreaterThan(3);

    // A directory that is drawn open but is not `src` — closing the root would
    // be a different (and duller) assertion.
    const path = await page.evaluate(`
      (() => {
        const cy = document.querySelector('.ax-canvas')._cyreg.cy;
        const box = cy.nodes('[kind = "Cluster"]')
          .filter((node) => node.data('expanded') && node.data('path') !== 'src')
          .first();
        if (box.empty()) return '';
        box.emit('tap');
        return String(box.data('path'));
      })()
    `);
    expect(path).not.toBe('');

    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));
    // One click, fewer nodes. Not "the same picture, and try again".
    const after = await page.until(
      "(() => String(document.querySelector('.ax-canvas')._cyreg.cy.nodes().length))()",
      (value) => Number(value) < before,
    );
    expect(Number(after)).toBeLessThan(before);
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

});

/**
 * The deliverable, opened the way a client opens it (Phase 7e).
 *
 * §15's ninth item is "export one HTML file and send it to a client", and the
 * only place that is either true or false is a browser pointed at a `file://`
 * URL — no server, no origin, a `StaticBridge` with nothing on the other end.
 * Phase 7d drove this by hand and found that **every function click missed**,
 * because the exporter embedded a request the UI never sends. Nothing in the
 * suite could have caught it.
 *
 * Phase 7e changed the payload format underneath all of that — one node table,
 * views and inspections holding ids — so the walk is a test now rather than a
 * session someone remembers doing.
 */
describe.skipIf(CHROME === undefined)('the export in a browser', () => {
  let exported: string;
  let file: Page;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-export-browser-'));
    exported = path.join(dir, 'deliverable.html');
    await runExport({ path: 'fixtures/defi', format: 'html', out: exported });
    file = await Page.open(CHROME as string);
  }, 300_000);

  afterAll(() => {
    file?.close();
    fs.rmSync(path.dirname(exported), { recursive: true, force: true });
  });

  it('opens on a laid-out map, drills to a function, and shows its code', async () => {
    await file.goto(`file://${exported}`);

    // 1. It opened, and ELK ran — from a `Blob` worker, which is the sense in
    //    which this file redistributes elkjs.
    const metrics = await file.until(METRICS, (value) => /layout/.test(value));
    expect(metrics).toMatch(/layout \d+ ms/);
    expect(metrics).not.toMatch(/layout failed/);

    // 2. Protocol → contract. The nodes were reassembled from the table on the
    //    way through the bridge, so a drawn label is evidence hydration ran.
    const contractId = await file.evaluate(tap('[kind = "Contract"]'));
    expect(contractId).not.toBe('');
    expect(await file.until(CURRENT_VIEW, (value) => value === 'Contract detail')).toBe(
      'Contract detail',
    );

    // 3. The inspector, filled from an embedded inspection — `linearization` is
    //    a §10 node attribute and not part of the drawn element.
    expect(await file.until(INSPECTOR, (value) => /linearization/.test(value))).toMatch(
      /linearization/,
    );

    // 4. Contract → function → call graph. This is the click that was broken in
    //    the file Phase 7d shipped, and the one the quota now guarantees room
    //    for on a project too big to embed whole.
    await file.until(METRICS, (value) => /layout \d+ ms/.test(value));
    const functionId = await file.evaluate(tap('[kind = "Function"]'));
    expect(functionId).not.toBe('');
    expect(await file.until(CURRENT_VIEW, (value) => value === 'Call graph')).toBe('Call graph');

    // 5. §11's code preview, from a source range the file carries: real
    //    Solidity, highlighted, with no host to fetch it from.
    const code = await file.until(
      "document.querySelector('.ax-code')?.textContent ?? ''",
      (value) => value.trim() !== '',
    );
    expect(code).toMatch(/function|contract/);

    expect(file.consoleErrors.join('\n')).toBe('');
  }, 300_000);

  /**
   * Payload v2, checked where it could only be checked here: the page's own
   * payload holds *ids* in its views, and the canvas holds nodes with §10
   * attributes on them. Between the two is `hydrateView`, running in a browser
   * against a file the CLI wrote — the pair `serve-protocol.test.ts` pins in
   * isolation, joined up.
   */
  it('draws nodes it reassembled from the file’s node table', async () => {
    await file.goto(`file://${exported}`);
    await file.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // The stored form: no node object anywhere in the embedded views.
    const stored = await file.evaluate(`
      (() => {
        const payload = window.__AXIOMAP_PAYLOAD__;
        const drawn = payload.views.flatMap((entry) =>
          entry.view.nodes.filter((element) => element.type === 'node'));
        return [
          String(payload.payloadVersion),
          String(drawn.length > 0),
          String(drawn.every((element) => element.node === undefined)),
          String(Object.keys(payload.nodeTable).length > 0),
        ].join('|');
      })()
    `);
    expect(stored).toBe('2|true|true|true');

    // The drawn form: cytoscape was handed a whole node, kind and all.
    const kinds = await file.evaluate(`
      (() => {
        const cy = document.querySelector('.ax-canvas')._cyreg.cy;
        return [...new Set(cy.nodes().map((node) => String(node.data('kind'))))].sort().join(',');
      })()
    `);
    expect(kinds).toContain('Contract');
    expect(file.consoleErrors.join('\n')).toBe('');
  }, 120_000);
});

/**
 * The fourth host, in a real browser (Phase 8).
 *
 * There is no VS Code here to run an extension in, and there will not be one in
 * CI either. What *can* be run is the half that has been wrong three times in
 * this project's history: the bundle, in a browser, with the layout engine
 * actually starting. So the page below is the document the extension serves —
 * `webviewHtml`, verbatim, CSP included — and the extension host is faked by
 * this test: a shim provides `acquireVsCodeApi`, the requests it collects are
 * pumped out over CDP, and each one is answered by `answer()`, which is the same
 * function the real panel calls.
 *
 * What that covers is exactly what a unit test cannot: the CSP does not block
 * the bundle, the ELK worker starts from a blob (§9 rule 6, the *one* thing
 * that differs from browser mode), the bridge's correlation ids match up across
 * a real `postMessage`, and §11's reveal leaves the page when a node is clicked.
 *
 * What it does not cover is the editor's own half — that a `reveal` moves a
 * cursor, that a lens appears above a function. Those need an extension host;
 * they are the packaging session's, with a `.vsix` installed in a real editor.
 */
describe.skipIf(CHROME === undefined)('the graph in a VS Code webview', () => {
  let served: { url: string; close: () => Promise<void> } | undefined;
  let host: Page | undefined;
  let sources: HostSources;
  let pump: NodeJS.Timeout | undefined;

  /** Everything the extension would hold, without the extension. */
  beforeAll(async () => {
    if (CHROME === undefined) return;
    const built = await buildProjectGraph('fixtures/defi', {
      cacheDir: null,
      workers: 1,
      enrich: false,
    });
    sources = {
      graph: built.graph,
      file: built.file,
      root: path.resolve('fixtures/defi'),
      renderCap: 1500,
      overlays: overlayData(built.graph, { review: null, findings: null }),
    };

    const bundle = webviewBundle('/nonexistent-extension');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-webview-'));

    /*
     * The shim is the whole of the fake: `postMessage` puts the request on a
     * queue this test drains, and the answers come back the way the editor
     * sends them — a `message` event on `window`. It is nonce'd because the
     * document's own CSP is under test, and an inline script without one would
     * be refused, which is the correct behaviour and would break the harness.
     */
    const document = webviewHtml({
      scriptUri: './vscode.js',
      styleUri: './vscode.css',
      cspSource: "'self'",
      nonce: 'harness',
      elkWorker: bundle.elkWorker,
    }).replace(
      '<div id="root"></div>',
      '<div id="root"></div>\n' +
        '<script nonce="harness">window.__sent = []; window.__events = [];' +
        'window.acquireVsCodeApi = () => ({ postMessage: (message) => {' +
        // Requests are drained and answered by the pump below; notifications
        // (§11's `reveal`) are kept, because they are what a test asserts on.
        "  (message && message.method ? window.__sent : window.__events).push(message);" +
        '} });' +
        '</script>',
    );

    fs.writeFileSync(path.join(dir, 'index.html'), document);
    fs.copyFileSync(bundle.script, path.join(dir, 'vscode.js'));
    fs.copyFileSync(bundle.style, path.join(dir, 'vscode.css'));

    // A module script cannot be loaded cross-origin, and `file://` is one — so
    // the harness serves the directory the way the editor serves its bundle.
    const server = http.createServer((request, response) => {
      const requested = (request.url ?? '/').split('?')[0] ?? '/';
      if (requested === '/favicon.ico') {
        // The editor answers this itself; a 404 in the console of a tool asking
        // to be trusted is the same bad first impression `serve` avoids.
        response.writeHead(204).end();
        return;
      }
      const name = requested === '/' ? 'index.html' : requested.slice(1);
      const target = path.join(dir, path.basename(name));
      if (!fs.existsSync(target)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': target.endsWith('.css')
          ? 'text/css'
          : target.endsWith('.js')
            ? 'text/javascript'
            : 'text/html',
      });
      response.end(fs.readFileSync(target));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    served = {
      url: `http://127.0.0.1:${String(port)}/`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    };

    host = await Page.open(CHROME);
  }, 180_000);

  afterAll(async () => {
    if (pump !== undefined) clearInterval(pump);
    host?.close();
    await served?.close();
  });

  /** Drain the webview's outbox and answer it, the way `panel.ts` does. */
  function startPump(page: Page): NodeJS.Timeout {
    return setInterval(() => {
      void (async () => {
        const drained = await page.evaluate(
          '(() => { const out = window.__sent ?? []; window.__sent = []; return JSON.stringify(out); })()',
        );
        const messages = JSON.parse(drained === '' ? '[]' : drained) as unknown[];
        for (const message of messages) {
          if (!isBridgeRequest(message)) continue;
          const response = answer(sources, message);
          await page.evaluate(`window.postMessage(${JSON.stringify(response)}, '*')`);
        }
      })();
    }, 50);
  }

  it('mounts, answers over postMessage, and lays out in a blob worker', async () => {
    const page = host as Page;
    await page.goto((served as { url: string }).url);
    pump = startPump(page);

    const metrics = await page.until(METRICS, (value) => /layout/.test(value));
    // §9 rule 6, in the host where the worker had to come from a blob: a
    // cross-origin worker script is refused, so this is the line that would say
    // `layout failed` if the blob route had been wrong.
    expect(metrics).toMatch(/layout \d+ ms \(worker\)/);
    expect(metrics).not.toMatch(/layout failed/);
    expect(metrics).toMatch(/\d+ \/ 1500 elements/);
    // A CSP violation is a console error, which is why this assertion is the
    // one that covers the policy in `html.ts` end to end.
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 180_000);

  it('asks the editor to reveal the node that was clicked (§11)', async () => {
    const page = host as Page;
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // Everything the shim collects from here on is what the extension host
    // would have received.
    const clicked = await page.evaluate(tap('[kind = "Contract"]'));
    expect(clicked).not.toBe('');

    const reveal = await page.until(
      "JSON.stringify((window.__events ?? []).filter((message) => message.event === 'reveal'))",
      (value) => value !== '[]' && value !== '',
    );
    const targets = JSON.parse(reveal) as { target: { kind: string; id: string } }[];
    expect(targets[0]?.target).toEqual({ kind: 'node', id: clicked });
  }, 180_000);

  it('selects the node the editor’s cursor landed on, without navigating (§11)', async () => {
    const page = host as Page;
    await page.goto((served as { url: string }).url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));
    const before = await page.evaluate(CURRENT_VIEW);

    const id = await page.evaluate(`
      (() => {
        const cy = document.querySelector('.ax-canvas')._cyreg.cy;
        return cy.nodes('[kind = "Contract"]').first().id();
      })()
    `);
    const select = { channel: CHANNEL, event: 'select', id, kind: 'Contract' };
    await page.evaluate(`window.postMessage(${JSON.stringify(select)}, '*')`);

    // The inspector opens on it — and the view does not change, which is the
    // difference between `select` and `focus` that `vscode.ts` explains.
    const inspector = await page.until(INSPECTOR, (value) => value.includes(id.split(':').pop() ?? ''));
    expect(inspector).toContain(id.split(':').pop());
    expect(await page.evaluate(CURRENT_VIEW)).toBe(before);
  }, 180_000);
});
