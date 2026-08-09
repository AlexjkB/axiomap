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
import { buildProjectGraph, auditState } from '@axiomap/core';
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

  /**
   * Press, move, release — a real drag, not a synthesised `grab` event.
   *
   * The lock is a cytoscape option, so asserting it by calling cytoscape back
   * ("is `autoungrabify` on?") would only restate the line that sets it. What
   * decides whether a node moves is the pointer, so the pointer is what this
   * sends: CDP mouse events at viewport coordinates, which is the same input
   * path a hand on a mouse produces.
   */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    const at = (type: string, point: { x: number; y: number }): Promise<unknown> =>
      this.send('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
    await at('mousePressed', from);
    // Intermediate moves, because a single jump can be read as a click that
    // happened to end elsewhere rather than as a drag.
    for (const step of [0.25, 0.5, 0.75, 1]) {
      await at('mouseMoved', {
        x: from.x + (to.x - from.x) * step,
        y: from.y + (to.y - from.y) * step,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await at('mouseReleased', to);
  }

  /**
   * One mouse event, with the button state spelled out.
   *
   * `buttons` is the field that matters for the drag-ended-off-window case: a
   * pointer coming back into the page after being released outside reports
   * `buttons: 0`, and that is the only evidence the page ever gets that the
   * release happened.
   */
  async mouse(
    type: string,
    point: { x: number; y: number },
    buttons: number,
  ): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: buttons === 0 ? 'none' : 'left',
      buttons,
      clickCount: buttons === 0 ? 0 : 1,
    });
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
const NOTE = "document.querySelector('.ax-note')?.textContent ?? ''";
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

/**
 * Double-click a node — the gesture that *opens* one.
 *
 * Both events, in the order cytoscape sends them: a real double click is two
 * taps and then a `dbltap`, not a `dbltap` on its own. Emitting only the last
 * would test a handler in isolation and miss the thing worth checking, which is
 * that the select-then-open pair leaves the app in the right place.
 */
function doubleTap(selector: string): string {
  return `
    (() => {
      const cy = document.querySelector('.ax-canvas')._cyreg.cy;
      const node = cy.nodes(${JSON.stringify(selector)}).first();
      if (node.empty()) return '';
      node.emit('tap');
      node.emit('tap');
      node.emit('dbltap');
      return node.id();
    })()
  `;
}

/**
 * Where a node is on screen, and where the graph thinks it is.
 *
 * Two different questions, and the drag test needs both: the rendered point is
 * where to put the mouse down, and the model position is the thing that must
 * not change while the canvas is locked. Reading the rendered point rather than
 * guessing one also means the test drags the node that is actually there, at
 * whatever zoom the fit settled on.
 */
const FIRST_NODE = `
  (() => {
    const canvas = document.querySelector('.ax-canvas');
    const cy = canvas._cyreg.cy;
    const node = cy.nodes('[kind = "Contract"]').first();
    if (node.empty()) return '';
    const box = canvas.getBoundingClientRect();
    const rendered = node.renderedPosition();
    const model = node.position();
    return [
      node.id(),
      box.left + rendered.x,
      box.top + rendered.y,
      model.x,
      model.y,
    ].join('|');
  })()
`;

/** The model position of a node by id, as `x|y`, after the drag. */
function positionOf(id: string): string {
  return `
    (() => {
      const cy = document.querySelector('.ax-canvas')._cyreg.cy;
      const node = cy.getElementById(${JSON.stringify(id)});
      return node.empty() ? '' : [node.position().x, node.position().y].join('|');
    })()
  `;
}

const LOCK = "document.querySelector('.ax-zoom [aria-pressed]')";

/**
 * A point on the canvas with nothing drawn on it, in viewport coordinates.
 *
 * Pressing on a node and pressing on the background are different gestures and
 * only the second one pans — the first attempt at the drag-release test pressed
 * on a node, panned nothing, and passed while the bug it was written for was
 * still there. So the empty point is computed from the graph's own rendered
 * bounding box rather than guessed at.
 */
const EMPTY_POINT = `
  (() => {
    const canvas = document.querySelector('.ax-canvas');
    const cy = canvas._cyreg.cy;
    const box = canvas.getBoundingClientRect();
    const drawn = cy.elements().renderedBoundingBox();
    // Below everything the graph drew, still inside the canvas.
    const y = Math.min(box.top + drawn.y2 + 40, box.bottom - 20);
    return [box.left + 60, y].join('|');
  })()
`;

/** Where the viewport is, as `x|y`, rounded so a sub-pixel drift is not a diff. */
const PAN = `
  (() => {
    const cy = document.querySelector('.ax-canvas')._cyreg.cy;
    const pan = cy.pan();
    return [Math.round(pan.x), Math.round(pan.y)].join('|');
  })()
`;

/** The zoom level, so a reset can be shown not to touch it. */
const ZOOM = `
  (() => {
    const cy = document.querySelector('.ax-canvas')._cyreg.cy;
    return String(Math.round(cy.zoom() * 100) / 100);
  })()
`;

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

  /**
   * One click reads a contract, two open it.
   *
   * A single click used to navigate, which meant a contract could not be
   * inspected without losing the map it was found on — the same click that
   * fills the inspector and dims the neighbourhood threw away the view they
   * describe. The negative half is the point of the test: staying put is the
   * behaviour that regressed, and it is the one nothing else would catch.
   */
  it('selects a contract on one click and opens it on two', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout/.test(value));

    const id = await page.evaluate(tap('[kind = "Contract"]'));
    expect(id).not.toBe('');

    // The inspector fills, so the click certainly landed...
    expect(await page.until(INSPECTOR, (value) => value !== '')).not.toBe('');
    /*
     * ...and the view did not move. Polled rather than read once, so a
     * navigation that is merely slow still fails this — but with a short
     * budget, because this is the one assertion here that can only be settled
     * by waiting for nothing to happen, and the default sixty tries spend
     * thirty seconds proving it every run. Three seconds is many times the
     * measured layout of this fixture.
     */
    expect(await page.until(CURRENT_VIEW, (value) => value !== 'Protocol map', 6)).toBe(
      'Protocol map',
    );
    // The focus is set even though nothing navigated, which is what un-disables
    // the focus-dependent tabs and puts the chip in the toolbar.
    expect(await page.evaluate("document.querySelector('.ax-focus code')?.textContent ?? ''")).toBe(
      id,
    );

    // Two clicks open it.
    await page.evaluate(doubleTap('[kind = "Contract"]'));
    expect(await page.until(CURRENT_VIEW, (value) => value === 'Contract detail')).toBe(
      'Contract detail',
    );
    expect(await page.until(METRICS, (value) => /layout/.test(value))).toMatch(/layout \d+ ms/);
  }, 120_000);

  /**
   * The inspector's `focus` chip lands on contract detail, not on an empty view.
   *
   * It used to route by kind, through the same `pick` a canvas click uses: a
   * Function went to the call graph, so focusing a modifier like `nonReentrant`
   * opened a graph with one node and no edges, and focusing an event or a
   * storage slot did nothing at all, because `pick` has no view for those
   * kinds. The relation list is full of both.
   *
   * Driven through the real chip rather than the reducer — `navigation.test.ts`
   * covers the rule itself, and what this adds is that the button in the panel
   * is wired to it.
   */
  it('opens contract detail from an inspector focus chip', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // One click: selected, inspector filled with the contract's members, and
    // still on the protocol map.
    await page.evaluate(tap('[kind = "Contract"]'));
    await page.until(INSPECTOR, (value) => /Members\s*\d+/.test(value));
    expect(await page.evaluate(CURRENT_VIEW)).toBe('Protocol map');

    /*
     * The first member's own `focus` chip. Whatever kind it happens to be —
     * function, storage, event — the answer must be the same view.
     */
    const clicked = await page.evaluate(`
      (() => {
        const row = document.querySelector('.ax-relations li');
        if (row === null) return 'no member rows';
        const chip = row.querySelector('.ax-chip');
        if (chip === null) return 'no focus chip';
        chip.click();
        return row.querySelector('.ax-relation-meta')?.textContent ?? 'clicked';
      })()
    `);
    expect(clicked).not.toBe('no member rows');
    expect(clicked).not.toBe('no focus chip');

    expect(await page.until(CURRENT_VIEW, (value) => value === 'Contract detail')).toBe(
      'Contract detail',
    );
    expect(await page.until(METRICS, (value) => /layout \d+ ms/.test(value))).toMatch(/layout/);
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  /**
   * The lock, at the only place it is either true or false: a mouse.
   *
   * Both halves are asserted in one test on purpose. "The node did not move" is
   * worthless on its own — it also passes if the drag never reached the canvas,
   * if the coordinates were wrong, or if the whole gesture silently did
   * nothing. The unlocked drag is the control that proves the input path works,
   * and the locked one is then a real answer rather than a tautology.
   */
  it('holds nodes in place until the lock is released', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // Locked on arrival: the button says so, and cytoscape agrees.
    expect(await page.evaluate(`${LOCK}.getAttribute('aria-pressed')`)).toBe('true');

    const [id, screenX, screenY, modelX, modelY] = (await page.evaluate(FIRST_NODE)).split('|');
    expect(id).not.toBe('');
    const from = { x: Number(screenX), y: Number(screenY) };
    const to = { x: from.x + 120, y: from.y + 90 };
    const before = `${modelX}|${modelY}`;

    await page.drag(from, to);
    expect(await page.evaluate(positionOf(id))).toBe(before);

    /*
     * Now unlock and drag the same node again. The screen point is re-read
     * rather than reused: the locked drag panned the viewport, which is what a
     * press-and-drag over a locked canvas is supposed to do, so the node is no
     * longer under the old coordinates.
     */
    await page.evaluate(`${LOCK}.click()`);
    expect(await page.evaluate(`${LOCK}.getAttribute('aria-pressed')`)).toBe('false');

    const moved = (await page.evaluate(FIRST_NODE)).split('|');
    await page.drag(
      { x: Number(moved[1]), y: Number(moved[2]) },
      { x: Number(moved[1]) + 120, y: Number(moved[2]) + 90 },
    );
    expect(await page.evaluate(positionOf(id))).not.toBe(before);

    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  /**
   * Selecting one node fades everything unrelated to it.
   *
   * Asserted as the *relationship* rather than as a count: the selection and
   * its one-hop neighbourhood carry no dim class, something outside it does.
   * A count would be a fixture fingerprint that changes whenever `defi` does,
   * and would still pass if the wrong elements were the dim ones.
   */
  it('dims everything unrelated to the selected node', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // Into a contract, where functions and storage are drawn together — the
    // view the dimming was asked for. Two clicks, since one now only selects.
    await page.evaluate(doubleTap('[kind = "Contract"]'));
    await page.until(CURRENT_VIEW, (value) => value === 'Contract detail');
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // A state variable selects without navigating away, so the assertion runs
    // against the view the click landed in.
    const picked = await page.evaluate(tap('[kind = "StateVariable"]'));
    expect(picked).not.toBe('');

    const state = await page.until(
      `
        (() => {
          const cy = document.querySelector('.ax-canvas')._cyreg.cy;
          const chosen = cy.getElementById(${JSON.stringify(picked)});
          if (chosen.empty()) return 'missing';
          const near = chosen.closedNeighborhood();
          return [
            chosen.hasClass('ax-dimmed') ? 'selection-dimmed' : 'selection-lit',
            near.filter('.ax-dimmed').length === 0 ? 'neighbours-lit' : 'neighbours-dimmed',
            cy.elements('.ax-dimmed').length > 0 ? 'rest-dimmed' : 'rest-lit',
          ].join('|');
        })()
      `,
      (value) => value !== '' && value !== 'missing',
    );
    expect(state).toBe('selection-lit|neighbours-lit|rest-dimmed');

    /*
     * And it lifts. Closing the inspector is how a selection is cleared, and
     * a graph left permanently dimmed after one stray click would be a worse
     * problem than the clutter this fixes.
     */
    const closed = await page.evaluate(`
      (() => {
        const button = document.querySelector('.ax-inspect-head .ax-chip');
        if (button === null) return 'no close button';
        button.click();
        return 'closed';
      })()
    `);
    expect(closed).toBe('closed');

    const cleared = await page.until(
      "String(document.querySelector('.ax-canvas')._cyreg.cy.elements('.ax-dimmed').length)",
      (value) => value === '0',
    );
    expect(cleared).toBe('0');
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  /**
   * A selection two of the five views cannot draw still dims them.
   *
   * The protocol map is contracts only and the inheritance tree keeps a
   * function only when it is on one end of an override, so carrying a member
   * selection back to either handed the canvas an id it could not find and the
   * dimming quietly switched off — a fully lit graph, which is also what a
   * broken selection looks like. The stand-in is the member's own contract, and
   * the assertion is that the ring lands there while the inspector is still
   * describing the member.
   */
  it('anchors the dimming on the contract when the view cannot draw the selection', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    await page.evaluate(doubleTap('[kind = "Contract"]'));
    await page.until(CURRENT_VIEW, (value) => value === 'Contract detail');
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // A state variable: selects without navigating, and the protocol map draws
    // no storage at all, so it is exactly the case this is about.
    const picked = await page.evaluate(tap('[kind = "StateVariable"]'));
    expect(picked).not.toBe('');
    // Wait for the inspection to land — it is what names the container.
    await page.until(INSPECTOR, (value) => value !== '');

    await page.evaluate(`
      [...document.querySelectorAll('.ax-view')]
        .find((button) => button.textContent === 'Protocol map')?.click();
      'switched'
    `);
    await page.until(CURRENT_VIEW, (value) => value === 'Protocol map');
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    const state = await page.until(
      `
        (() => {
          const cy = document.querySelector('.ax-canvas')._cyreg.cy;
          if (!cy.getElementById(${JSON.stringify(picked)}).empty()) return 'drawn';
          const ringed = cy.nodes(':selected');
          if (ringed.length !== 1) return 'ring:' + ringed.length;
          return [
            ringed.first().data('kind'),
            ringed.first().hasClass('ax-dimmed') ? 'anchor-dimmed' : 'anchor-lit',
            cy.elements('.ax-dimmed').length > 0 ? 'rest-dimmed' : 'rest-lit',
          ].join('|');
        })()
      `,
      (value) => value !== '' && value !== 'drawn' && !value.startsWith('ring:'),
    );
    expect(state).toBe('Contract|anchor-lit|rest-dimmed');

    // …and it says so, rather than letting the ring read as a selection the
    // user did not make.
    expect(await page.evaluate(NOTE)).toMatch(/is not drawn in this view — highlighting /);
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  /**
   * Clearing the focus puts the graph back.
   *
   * The focus and the selection are two different pieces of state that a click
   * happens to set together, and "clear" only ever spoke to the first — so the
   * protocol map came back unfocused and still faded around a node the user had
   * finished with, with no control left on screen that would undo it. The
   * inspector's own close button was the only way out, and it is not what
   * anyone reaches for after clearing the focus.
   */
  it('undims the protocol map when the focus is cleared', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // Opening the contract sets both the focus and the selection.
    await page.evaluate(doubleTap('[kind = "Contract"]'));
    await page.until(CURRENT_VIEW, (value) => value === 'Contract detail');
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // Back to the protocol map, which is drawn dimmed around the selection.
    await page.evaluate(`
      [...document.querySelectorAll('.ax-view')]
        .find((button) => button.textContent === 'Protocol map')?.click();
      'switched'
    `);
    await page.until(CURRENT_VIEW, (value) => value === 'Protocol map');
    const dimmed = await page.until(
      "String(document.querySelector('.ax-canvas')._cyreg.cy.elements('.ax-dimmed').length)",
      (value) => value !== '0' && value !== '',
    );
    expect(Number(dimmed)).toBeGreaterThan(0);

    // The toolbar's own clear, which is the control the report was about.
    const cleared = await page.evaluate(`
      (() => {
        const button = document.querySelector('.ax-focus .ax-chip');
        if (button === null) return 'no clear button';
        button.click();
        return 'cleared';
      })()
    `);
    expect(cleared).toBe('cleared');

    expect(
      await page.until(
        "String(document.querySelector('.ax-canvas')._cyreg.cy.elements('.ax-dimmed').length)",
        (value) => value === '0',
      ),
    ).toBe('0');
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  /**
   * `reset` puts a dragged node back where the layout placed it.
   *
   * The lock's other half: a node moved on purpose and regretted is otherwise a
   * one-way door, because the layout is only recomputed when the elements
   * change. Driven through the real chips — unlock, drag, reset — since the
   * whole feature is those three controls agreeing.
   *
   * The viewport is asserted alongside the position, because `reset` is the
   * arrangement and nothing else: `fit` is a separate chip, and a reset that
   * silently re-framed the graph would move the user away from the corner they
   * had panned to in order to do the drag they are undoing.
   */
  it('puts a dragged node back where ELK placed it', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    const [id, screenX, screenY, modelX, modelY] = (await page.evaluate(FIRST_NODE)).split('|');
    expect(id).not.toBe('');
    const laidOut = `${modelX}|${modelY}`;

    // Unlock, then drag it somewhere it does not belong.
    await page.evaluate(`${LOCK}.click()`);
    await page.drag(
      { x: Number(screenX), y: Number(screenY) },
      { x: Number(screenX) + 140, y: Number(screenY) + 100 },
    );
    const moved = await page.evaluate(positionOf(id));
    // The control: without a real move, "it went back" means nothing.
    expect(moved).not.toBe(laidOut);

    /*
     * Somewhere deliberately un-fitted, the way a user who panned to a corner
     * to reach the node they dragged would be. If `reset` re-frames, this is
     * what changes — and against the default fitted viewport it might not,
     * since a re-fit would land back on the same numbers.
     */
    await page.evaluate(`
      (() => {
        const cy = document.querySelector('.ax-canvas')._cyreg.cy;
        cy.zoom(1.4);
        cy.pan({ x: 40, y: 25 });
      })()
    `);
    const viewport = await page.evaluate(PAN);

    const clicked = await page.evaluate(`
      (() => {
        const chip = [...document.querySelectorAll('.ax-zoom .ax-chip')]
          .find((button) => button.textContent === 'reset');
        if (chip === undefined) return 'no reset chip';
        chip.click();
        return 'reset';
      })()
    `);
    expect(clicked).toBe('reset');

    // The arrangement is back...
    expect(await page.evaluate(positionOf(id))).toBe(laidOut);
    // ...and the viewport is exactly where it was left.
    expect(await page.evaluate(PAN)).toBe(viewport);
    expect(await page.evaluate(ZOOM)).toBe('1.4');
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  /**
   * Leaving a view and coming back puts you where you were.
   *
   * Checking one thing on the state-access map and returning is the commonest
   * move there is on a large protocol, and it used to cost the pan built up to
   * get somewhere plus any node moved by hand: the canvas is wiped and laid out
   * from scratch on every switch, which is right the first time and wrong every
   * time after.
   *
   * The camera and the arrangement are both asserted, because they are
   * remembered by the same mechanism and restored in the same breath — one
   * working while the other silently does not is exactly the half-fix this
   * would otherwise ship as.
   */
  it('comes back to a view with its camera and arrangement intact', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // Move a node, so the arrangement is the user's and not just ELK's.
    const [id, screenX, screenY] = (await page.evaluate(FIRST_NODE)).split('|');
    await page.evaluate(`${LOCK}.click()`);
    await page.drag(
      { x: Number(screenX), y: Number(screenY) },
      { x: Number(screenX) + 130, y: Number(screenY) + 90 },
    );
    const moved = await page.evaluate(positionOf(id));

    // And a camera nobody would land on by fitting.
    await page.evaluate(`
      (() => {
        const cy = document.querySelector('.ax-canvas')._cyreg.cy;
        cy.zoom(1.15);
        cy.pan({ x: 33, y: 47 });
      })()
    `);

    const show = (label: string): string => `
      [...document.querySelectorAll('.ax-view')]
        .find((button) => button.textContent === ${JSON.stringify(label)})?.click();
      ${JSON.stringify(label)}
    `;
    await page.evaluate(show('State access'));
    expect(await page.until(CURRENT_VIEW, (value) => value === 'State access')).toBe(
      'State access',
    );
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    await page.evaluate(show('Protocol map'));
    expect(await page.until(CURRENT_VIEW, (value) => value === 'Protocol map')).toBe(
      'Protocol map',
    );

    // The camera, as it was left.
    expect(await page.until(PAN, (value) => value === '33|47')).toBe('33|47');
    expect(await page.evaluate(ZOOM)).toBe('1.15');
    // And the node still where it was dragged, not back at its ELK position.
    expect(await page.evaluate(positionOf(id))).toBe(moved);
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  /**
   * The visibility filter, from the chips down to the drawn graph.
   *
   * `filter.test.ts` covers the rule. What only a browser can show is that the
   * chip is wired to it, that the faded functions are still *there* — same
   * element count, same layout, same camera — and that the status bar says what
   * is faded.
   */
  it('fades the functions the filter is not asking for, and leaves the rest alone', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    // Contract detail: functions and storage, where the filter is offered.
    await page.evaluate(doubleTap('[kind = "Contract"]'));
    await page.until(CURRENT_VIEW, (value) => value === 'Contract detail');
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    const counts = `
      (() => {
        const cy = document.querySelector('.ax-canvas')._cyreg.cy;
        return [
          cy.nodes('[kind = "Function"]').length,
          cy.nodes('.ax-faded').length,
          cy.elements().length,
        ].join('|');
      })()
    `;
    const [functions, fadedBefore, elementsBefore] = (await page.evaluate(counts)).split('|');
    expect(Number(functions)).toBeGreaterThan(0);
    expect(fadedBefore).toBe('0');

    // A camera and an arrangement to prove untouched.
    const [nodeId] = (await page.evaluate(FIRST_NODE)).split('|');
    await page.evaluate(`
      (() => {
        const cy = document.querySelector('.ax-canvas')._cyreg.cy;
        cy.zoom(1.2);
        cy.pan({ x: 51, y: 29 });
      })()
    `);
    const placedAt = await page.evaluate(positionOf(nodeId));

    const tick = (label: string): string => `
      (() => {
        const chip = [...document.querySelectorAll('.ax-filters .ax-chip')]
          .find((button) => button.textContent === ${JSON.stringify(label)});
        if (chip === undefined) return 'no chip';
        chip.click();
        return chip.getAttribute('aria-pressed');
      })()
    `;
    expect(await page.evaluate(tick('external'))).toBe('false');

    const after = await page.until(counts, (value) => !value.startsWith(`${functions}|0|`));
    const [stillFunctions, fadedAfter, elementsAfter] = after.split('|');

    // Faded, not removed: the element count and the function count are the
    // same, and something is now carrying the class.
    expect(stillFunctions).toBe(functions);
    expect(elementsAfter).toBe(elementsBefore);
    expect(Number(fadedAfter)).toBeGreaterThan(0);

    // Every function left at full strength is external.
    expect(
      await page.evaluate(`
        (() => {
          const cy = document.querySelector('.ax-canvas')._cyreg.cy;
          return String(cy.nodes('[kind = "Function"]').filter((node) =>
            !node.hasClass('ax-faded')).every((node) => node.hasClass('vis-external')));
        })()
      `),
    ).toBe('true');

    // Nothing moved and nothing was re-framed — a filter is not a navigation.
    expect(await page.evaluate(positionOf(nodeId))).toBe(placedAt);
    expect(await page.evaluate(PAN)).toBe('51|29');
    expect(await page.evaluate(ZOOM)).toBe('1.2');

    // And the status bar says so.
    expect(await page.until(NOTE, (value) => /faded/.test(value))).toMatch(
      /\d+ functions? faded — highlighting external/,
    );

    // `show all` puts them back.
    await page.evaluate(`
      [...document.querySelectorAll('.ax-filters .ax-chip')]
        .find((button) => button.textContent.includes('show all'))?.click();
      'cleared'
    `);
    expect(
      await page.until(counts, (value) => value.startsWith(`${functions}|0|`)),
    ).toBe(`${functions}|0|${elementsBefore}`);
    expect(page.consoleErrors.join('\n')).toBe('');
  }, 120_000);

  /**
   * A drag that ended somewhere the page could not see it.
   *
   * Release the button outside the window — off the top of the screen, over
   * another application, over the editor beside the webview — and no `mouseup`
   * is ever delivered. Cytoscape binds that handler on the window, which covers
   * every release *inside* the page and none outside it, so the pan it started
   * is still running when the pointer comes back: the graph slides around under
   * a button nobody is holding, and only a real click puts it down.
   *
   * The re-entry move is the whole test. It is the first moment the page can
   * possibly know a release happened, because `buttons: 0` is the only trace
   * left of it.
   */
  it('lets go of a drag that was released outside the window', async () => {
    await page.goto(session.handle.url);
    await page.until(METRICS, (value) => /layout \d+ ms/.test(value));

    const [emptyX, emptyY] = (await page.evaluate(EMPTY_POINT)).split('|');
    const from = { x: Number(emptyX), y: Number(emptyY) };
    const start = await page.evaluate(PAN);

    // Press on the background and drag. The control half: if this does not pan,
    // everything below is vacuous.
    await page.mouse('mousePressed', from, 1);
    await page.mouse('mouseMoved', { x: from.x + 60, y: from.y + 40 }, 1);
    await page.mouse('mouseMoved', { x: from.x + 120, y: from.y + 80 }, 1);
    const panned = await page.evaluate(PAN);
    expect(panned).not.toBe(start);

    /*
     * The pointer leaves the window, and the button comes up out there. No
     * `mouseReleased` is sent, because that is precisely what the page never
     * receives — the only thing a browser delivers here is the boundary
     * crossing, a `mouseout` that names no element it moved to.
     *
     * Both events below are dispatched from the page rather than through CDP:
     * Chrome will not deliver a `buttons: 0` move while it still believes a
     * press is outstanding, so the input pipeline cannot express "the release
     * you never saw" at all. These are the events a real browser produces.
     */
    await page.evaluate(`
      document.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true, clientX: ${String(from.x + 120)}, clientY: ${String(from.y + 80)},
      }));
      'left the window'
    `);

    // Back, with nothing held down.
    for (const step of [1, 2]) {
      await page.evaluate(`
        window.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, buttons: 0,
          clientX: ${String(from.x + 180 * step)}, clientY: ${String(from.y + 140 * step)},
        }));
        'hovering'
      `);
    }

    // The viewport is where the drag left it, not dragged on by a pointer that
    // is only hovering.
    expect(await page.evaluate(PAN)).toBe(panned);
    expect(page.consoleErrors.join('\n')).toBe('');
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
    const contractId = await file.evaluate(doubleTap('[kind = "Contract"]'));
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
    // A function with call edges: one without them deliberately does not open
    // the call graph, since that view would hold a single node.
    const functionId = await file.evaluate(tap('[kind = "Function"][?calls]'));
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
      auditState: auditState(built.graph, { review: null, findings: null }),
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
