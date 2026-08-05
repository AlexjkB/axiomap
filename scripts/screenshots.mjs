/**
 * Look at the UI, under a host theme, without a human driving a browser.
 *
 * Two phases running, the worst defects in this package were invisible to a
 * green test suite and obvious in one image: Phase 7b shipped a layout engine
 * that threw on every view, and Phase 7c shipped six overlays that decorated
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
const THEMES = {
  // The browser fallback: the app resolves every variable itself.
  browser: {},
  light: {
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-foreground': '#3b3b3b',
    '--vscode-descriptionForeground': '#717171',
    '--vscode-panel-border': '#e5e5e5',
    '--vscode-editorWidget-background': '#f8f8f8',
    '--vscode-editorGroup-border': '#e5e5e5',
    '--vscode-charts-blue': '#1a85ff',
    '--vscode-charts-purple': '#652d90',
    '--vscode-charts-green': '#388a34',
    '--vscode-charts-orange': '#d18616',
    '--vscode-charts-foreground': '#3b3b3b',
    '--vscode-editorWarning-foreground': '#bf8803',
    '--vscode-editorError-foreground': '#e51400',
    '--vscode-focusBorder': '#005fb8',
    '--vscode-editor-font-family': 'ui-monospace, monospace',
    '--vscode-font-family': 'system-ui, sans-serif',
  },
  'hc-dark': {
    '--vscode-editor-background': '#000000',
    '--vscode-editor-foreground': '#ffffff',
    '--vscode-descriptionForeground': '#ffffff',
    '--vscode-panel-border': '#6fc3df',
    '--vscode-editorWidget-background': '#0c141f',
    '--vscode-editorGroup-border': '#6fc3df',
    '--vscode-charts-blue': '#3794ff',
    '--vscode-charts-purple': '#c586c0',
    '--vscode-charts-green': '#89d185',
    '--vscode-charts-orange': '#d18616',
    '--vscode-charts-foreground': '#ffffff',
    '--vscode-editorWarning-foreground': '#ffd700',
    '--vscode-editorError-foreground': '#f48771',
    '--vscode-focusBorder': '#f38518',
    '--vscode-editor-font-family': 'ui-monospace, monospace',
    '--vscode-font-family': 'system-ui, sans-serif',
  },
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

const clickOverlay = (label) => `
  (() => {
    const chip = [...document.querySelectorAll('.ax-overlay-row .ax-chip')]
      .find((button) => button.textContent.trim() === ${JSON.stringify(label)});
    if (!chip) return 'missing';
    chip.click();
    return 'ok';
  })()
`;

const OVERLAYS = [
  'Attack surface',
  'Access control',
  'Reentrancy surface',
  'Danger ops',
  'Resolution confidence',
  'Complexity',
  'Review state',
  'Imported findings',
];

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

        // Overlays are function-level, so they are shown where they apply.
        await page.evaluate(tapContract('Pair'));
        await page.until(CURRENT_VIEW, (value) => value === 'Contract detail');
        await settled(page);
        console.log(await page.shot(path.join(out, '02-contract-detail.png')));

        for (const [index, label] of OVERLAYS.entries()) {
          await page.evaluate(clickOverlay(label));
          const slug = label.toLowerCase().replace(/[^a-z]+/g, '-');
          console.log(await page.shot(path.join(out, `${String(index + 3).padStart(2, '0')}-${slug}.png`)));
          await page.evaluate(clickOverlay(label));
        }

        for (const label of OVERLAYS) await page.evaluate(clickOverlay(label));
        console.log(await page.shot(path.join(out, '11-all-eight.png')));

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
