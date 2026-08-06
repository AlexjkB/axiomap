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
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runExport, startServe, type ServeSession } from '@axiomap/cli';

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
const LEGEND = "document.querySelector('.ax-legend')?.textContent ?? ''";

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

/** Toggle an overlay by its label, as the toolbar spells it. */
function toggleOverlay(label: string): string {
  return `
    (() => {
      const chip = [...document.querySelectorAll('.ax-overlay-row .ax-chip')]
        .find((button) => button.textContent.trim() === ${JSON.stringify(label)});
      if (!chip) return 'missing';
      chip.click();
      return 'ok';
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

  /**
   * An overlay that draws nothing looks exactly like an overlay with nothing to
   * report, which is the failure this project cares about most. Both halves are
   * here: a badge really reaches a node's computed style, and an overlay with
   * nothing to mark says so instead of looking like a clean result.
   */
  it('draws badges where an overlay marks something, and says when it marks nothing', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout/.test(value));

    // On the protocol map, danger ops is about functions and there are none.
    expect(await page.evaluate(toggleOverlay('Danger ops'))).toBe('ok');
    expect(await page.until(LEGEND, (value) => value.includes('nothing in this view'))).toContain(
      'nothing in this view',
    );

    // Inside a contract there are, and the strip reaches cytoscape's style.
    await page.evaluate(tap('[kind = "Contract"]'));
    await page.until(CURRENT_VIEW, (value) => value === 'Contract detail');
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    const badged = await page.until(
      `
        (() => {
          const cy = document.querySelector('.ax-canvas')._cyreg.cy;
          const marked = cy.nodes().filter((node) => node.data('badges') !== undefined);
          if (marked.length === 0) return '0';
          return marked.length + ':' + String(marked.first().style('background-image')).slice(0, 24);
        })()
      `,
      (value) => value !== '0',
    );
    expect(badged).toMatch(/^\d+:data:image\/svg\+xml/);
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
