/**
 * Decoding a request that arrived from somewhere else.
 *
 * A host parses whatever a URL bar contained, so §6's rule about not guessing
 * applies here as much as to the resolver: everything this cannot read is
 * refused with the alternatives named. The other half of the format — the
 * encode — lives in `@axiomap/webview`, and `test/serve-protocol.test.ts` at the
 * repo root is what keeps the two the same shape.
 */

import { describe, expect, it } from 'vitest';

import { callDefaults, decodeViewRequest, ViewError } from '../src/index.js';

describe('decodeViewRequest', () => {
  it('defaults to the protocol map and adds nothing else', () => {
    expect(decodeViewRequest({})).toEqual({ view: 'protocol' });
  });

  it('leaves an unset option unset rather than filling in a default', () => {
    // The engine owns §9 rule 4's hop limits and §13's render cap. A decoder
    // that materialised them here would be a second place they are decided.
    const request = decodeViewRequest({ view: 'call', focus: 'x' });
    expect(request).toEqual({ view: 'call', focus: 'x' });
    expect(Object.keys(request)).not.toContain('up');
  });

  it('reads the whole request', () => {
    expect(
      decodeViewRequest({
        view: 'state-access',
        focus: 'src/Vault.sol:Vault',
        up: '1',
        down: '4',
        includeTests: '1',
        renderCap: '400',
        cluster: '0',
        autoExpand: 'false',
        expand: 'src, src/tokens ,',
      }),
    ).toEqual({
      view: 'state-access',
      focus: 'src/Vault.sol:Vault',
      up: 1,
      down: 4,
      includeTests: true,
      renderCap: 400,
      cluster: false,
      autoExpand: false,
      expand: ['src', 'src/tokens'],
    });
  });

  it('names the five views rather than falling back to one', () => {
    // Silently showing the protocol map when the call graph was asked for tells
    // the user something untrue about the code.
    expect(() => decodeViewRequest({ view: 'callgraph' })).toThrow(ViewError);
    expect(() => decodeViewRequest({ view: 'callgraph' })).toThrow(
      /protocol, contract, call, state-access, inheritance/,
    );
  });

  it('refuses a number it cannot read', () => {
    expect(() => decodeViewRequest({ view: 'call', up: 'two' })).toThrow(/non-negative integer/);
    expect(() => decodeViewRequest({ view: 'call', down: '-1' })).toThrow(/non-negative integer/);
    expect(() => decodeViewRequest({ view: 'protocol', renderCap: '1.5' })).toThrow(ViewError);
  });

  it('refuses a flag it cannot read', () => {
    expect(() => decodeViewRequest({ view: 'protocol', cluster: 'yes' })).toThrow(/0 or 1/);
  });

  it('treats an empty parameter as absent, which is what a form sends', () => {
    expect(decodeViewRequest({ view: 'protocol', focus: '', expand: '', up: '' })).toEqual({
      view: 'protocol',
    });
  });

  it('states §9 rule 4’s defaults for a UI to start from', () => {
    expect(callDefaults()).toEqual({ up: 2, down: 3 });
  });
});
