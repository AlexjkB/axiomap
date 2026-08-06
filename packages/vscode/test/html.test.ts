/**
 * The webview document.
 *
 * Two things about it are silently wrong rather than loudly wrong if they are
 * wrong at all — a CSP that blocks the bundle gives a blank panel, and a colour
 * written here would quietly override §11's rule that the palette is the host's
 * — so both are asserted rather than looked at.
 */

import { describe, expect, it } from 'vitest';

import { nonce, webviewHtml } from '../src/html.js';

const CSP_SOURCE = 'https://file+.vscode-resource.vscode-cdn.net';

function html(worker = 'self.onmessage = () => {};'): string {
  return webviewHtml({
    scriptUri: `${CSP_SOURCE}/media/vscode.js`,
    styleUri: `${CSP_SOURCE}/media/vscode.css`,
    cspSource: CSP_SOURCE,
    nonce: 'n0nc3',
    elkWorker: worker,
  });
}

describe('webviewHtml', () => {
  it('loads the bundle and the stylesheet from the host’s own resource origin', () => {
    const document = html();
    expect(document).toContain(`src="${CSP_SOURCE}/media/vscode.js"`);
    expect(document).toContain(`href="${CSP_SOURCE}/media/vscode.css"`);
    expect(document).toContain('nonce="n0nc3"');
  });

  it('names no origin it could reach (decision #2)', () => {
    const document = html();
    const csp = /content="([^"]+)"/.exec(document)?.[1] ?? '';

    expect(csp).toContain("default-src 'none'");
    // No `connect-src` at all: there is no origin this page could fetch from
    // even if something in it tried. A tool pointed at confidential client code
    // should not have a network surface it merely does not use.
    expect(csp).not.toContain('connect-src');
    expect(csp).not.toMatch(/https?:\/\/(?!file\+)/);
    // Scripts by nonce, never `'unsafe-inline'`, which would make the nonce
    // decorative.
    expect(csp).toContain("script-src 'nonce-n0nc3'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    // §9 rule 6's worker, from the blob the entry makes of the source below.
    expect(csp).toContain('worker-src blob:');
  });

  it('has no colour of its own (§11)', () => {
    // "Palette derives entirely from VS Code CSS variables. No hard-coded hex."
    // The two rules this document does carry are the host's variables, so the
    // panel does not flash white before React mounts.
    const document = html();
    expect(document).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(document).toContain('var(--vscode-editor-background)');
    expect(document).toContain('var(--vscode-editor-foreground)');
  });

  it('embeds the ELK worker as data, escaped so it cannot end the script', () => {
    const document = html('const x = "</script><script>alert(1)</script>";');
    expect(document).toContain('__AXIOMAP_ELK_WORKER__');
    // The escape that matters: a `<` inside the source must not close the
    // element it is sitting in.
    expect(document).not.toContain('</script><script>alert(1)');
    expect(document).toContain('\\u003c/script\\u003e');

    // …and what is embedded is still exactly the source, once parsed.
    const embedded = /__AXIOMAP_ELK_WORKER__ = (".*");/.exec(document)?.[1] ?? '';
    expect(JSON.parse(embedded)).toBe('const x = "</script><script>alert(1)</script>";');
  });
});

describe('nonce', () => {
  it('is alphanumeric, long, and different every time', () => {
    const first = nonce();
    expect(first).toMatch(/^[a-zA-Z0-9]{16,32}$/);
    expect(first).not.toBe(nonce());
  });
});
