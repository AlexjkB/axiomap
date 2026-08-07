/**
 * `axiomap serve [path]` (§12) — build, then open the UI in a browser.
 *
 * The command §7 assigns to Phase 7 and §12 documents from the start. It is
 * three things and no more: build the graph the way every other command builds
 * it, put §9 rule 1's endpoint in front of it, and hand the browser the bundle.
 *
 * The banner is the same information `axiomap build` prints, for the same
 * reason — §4 requires the mode and the resolution score on every build, and a
 * user who starts here rather than there should not have to go and ask.
 */

import { spawn } from 'node:child_process';

import { describeScore, DEFAULT_RENDER_CAP, readAuditFiles } from '@axiomap/core';

import { loadGraph, openProject, type CommonOptions } from '../context.js';
import { colour, definitions, paintMode } from '../output.js';
import { webviewAssets } from '../serve/assets.js';
import { startServer, type ServeHandle } from '../serve/server.js';

export interface ServeOptions extends CommonOptions {
  port?: number;
  host?: string;
  /** `--no-open` sets this false. */
  open?: boolean;
}

export interface ServeSession {
  handle: ServeHandle;
  banner: string;
}

/**
 * Ask the desktop to open a URL.
 *
 * Not a network operation and not a dependency: `xdg-open`/`open`/`start` are
 * the platform's own, and a failure is ignored because the banner has already
 * printed the URL. Decision #2 is about *this* process making outbound
 * connections; handing localhost to the user's own browser is not that.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // No desktop, or no opener. The URL is on screen either way.
    });
    child.unref();
  } catch {
    // As above.
  }
}

export async function startServe(options: ServeOptions = {}): Promise<ServeSession> {
  const assets = webviewAssets();
  const context = openProject(options);
  const { file, graph, origin, reason } = await loadGraph(context, options);

  const renderCap = context.config.renderCap ?? DEFAULT_RENDER_CAP;
  const auditFiles = readAuditFiles(context.root);
  const handle = await startServer({
    graph,
    file,
    root: context.root,
    assets,
    renderCap,
    review: auditFiles.review,
    findings: auditFiles.findings,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });

  const lines = [
    definitions([
      ['serving', colour.bold(handle.url)],
      ['project', `${context.root} (${file.project.kind})`],
      ['graph', origin === 'artifact' ? '.axiomap/graph.json' : 'built now'],
      ['mode', paintMode(file.mode, file.mode)],
      ['', colour.dim(file.modeReason)],
      ['resolution', describeScore(file)],
      ['render cap', `${renderCap.toLocaleString('en-US')} elements (AXIOMAP.md §9)`],
      [
        'auditState',
        [
          auditFiles.review === null
            ? 'no review state'
            : `${Object.keys(auditFiles.review).length.toLocaleString('en-US')} reviewed nodes`,
          auditFiles.findings === null
            ? 'no imported findings'
            : `${auditFiles.findings.findings.length.toLocaleString('en-US')} imported findings`,
        ].join(', '),
      ],
    ]),
  ];

  if (reason !== null) lines.push(colour.dim(`rebuilt: ${reason}`));
  for (const warning of [...context.warnings, ...auditFiles.warnings]) {
    lines.push(colour.yellow(warning));
  }
  if (handle.host !== '127.0.0.1' && handle.host !== 'localhost') {
    lines.push(
      colour.yellow(
        `Listening on ${handle.host}: this protocol's graph is reachable from other machines on your network.`,
      ),
    );
  }
  lines.push(
    colour.dim('The graph is built once. Restart to pick up edits. Ctrl-C to stop.'),
  );

  return { handle, banner: `${lines.join('\n')}\n` };
}

export interface ServeResult {
  text: string;
  exitCode: number;
  /** Resolves when the server stops. */
  closed: Promise<void>;
  handle: ServeHandle;
}

export async function runServe(options: ServeOptions = {}): Promise<ServeResult> {
  const session = await startServe(options);
  if (options.open !== false) openBrowser(session.handle.url);

  const closed = new Promise<void>((resolve) => {
    const stop = (): void => {
      void session.handle.close().then(resolve, resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return { text: session.banner, exitCode: 0, closed, handle: session.handle };
}
