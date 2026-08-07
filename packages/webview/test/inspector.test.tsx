// @vitest-environment jsdom

/**
 * §16 (Phase 8c): NatSpec on the inspector.
 *
 * The parser stores a doc comment verbatim and never resolves `@inheritdoc`
 * — §16 settles that resolving which base it names is a UI concern, so this
 * is where it is tested. The candidate is whatever `overrides`/`implements`
 * relation this function's own inspection already carries; there is nothing
 * else to look at, because §5 leaves this package unable to hold a graph.
 */

import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NodeInspection, NodeRelation } from '@axiomap/core';

import { Inspector } from '../src/ui/Inspector.js';
import { FALLBACK_PALETTE } from '../src/ui/style.js';
import { contract, fn } from './support.js';

afterEach(cleanup);

function relation(over: Partial<NodeRelation> & Pick<NodeRelation, 'id' | 'name'>): NodeRelation {
  return {
    kind: 'Function',
    edgeKind: 'calls',
    subkind: undefined,
    resolution: 'heuristic',
    count: 1,
    src: { file: 'src/IVault.sol', offset: 0, length: 1, line: 1, column: 0 },
    virtual: false,
    crossTrustBoundary: false,
    ...over,
  };
}

function inspection(over: Partial<NodeInspection> = {}): NodeInspection {
  return {
    id: 'src/Vault.sol:Vault.deposit(uint256)',
    node: fn('src/Vault.sol:Vault.deposit(uint256)'),
    scope: null,
    members: [],
    incoming: [],
    outgoing: [],
    ...over,
  };
}

function renderInspector(
  node: NodeInspection,
  onInspect: (id: string) => void = () => undefined,
): HTMLElement {
  const { container } = render(
    <Inspector
      inspection={node}
      busy={false}
      error={null}
      auditState={null}
      slice={null}
      sliceBusy={false}
      sliceError={null}
      palette={FALLBACK_PALETTE}
      onInspect={onInspect}
      onFocus={() => undefined}
      onClose={() => undefined}
    />,
  );
  return container;
}

/** The NatSpec section, or null when nothing rendered it. */
function natspecSection(container: HTMLElement): HTMLElement | null {
  const heading = within(container).queryByText('NatSpec');
  return heading?.closest('section') ?? null;
}

describe('the inspector’s NatSpec section', () => {
  it('shows nothing when there is no doc comment', () => {
    const container = renderInspector(inspection());
    expect(natspecSection(container)).toBeNull();
  });

  it('shows the doc comment verbatim, markers and all', () => {
    const container = renderInspector(
      inspection({
        node: fn('src/Vault.sol:Vault.deposit(uint256)', {
          natspec: '/// @notice Deposits into the vault.\n/// @dev Rounds down.',
        }),
      }),
    );
    const section = natspecSection(container);
    expect(section).not.toBeNull();
    expect(section?.querySelector('.ax-natspec')?.textContent).toBe(
      '/// @notice Deposits into the vault.\n/// @dev Rounds down.',
    );
  });

  it('shows the same doc comment on a Contract node', () => {
    const container = renderInspector(
      inspection({
        node: contract('src/Vault.sol:Vault', { natspec: '/// @notice The vault.' }),
      }),
    );
    expect(natspecSection(container)?.querySelector('.ax-natspec')?.textContent).toBe(
      '/// @notice The vault.',
    );
  });

  it('resolves @inheritdoc against an overrides/implements relation already on the node', () => {
    const onInspect = vi.fn();
    const container = renderInspector(
      inspection({
        node: fn('src/Vault.sol:Vault.deposit(uint256)', { natspec: '/// @inheritdoc IVault' }),
        outgoing: [
          relation({
            id: 'src/IVault.sol:IVault.deposit(uint256)',
            name: 'deposit',
            edgeKind: 'implements',
          }),
        ],
      }),
      onInspect,
    );

    const section = natspecSection(container);
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByText('@inheritdoc → implements')).not.toBeNull();

    fireEvent.click(within(section as HTMLElement).getByText('deposit'));
    expect(onInspect).toHaveBeenCalledWith('src/IVault.sol:IVault.deposit(uint256)');
  });

  it('says so when @inheritdoc cannot be resolved in this graph', () => {
    const container = renderInspector(
      inspection({
        node: fn('src/Vault.sol:Vault.deposit(uint256)', { natspec: '/// @inheritdoc IVault' }),
        outgoing: [],
      }),
    );
    const section = natspecSection(container);
    expect(
      within(section as HTMLElement).getByText(
        /does not override or implement anything in this graph/,
      ),
    ).not.toBeNull();
  });
});
