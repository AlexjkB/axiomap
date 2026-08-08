/**
 * Look at the UI, under a host theme, without a human driving a browser.
 *
 * Two phases running, the worst defects in this package were invisible to a
 * green test suite and obvious in one image: Phase 7b shipped a layout engine
 * that threw on every view, and Phase 7c shipped a styling layer that decorated
 * nothing on the default view and said nothing about it. Both times the harness
 * that found them was rebuilt from scratch and thrown away, so here it is.
 *
 * `test/browser-smoke.test.ts` is the *asserted* version of the same idea and
 * runs in CI; this is the exploratory one. It drives Chrome over the DevTools
 * protocol with Node's built-in WebSocket — no new dependency — and needs a
 * built bundle (`pnpm build`).
 *
 *   node scripts/screenshots.mjs --project fixtures/defi --out /tmp/shots
 *   node scripts/screenshots.mjs --theme light --theme hc-dark
 *
 * ### Themes are the point, not a flag
 *
 * §11 requires every colour to come from a `--vscode-*` variable and §7's Phase
 * 8 requires the graph to be legible in Dark+, Light+ and a high-contrast theme.
 * Nothing in the repo *sets* those variables — the browser resolves them to the
 * fallback palette — so until this existed, every screenshot ever taken of this
 * UI was of the one palette nobody ships. The variables are injected before the
 * app boots, which is where a real host sets them.
 *
 * Chrome flags: no `--no-sandbox` and no `--user-data-dir`. Both make headless
 * Chrome hang in this environment, and the hang was once mistaken for "no
 * browser can run here".
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { startServe } from '@axiomap/cli';

/**
 * What a host's theme sets. Values are read off the real VS Code themes rather
 * than invented, and only the variables `style.ts` names are listed — a
 * variable missing here falls back exactly as it does in a browser, which is
 * the behaviour worth being able to see.
 */
/**
 * What a host's theme sets.
 *
 * **Dumped out of a real VS Code**, one file per theme, by the extension-host
 * suite (`pnpm test:host` → `packages/webview/test/themes/*.json`). They used to
 * be transcribed by hand into this file, which is a guess about the thing under
 * test — and the guess was wrong in a way that mattered: Dark+ and Light+ spell
 * `--vscode-charts-orange` as `rgba(234, 92, 0, 0.33)`, not as the opaque
 * `#d18616` that was written here, so every screenshot ever taken of this UI
 * showed a state-access map in an orange nobody actually gets. See
 * `packages/webview/test/theme-legibility.test.ts`.
 */
const THEMES = {
  // The browser fallback: the app resolves every variable itself.
  browser: {},
  ...Object.fromEntries(
    fs
      .readdirSync(new URL('../packages/webview/test/themes/', import.meta.url))
      .filter((name) => name.endsWith('.json'))
      .map((name) => [
        name.replace(/\.json$/, ''),
        JSON.parse(
          fs.readFileSync(
            new URL(`../packages/webview/test/themes/${name}`, import.meta.url),
            'utf8',
          ),
        ).values,
      ]),
  ),
};

function parseArgs(argv) {
  const options = { project: 'fixtures/defi', out: 'docs/screenshots', themes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--project' || flag === '-p') options.project = value ?? options.project;
    else if (flag === '--out' || flag === '-o') options.out = value ?? options.out;
    else if (flag === '--theme' || flag === '-t') {
      if (!(value in THEMES)) {
        throw new Error(`Unknown theme "${value}". Known: ${Object.keys(THEMES).join(', ')}.`);
      }
      options.themes.push(value);
    }
  }
  if (options.themes.length === 0) options.themes = ['browser'];
  return options;
}

function findChrome() {
  for (const candidate of ['google-chrome', 'chromium', 'chromium-browser']) {
    const probe = spawn(candidate, ['--version']);
    probe.kill();
    // `spawn` fails asynchronously, so this is a hint rather than a check; the
    // real failure is the missing DevTools banner below, which says as much.
    return candidate;
  }
  return 'google-chrome';
}

/** A minimal CDP client: open a page, set a theme, poll it, screenshot it. */
class Page {
  #socket;
  #chrome;
  #sessionId = '';
  #nextId = 1;
  #pending = new Map();
  consoleErrors = [];

  static async open(binary) {
    const chrome = spawn(
      binary,
      ['--headless=new', '--remote-debugging-port=0', '--window-size=1600,1000', 'about:blank'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const wsUrl = await new Promise((resolve, reject) => {
      let banner = '';
      const timer = setTimeout(() => {
        reject(new Error(`${binary} never announced a DevTools endpoint. Is it installed?`));
      }, 30_000);
      chrome.stderr.on('data', (chunk) => {
        banner += String(chunk);
        const match = /ws:\/\/\S+/.exec(banner);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      chrome.on('error', reject);
    });

    const socket = new WebSocket(wsUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

    const page = new Page();
    page.#socket = socket;
    page.#chrome = chrome;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        page.#pending.get(message.id)?.(message.result);
        page.#pending.delete(message.id);
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        page.consoleErrors.push(message.params.entry.text ?? '');
      }
    });

    const target = await page.send('Target.createTarget', { url: 'about:blank' });
    const attached = await page.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    page.#sessionId = attached.sessionId;
    await page.send('Log.enable');
    // `Page.addScriptToEvaluateOnNewDocument` is a no-op without this, and a
    // silent one: the theme simply never arrives and the screenshot is of the
    // fallback palette wearing another theme's name.
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return page;
  }

  /** Re-emulate at a different width, for the responsive checks. */
  resize(width, height = 1000) {
    return this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(this.#sessionId === '' ? {} : { sessionId: this.#sessionId }),
        }),
      );
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result?.exceptionDetails !== undefined) {
      throw new Error(String(result.exceptionDetails.exception?.description ?? 'evaluate failed'));
    }
    return result?.result?.value ?? '';
  }

  /**
   * Set a host theme for every future document.
   *
   * Before the app boots, which is where a real host sets them: the palette is
   * read once at mount, so variables applied afterwards would leave the canvas
   * on the previous palette and produce a screenshot of neither theme.
   */
  async theme(variables) {
    const source = Object.entries(variables)
      .map(
        ([name, value]) =>
          `document.documentElement.style.setProperty(${JSON.stringify(name)}, ${JSON.stringify(value)});`,
      )
      .join('\n');
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        `const apply = () => {\n${source}\n};\n` +
        'if (document.documentElement) apply();\n' +
        "document.addEventListener('DOMContentLoaded', apply);",
    });
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
  }

  async until(expression, holds, tries = 60) {
    let value = '';
    for (let attempt = 0; attempt < tries; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      value = await this.evaluate(expression);
      if (holds(String(value))) return String(value);
    }
    return String(value);
  }

  async shot(file) {
    // The layout animates in; give it a beat so the screenshot is of the graph
    // where it lands rather than of it arriving.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }

  close() {
    this.#socket.close();
    this.#chrome.kill();
  }
}

const METRICS = "document.querySelector('.ax-metrics')?.textContent ?? ''";
const CURRENT_VIEW = "document.querySelector('.ax-view-current')?.textContent ?? ''";

const settled = (page) => page.until(METRICS, (value) => /layout \d+ ms/.test(value));

const tapContract = (label) => `
  (() => {
    const cy = document.querySelector('.ax-canvas')._cyreg.cy;
    const node = cy.nodes('[kind = "Contract"]')
      .filter((n) => ${JSON.stringify(label)} === '' || n.data('label') === ${JSON.stringify(label)})
      .first();
    if (node.empty()) return '';
    node.emit('tap');
    return node.id();
  })()
`;

/** Select a node without navigating, the way the inspector's own rows do. */
const tapKind = (kind) => `
  (() => {
    const cy = document.querySelector('.ax-canvas')._cyreg.cy;
    const node = cy.nodes('[kind = ' + ${JSON.stringify(JSON.stringify(kind))} + ']').first();
    if (node.empty()) return '';
    node.emit('tap');
    return node.id();
  })()
`;

const CODE = "document.querySelector('.ax-code')?.textContent ?? ''";
/** The toolbar's rendered height, which must not change between views. */
const TOOLBAR_H =
  "String(Math.round(document.querySelector('.ax-toolbar').getBoundingClientRect().height))";
const PALETTE = "document.querySelector('.ax-palette')?.textContent ?? ''";

const typeInPalette = (text) => `
  (() => {
    const input = document.querySelector('.ax-palette input');
    if (!input) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()
`;

/** Click a view tab by its label, the way the toolbar spells it. */
const clickView = (label) => `
  (() => {
    const tab = [...document.querySelectorAll('.ax-view')]
      .find((button) => button.textContent.trim() === ${JSON.stringify(label)});
    if (!tab) return 'missing';
    if (tab.disabled) return 'disabled';
    tab.click();
    return 'ok';
  })()
`;

const press = (key) => `
  (() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
    return 'ok';
  })()
`;

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const session = await startServe({ path: options.project, port: 0, open: false });
  console.log(`serving ${options.project} at ${session.handle.url}`);

  try {
    for (const themeName of options.themes) {
      const page = await Page.open(findChrome());
      const out = path.join(options.out, themeName);
      try {
        await page.theme(THEMES[themeName]);
        await page.goto(session.handle.url);
        await settled(page);
        console.log(await page.shot(path.join(out, '01-protocol-map.png')));

        await page.evaluate(tapContract('Pair'));
        await page.until(CURRENT_VIEW, (value) => value === 'Contract detail');
        await settled(page);
        console.log(await page.shot(path.join(out, '02-contract-detail.png')));

        // Phase 7d: the inspector's code preview and the search palette. Each
        // is screenshotted where it has something to show — the lesson of 7b
        // and 7c is that a green suite says nothing about whether a panel is
        // legible.
        await page.evaluate(tapKind('Function'));
        await page.until(CODE, (value) => value.length > 0);
        console.log(await page.shot(path.join(out, '03-code-preview.png')));

        await page.evaluate(press('/'));
        await page.until(PALETTE, (value) => value.length > 0);
        await page.evaluate(typeInPalette('mint'));
        await page.until(PALETTE, (value) => value.includes('mint'));
        console.log(await page.shot(path.join(out, '04-search-palette.png')));
        await page.evaluate(press('Escape'));

        /*
         * The call graph, and the check the call graph is here for.
         *
         * It is the one view that puts extra controls on the toolbar row (§9
         * rule 4's hop steppers), and that used to make the row run out of
         * width, wrap the tab labels onto two lines, and grow the whole bar —
         * a toolbar that changes height as you switch views is a canvas that
         * resizes under the graph. Measured rather than eyeballed, because the
         * difference is 20 pixels and every screenshot before this one was
         * taken on a view that did not show it.
         */
        const before = Number(await page.evaluate(TOOLBAR_H));
        await page.evaluate(clickView('Call graph'));
        await page.until(CURRENT_VIEW, (value) => value === 'Call graph');
        await settled(page);
        console.log(await page.shot(path.join(out, '05-call-graph.png')));

        const after = Number(await page.evaluate(TOOLBAR_H));
        if (before !== after) {
          console.error(`toolbar height changed with the view: ${before}px -> ${after}px`);
          process.exitCode = 1;
        } else {
          console.log(`  toolbar height steady at ${String(after)}px across views`);
        }

        /*
         * The same invariant at a width where the toolbar is two rows.
         *
         * It must be *two* rows there — one crowded row is what this breakpoint
         * exists to avoid — and it must still be the same two on every view. A
         * check that only ever ran at 1600px would have passed the bug this was
         * written for.
         */
        for (const width of [800, 560]) {
          await page.resize(width);
          await settled(page);
          const narrowCall = Number(await page.evaluate(TOOLBAR_H));
          console.log(await page.shot(path.join(out, `06-narrow-${String(width)}-call.png`)));

          await page.evaluate(clickView('Protocol map'));
          await page.until(CURRENT_VIEW, (value) => value === 'Protocol map');
          await settled(page);
          const narrowProtocol = Number(await page.evaluate(TOOLBAR_H));

          if (narrowCall !== narrowProtocol) {
            console.error(
              `at ${String(width)}px the toolbar changed with the view: ` +
                `${narrowCall}px -> ${narrowProtocol}px`,
            );
            process.exitCode = 1;
          } else if (narrowCall <= after) {
            console.error(
              `at ${String(width)}px the toolbar did not grow to two rows (${narrowCall}px)`,
            );
            process.exitCode = 1;
          } else {
            console.log(`  ${String(width)}px: two rows, steady at ${String(narrowCall)}px`);
          }

          await page.evaluate(clickView('Call graph'));
          await page.until(CURRENT_VIEW, (value) => value === 'Call graph');
          await settled(page);
        }
        await page.resize(1600);

        if (page.consoleErrors.length > 0) {
          console.error(`console errors under ${themeName}:`, page.consoleErrors);
          process.exitCode = 1;
        }
      } finally {
        page.close();
      }
    }
  } finally {
    await session.handle.close();
  }
}

await run();
process.exit(process.exitCode ?? 0);
