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
  decodeViewRequest,
  META_ENDPOINT,
  VIEW_ENDPOINT,
  type AggregatedViewOptions,
} from '@axiomap/core';
import {
  encodeViewRequest,
  META_ENDPOINT as WEBVIEW_META,
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

  it('agrees on where the endpoints are', () => {
    expect(WEBVIEW_VIEW).toBe(VIEW_ENDPOINT);
    expect(WEBVIEW_META).toBe(META_ENDPOINT);
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
