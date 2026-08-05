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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServe, type ServeSession } from '@axiomap/cli';

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
