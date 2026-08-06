/**
 * The fourth host's bridge: `postMessage` with correlation ids, and the three
 * notifications an editor can carry that a browser cannot.
 *
 * The channel is a fake `window` and a fake `acquireVsCodeApi`, which is all
 * either of them is from this side. What the *other* end does with these
 * messages is pinned at the repo root (`test/vscode-protocol.test.ts`), for the
 * same reason the HTTP pair is: two implementations of one format drift
 * silently, and a webview that spelled a request one way against a host that
 * read it another would draw a graph that is wrong rather than raise an error
 * that is loud.
 */

import { describe, expect, it, vi } from 'vitest';

import { BridgeError } from '../src/bridge.js';
import { encodeViewRequest } from '../src/protocol.js';
import { CHANNEL, VsCodeBridge, type BridgeRequest } from '../src/vscode.js';

/** A window that delivers what the host posts back, synchronously. */
function channel(): {
  bridge: VsCodeBridge;
  sent: BridgeRequest[];
  posted: unknown[];
  deliver: (message: unknown) => void;
} {
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const posted: unknown[] = [];

  const target = {
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MessageEvent<unknown>) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MessageEvent<unknown>) => void);
    },
  } as unknown as Window;

  const bridge = new VsCodeBridge({
    api: {
      postMessage: (message: unknown) => {
        posted.push(message);
      },
    },
    target,
  });

  return {
    bridge,
    posted,
    get sent(): BridgeRequest[] {
      return posted.filter((message): message is BridgeRequest => 'method' in (message as object));
    },
    deliver: (message: unknown) => {
      for (const listener of listeners) listener({ data: message } as MessageEvent<unknown>);
    },
  };
}

describe('VsCodeBridge', () => {
  it('sends the same encoding browser mode puts in a query string', async () => {
    const link = channel();
    const request = {
      view: 'call' as const,
      focus: 'src/Vault.sol:Vault.deposit(uint256)',
      up: 1,
      down: 4,
    };
    const pending = link.bridge.view(request);

    expect(link.sent[0]).toMatchObject({
      channel: CHANNEL,
      id: 1,
      method: 'view',
      params: encodeViewRequest(request),
    });

    link.deliver({ channel: CHANNEL, id: 1, result: { view: 'call' } });
    await expect(pending).resolves.toEqual({ view: 'call' });
  });

  it('matches answers to requests by id, whatever order they arrive in', async () => {
    const link = channel();
    const first = link.bridge.inspect('a');
    const second = link.bridge.inspect('b');

    expect(link.sent.map((message) => message.id)).toEqual([1, 2]);

    link.deliver({ channel: CHANNEL, id: 2, result: 'second' });
    link.deliver({ channel: CHANNEL, id: 1, result: 'first' });

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('rejects with the host’s own refusal, numbers included (§9 rule 2)', async () => {
    const link = channel();
    const pending = link.bridge.view({ view: 'protocol' });
    link.deliver({
      channel: CHANNEL,
      id: 1,
      error: { name: 'RenderCapError', message: '2,847 nodes', elements: 2847, cap: 1500 },
    });

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).isRenderCap).toBe(true);
    expect((error as BridgeError).detail).toMatchObject({ elements: 2847, cap: 1500 });
  });

  it('ignores traffic that is not ours', async () => {
    const link = channel();
    const pending = link.bridge.meta();

    // A webview receives messages from other extensions and from the editor's
    // own plumbing; answering to an id from one of them would resolve a request
    // with somebody else's payload.
    link.deliver({ id: 1, result: 'not ours' });
    link.deliver('a string');
    link.deliver({ channel: 'something-else', id: 1, result: 'still not ours' });
    link.deliver({ channel: CHANNEL, id: 99, result: 'nobody asked' });

    link.deliver({ channel: CHANNEL, id: 1, result: 'ours' });
    await expect(pending).resolves.toBe('ours');
  });

  it('reports a channel that will not take the message, rather than hanging', async () => {
    const bridge = new VsCodeBridge({
      api: {
        postMessage: () => {
          throw new Error('disposed');
        },
      },
      target: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as Window,
    });

    await expect(bridge.meta()).rejects.toBeInstanceOf(BridgeError);
  });

  describe('the notifications a browser has no equivalent of', () => {
    it('posts a reveal for a node and for a call site (§11)', () => {
      const link = channel();
      link.bridge.reveal({ kind: 'node', id: 'src/Vault.sol:Vault.deposit(uint256)' });
      link.bridge.reveal({ kind: 'site', file: 'src/Vault.sol', line: 37, column: 8 });

      expect(link.posted).toEqual([
        {
          channel: CHANNEL,
          event: 'reveal',
          target: { kind: 'node', id: 'src/Vault.sol:Vault.deposit(uint256)' },
        },
        {
          channel: CHANNEL,
          event: 'reveal',
          target: { kind: 'site', file: 'src/Vault.sol', line: 37, column: 8 },
        },
      ]);
    });

    it('keeps select, focus and refresh apart', () => {
      const link = channel();
      const selected = vi.fn();
      const focused = vi.fn();
      const refreshed = vi.fn();
      link.bridge.onSelect(selected);
      link.bridge.onFocus(focused);
      link.bridge.onRefresh(refreshed);

      link.deliver({ channel: CHANNEL, event: 'select', id: 'a', kind: 'Function' });
      link.deliver({ channel: CHANNEL, event: 'focus', id: 'b', kind: 'Contract' });
      link.deliver({ channel: CHANNEL, event: 'refresh', reason: 'graph rebuilt' });

      // A cursor highlights and a command navigates; the whole reason there are
      // two events is that the UI answers them differently.
      expect(selected.mock.calls).toEqual([['a', 'Function']]);
      expect(focused.mock.calls).toEqual([['b', 'Contract']]);
      expect(refreshed.mock.calls).toEqual([['graph rebuilt']]);
    });

    it('unsubscribes', () => {
      const link = channel();
      const listener = vi.fn();
      link.bridge.onSelect(listener)();
      link.deliver({ channel: CHANNEL, event: 'select', id: 'a', kind: 'Function' });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  it('fails everything still in flight when the webview closes', async () => {
    const link = channel();
    const pending = link.bridge.meta();
    link.bridge.dispose();

    // A promise that never settles is a spinner that never stops.
    await expect(pending).rejects.toThrow(/webview was closed/);
    link.deliver({ channel: CHANNEL, id: 1, result: 'too late' });
  });
});
