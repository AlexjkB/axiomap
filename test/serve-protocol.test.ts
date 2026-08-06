/**
 * The webview and the host agree on what a request looks like.
 *
 * §5 forbids the two packages from importing each other's code, so §9 rule 1's
 * wire format is written twice: `encodeViewRequest` in `@axiomap/webview` and
 * `decodeViewRequest` in `@axiomap/core`. Two implementations of one format
 * drift, and the drift is silent — a UI that spells the downstream hop limit
 * one way against a host that reads it another draws a graph that is wrong
 * rather than raising an error that is loud.
 *
 * This test is the thing that stops that. It belongs to neither package, which
 * is what this directory is for.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  decodeNodeRequest,
  decodeSearchRequest,
  decodeSourceRequest,
  decodeViewRequest,
  META_ENDPOINT,
  NODE_ENDPOINT,
  OVERLAY_ENDPOINT,
  SEARCH_ENDPOINT,
  SOURCE_ENDPOINT,
  VIEW_ENDPOINT,
  type AggregatedViewOptions,
} from '@axiomap/core';
import {
  encodeNodeRequest,
  encodeSearchRequest,
  encodeSourceRequest,
  encodeViewRequest,
  META_ENDPOINT as WEBVIEW_META,
  NODE_ENDPOINT as WEBVIEW_NODE,
  OVERLAY_ENDPOINT as WEBVIEW_OVERLAY,
  SEARCH_ENDPOINT as WEBVIEW_SEARCH,
  SOURCE_ENDPOINT as WEBVIEW_SOURCE,
  VIEW_ENDPOINT as WEBVIEW_VIEW,
  WEB_DIST,
} from '@axiomap/webview';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const requests: AggregatedViewOptions[] = [
  { view: 'protocol' },
  { view: 'protocol', expand: ['src', 'src/tokens/erc20'] },
  { view: 'protocol', cluster: false, autoExpand: false },
  { view: 'contract', focus: 'src/Vault.sol:Vault' },
  { view: 'call', focus: 'src/Vault.sol:Vault.deposit(uint256)', up: 0, down: 6 },
  { view: 'state-access', includeTests: true, renderCap: 400 },
  { view: 'inheritance', includeTests: false },
];

describe('the serve protocol', () => {
  it('round-trips every request the UI can make', () => {
    for (const request of requests) {
      expect(decodeViewRequest(encodeViewRequest(request))).toEqual(request);
    }
  });

  it('round-trips an inspector request', () => {
    // §11's inspector is a second request shape, and it drifts the same way the
    // first one would: a UI sending `node=` to a host reading `id=` shows an
    // empty panel rather than raising anything.
    for (const id of [
      'src/Vault.sol:Vault',
      'src/Vault.sol:Vault.deposit(uint256)',
      'src/Vault.sol:Vault#onlyOwner',
      '?low-level:call',
    ]) {
      expect(decodeNodeRequest(encodeNodeRequest(id))).toEqual({ id });
    }
  });

  it('round-trips a search request', () => {
    // Phase 7d's two new shapes. The palette's is the one where drift would be
    // quietest: a UI sending `query=` to a host reading `q=` searches for the
    // empty string, which this API deliberately answers with *nothing* — so the
    // palette would look like a protocol with no matching nodes rather than
    // like a broken request.
    for (const [query, limit] of [
      ['deposit', undefined],
      ['', undefined],
      ['src/Vault.sol:Vault.deposit(uint256)', 5],
      ['?low-level', 50],
    ] as const) {
      expect(decodeSearchRequest(encodeSearchRequest(query, limit))).toEqual({
        query,
        ...(limit === undefined ? {} : { limit }),
      });
    }
  });

  it('round-trips a source-slice request', () => {
    for (const [id, context] of [
      ['src/Vault.sol:Vault.deposit(uint256)', undefined],
      ['src/Vault.sol:Vault', 4],
    ] as const) {
      expect(decodeSourceRequest(encodeSourceRequest(id, context))).toEqual({
        id,
        ...(context === undefined ? {} : { context }),
      });
    }
  });

  /**
   * The source request has no `file` parameter on either side, and that is the
   * whole of why shipping the user's source over this bridge is safe: the path
   * comes from the graph (`core/source/slice.ts`). A parameter added here later
   * would be the change that quietly turns the viewer into a file server, so
   * the absence is asserted rather than assumed.
   */
  it('gives the source request no way to name a file', () => {
    const encoded = encodeSourceRequest('src/Vault.sol:Vault.deposit(uint256)', 2);
    expect(Object.keys(encoded).sort()).toEqual(['context', 'id']);

    const smuggled = decodeSourceRequest({ ...encoded, file: '../../../etc/passwd', path: '/etc/passwd' });
    expect(smuggled).toEqual({ id: 'src/Vault.sol:Vault.deposit(uint256)', context: 2 });
  });

  it('agrees on where the endpoints are', () => {
    expect(WEBVIEW_VIEW).toBe(VIEW_ENDPOINT);
    expect(WEBVIEW_META).toBe(META_ENDPOINT);
    expect(WEBVIEW_NODE).toBe(NODE_ENDPOINT);
    expect(WEBVIEW_OVERLAY).toBe(OVERLAY_ENDPOINT);
    expect(WEBVIEW_SEARCH).toBe(SEARCH_ENDPOINT);
    expect(WEBVIEW_SOURCE).toBe(SOURCE_ENDPOINT);
  });

  it('agrees on where the bundle is', () => {
    // `serve/assets.ts` duplicates this constant for the same §5 reason.
    const assets = fs.readFileSync(path.join(REPO, 'packages/cli/src/serve/assets.ts'), 'utf8');
    expect(assets).toContain(`const WEB_DIST = '${WEB_DIST}'`);
  });

  it('keeps the CLI free of webview *code*, which §5 does forbid', () => {
    // The CLI serves the webview's built files; it imports none of its modules.
    // §5's dependency-direction lint rule is what enforces this, and
    // `dependency-direction.test.ts` is what proves the rule still bites. This
    // is the second half: no import statement in the CLI names the package,
    // whatever the linter is currently configured to catch.
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) sources.push(full);
      }
    };
    walk(path.join(REPO, 'packages/cli/src'));

    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/^\s*import\s[^\n]*['"]@axiomap\/webview/m);
      expect(text, file).not.toMatch(/from\s+['"]@axiomap\/webview['"]/);
    }
  });
});
