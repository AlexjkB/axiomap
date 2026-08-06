/**
 * The document a VS Code webview loads.
 *
 * Pure string assembly, kept away from the `vscode` API so that the two things
 * most likely to be silently wrong about it — the Content Security Policy and
 * the theme variables — can be asserted by a test rather than discovered in a
 * panel that renders blank.
 *
 * ### Colour
 *
 * §11: "Palette derives entirely from VS Code CSS variables. No hard-coded
 * hex." Nothing here sets a colour. VS Code injects the whole `--vscode-*` set
 * onto the document element of every webview it opens, and `style.ts` resolves
 * the palette from them; the hex in its fallback table is what a *browser* with
 * no editor around it gets, and inside this document it is unreachable because
 * the variables are all set. The one thing this file does is stop the page
 * flashing white before React mounts, which it does with two of those same
 * variables rather than with a colour of its own.
 *
 * ### The CSP is deliberately narrow
 *
 * `default-src 'none'` and then only what the bundle actually needs. Decision #2
 * is zero network access, and a webview is the one surface in this tool where a
 * stray `fetch` would be both possible and invisible — so the policy names no
 * remote origin at all, and a script that tried would be refused by the editor
 * rather than by a code review. `blob:` is there for elkjs's worker (§9 rule 6),
 * which is same-origin data this extension read off its own disk.
 */

export interface WebviewHtmlOptions {
  /** `webview.asWebviewUri` of the bundle's script and stylesheet. */
  scriptUri: string;
  styleUri: string;
  /** `webview.cspSource`. */
  cspSource: string;
  /** One per document, so `'unsafe-inline'` is never needed for scripts. */
  nonce: string;
  /** elkjs's worker source, inlined for the reason in `assets.ts`. */
  elkWorker: string;
}

/** JSON, escaped so it cannot end the script element it sits in. */
function embed(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function webviewHtml(options: WebviewHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `img-src ${options.cspSource} data:`,
    `font-src ${options.cspSource}`,
    // The stylesheet is a file; `'unsafe-inline'` covers the two-line splash
    // rule below and cytoscape's own inline canvas styles.
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${options.nonce}'`,
    // §9 rule 6's layout worker, started from a blob of the source above.
    `worker-src blob:`,
    // Nothing else: no `connect-src`, so there is no origin this page could
    // reach even if something in it tried (decision #2).
  ].join('; ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Axiomap</title>
    <link rel="stylesheet" href="${options.styleUri}" />
    <style>
      /* The host's, not ours — see the note at the top of this file. */
      html, body { height: 100%; margin: 0; padding: 0; overflow: hidden;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground); }
      #root { height: 100%; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${options.nonce}">window.__AXIOMAP_ELK_WORKER__ = ${embed(options.elkWorker)};</script>
    <script nonce="${options.nonce}" type="module" src="${options.scriptUri}"></script>
  </body>
</html>
`;
}

/** A fresh nonce per document. `crypto` is Node's, which the host has. */
export function nonce(random: () => string = () => Math.random().toString(36).slice(2)): string {
  return `${random()}${random()}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}
