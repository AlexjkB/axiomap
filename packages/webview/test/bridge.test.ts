/**
 * The one door into the graph (§9 rule 1), and what it does with a refusal.
 */

import { describe, expect, it } from 'vitest';

import { BridgeError, HttpBridge, type FetchLike } from '../src/bridge.js';
import { encodeViewRequest, META_ENDPOINT, VIEW_ENDPOINT } from '../src/protocol.js';
import { view } from './support.js';

function fetching(handler: (url: string) => { status: number; body: unknown }): {
  fetch: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch: FetchLike = (url) => {
    urls.push(url);
    const { status, body } = handler(url);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
  };
  return { fetch, urls };
}

describe('HttpBridge', () => {
  it('asks for a view by view + filter + focus, and nothing else', async () => {
    const { fetch, urls } = fetching(() => ({ status: 200, body: view() }));
    const bridge = new HttpBridge({ base: 'http://127.0.0.1:9999', fetch });

    await bridge.view({ view: 'call', focus: 'src/Vault.sol:Vault.deposit(uint256)', up: 1, down: 4 });

    expect(urls[0]).toBe(
      'http://127.0.0.1:9999/api/view?view=call&focus=src%2FVault.sol%3AVault.deposit(uint256)&up=1&down=4',
    );
  });

  it('spells the expansion set as one parameter', () => {
    expect(encodeViewRequest({ view: 'protocol', expand: ['src', 'src/tokens'] })).toEqual({
      view: 'protocol',
      expand: 'src,src/tokens',
    });
    // An empty set is the same request as no set: nothing extra on the wire.
    expect(encodeViewRequest({ view: 'protocol', expand: [] })).toEqual({ view: 'protocol' });
  });

  it('keeps a render-cap refusal actionable, not just printable (§9 rule 2)', async () => {
    const { fetch } = fetching(() => ({
      status: 422,
      body: {
        error: {
          name: 'RenderCapError',
          message: '2,847 elements exceeds the render cap of 1,500 — collapse a directory.',
          elements: 2847,
          cap: 1500,
          view: 'protocol',
        },
      },
    }));

    const bridge = new HttpBridge({ base: '', fetch });
    const failure = await bridge.view({ view: 'protocol' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BridgeError);
    const error = failure as BridgeError;
    expect(error.isRenderCap).toBe(true);
    expect(error.detail.elements).toBe(2847);
    expect(error.detail.cap).toBe(1500);
    expect(error.message).toContain('collapse a directory');
  });

  it('says the host is unreachable rather than throwing whatever fetch threw', async () => {
    const bridge = new HttpBridge({
      base: 'http://127.0.0.1:1',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(bridge.meta()).rejects.toThrow(/Is it still running\?/);
  });

  it('reports a status with no body as a status', async () => {
    const { fetch } = fetching(() => ({ status: 500, body: undefined }));
    await expect(new HttpBridge({ fetch }).meta()).rejects.toThrow('The host answered 500');
  });

  it('uses the page origin when no base is given', () => {
    const bridge = new HttpBridge({ fetch: () => Promise.reject(new Error('unused')) });
    expect(bridge.url(META_ENDPOINT)).toBe('/api/meta');
    expect(bridge.url(VIEW_ENDPOINT, { view: 'protocol' })).toBe('/api/view?view=protocol');
  });
});
