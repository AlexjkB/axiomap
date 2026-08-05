/**
 * §11's eight overlays and the channel budget they share.
 *
 * The budget is the thing worth testing. Any one overlay's rule is a line of
 * code; what "eight combinable overlays" rests on is that no two of them write
 * the same visual property, and that the two §11 puts on one channel resolve by
 * a stated precedence rather than by which branch ran last.
 *
 * All of it is a pure function of a node plus the audit-state files, so none of
 * it needs a canvas — which is the point, since the defects Phase 7b found in a
 * browser were all in the part that could not be checked this way.
 */

import { describe, expect, it } from 'vitest';

import type { OverlayData } from '@axiomap/core';

import { badgeStrip } from '../src/ui/badges.js';
import { toElements } from '../src/ui/elements.js';
import {
  BASE_PADDING,
  cappedBadges,
  complexityPadding,
  decorate,
  MAX_BADGES,
  nodeUncertainty,
  overlayCoverage,
  OVERLAYS,
  OVERLAY_NAMES,
  type OverlayName,
} from '../src/ui/overlays.js';
import { PRESETS } from '../src/ui/presets.js';
import { FALLBACK_PALETTE } from '../src/ui/style.js';
import { contract, edge, fn, stateVariable, view } from './support.js';

const NONE = new Map<string, never>();

function only(...names: OverlayName[]): ReadonlySet<OverlayName> {
  return new Set(names);
}

const overlayFile = (over: Partial<OverlayData> = {}): OverlayData => ({
  review: {},
  findings: {},
  summary: {
    reviewed: 0,
    flagged: 0,
    followUp: 0,
    ignored: 0,
    stale: 0,
    orphaned: 0,
    findings: 0,
    findingsStale: 0,
  },
  sources: { review: true, findings: true },
  ...over,
});

describe('the overlay set', () => {
  it('is §11’s eight, and every one names the channel it owns', () => {
    expect(OVERLAY_NAMES).toEqual([
      'attack-surface',
      'access-control',
      'reentrancy',
      'danger-ops',
      'resolution',
      'complexity',
      'review',
      'findings',
    ]);
    for (const overlay of OVERLAYS) {
      expect(overlay.channel).not.toBe('');
      expect(overlay.legend.length).toBeGreaterThan(0);
    }
  });

  /**
   * §11: "no overlay may claim a channel another already owns". The classes an
   * overlay emits are its claim, so no class may be produced by two of them.
   */
  it('never emits the same class from two overlays', () => {
    const owner = new Map<string, OverlayName>();
    const nodes = [
      fn('src/Vault.sol:Vault.f()', {
        visibility: 'external',
        externallyReachable: false,
        accessControl: { modifiers: [], confidence: 'none' },
        reentrancy: { externalCallThenWrite: true, guarded: false },
        metrics: { sloc: 40, cyclomatic: 14, maxDepth: 4 },
      }),
      contract('src/Vault.sol:Vault'),
      stateVariable('src/Vault.sol:Vault.total'),
    ];

    for (const name of OVERLAY_NAMES) {
      for (const node of nodes) {
        const decoration = decorate(node, {
          active: only(name),
          data: overlayFile({
            review: {
              [node.id]: { status: 'flagged', staleness: 'current', at: '2026-08-05T00:00:00Z' },
            },
            findings: {
              [node.id]: [
                {
                  id: 'f1',
                  check: 'reentrancy-eth',
                  impact: 'High',
                  confidence: 'High',
                  description: 'x',
                  staleness: 'current',
                },
              ],
            },
          }),
          uncertainty: new Map([[node.id, 'unresolved' as const]]),
        });
        for (const className of decoration.classes) {
          const already = owner.get(className);
          expect(already === undefined || already === name).toBe(true);
          owner.set(className, name);
        }
      }
    }
  });
});

describe('the two tenants of the border-colour channel', () => {
  const unguarded = fn('src/Vault.sol:Vault.sweep()', {
    visibility: 'external',
    accessControl: { modifiers: [], confidence: 'none' },
  });

  it('gives an entrypoint the attack-surface border when only that is on', () => {
    const decoration = decorate(unguarded, {
      active: only('attack-surface'),
      data: null,
      uncertainty: NONE,
    });
    expect(decoration.classes).toContain('surf-entry');
  });

  it('lets access control win where it has a verdict, and keeps the dimming', () => {
    const unreachable = fn('src/Vault.sol:Vault.sweep()', {
      visibility: 'external',
      externallyReachable: false,
      accessControl: { modifiers: [], confidence: 'none' },
    });
    const decoration = decorate(unreachable, {
      active: only('attack-surface', 'access-control'),
      data: null,
      uncertainty: NONE,
    });
    // "Externally callable with no recognised guard" is strictly more specific
    // than "externally callable", so it takes the one border.
    expect(decoration.classes).toContain('ac-none');
    expect(decoration.classes).not.toContain('surf-entry');
    // Opacity is attack surface's outright and is unaffected by the precedence.
    expect(decoration.classes).toContain('surf-unreachable');
  });

  it('says nothing about a view function, which cannot be the §15 finding', () => {
    const getter = fn('src/Vault.sol:Vault.total()', {
      visibility: 'external',
      stateMutability: 'view',
      accessControl: { modifiers: [], confidence: 'none' },
    });
    const decoration = decorate(getter, {
      active: only('access-control'),
      data: null,
      uncertainty: NONE,
    });
    expect(decoration.classes).not.toContain('ac-none');
  });
});

describe('review state', () => {
  it('draws a stale review as stale whatever the entry claimed (§8)', () => {
    const node = fn('src/Vault.sol:Vault.deposit(uint256)');
    const data = overlayFile({
      review: {
        [node.id]: { status: 'reviewed', staleness: 'stale', at: '2026-08-05T00:00:00Z' },
      },
    });
    const decoration = decorate(node, { active: only('review'), data, uncertainty: NONE });
    // A green "reviewed" node whose body has changed is the one picture review
    // invalidation exists to prevent.
    expect(decoration.classes).toEqual(['rv-stale']);
  });

  it('paints nothing before the host’s files have arrived', () => {
    const node = fn('src/Vault.sol:Vault.deposit(uint256)');
    expect(decorate(node, { active: only('review'), data: null, uncertainty: NONE }).classes)
      .toEqual([]);
  });
});

describe('badges', () => {
  it('orders danger ops by how much an auditor cares', () => {
    const node = fn('src/Proxy.sol:Proxy.fallback', {
      flags: {
        ...fn('x').flags,
        hasAssembly: true,
        hasDelegatecall: true,
        hasLowLevelCall: true,
      },
    });
    const decoration = decorate(node, {
      active: only('danger-ops'),
      data: null,
      uncertainty: NONE,
    });
    expect(decoration.badges.map((badge) => badge.glyph)).toEqual(['D', 'A', 'L']);
  });

  it('distinguishes a guarded call-then-write shape from an unguarded one', () => {
    const shape = (guarded: boolean) =>
      decorate(
        fn('src/Pair.sol:Pair.swap()', {
          reentrancy: { externalCallThenWrite: true, guarded },
        }),
        { active: only('reentrancy'), data: null, uncertainty: NONE },
      ).badges[0];
    expect(shape(false)?.tone).toBe('danger');
    expect(shape(true)?.tone).toBe('ok');
  });

  it('dims a finding whose body changed after the scan', () => {
    const node = fn('src/Pair.sol:Pair.mint(address)');
    const decoration = decorate(node, {
      active: only('findings'),
      data: overlayFile({
        findings: {
          [node.id]: [
            {
              id: 'f1',
              check: 'divide-before-multiply',
              impact: 'High',
              confidence: 'Medium',
              description: 'x',
              staleness: 'stale',
            },
          ],
        },
      }),
      uncertainty: NONE,
    });
    // Still High — what changed is whether it is evidence, not what it said —
    // and faded rather than recoloured, so it stays visible on a light theme.
    expect(decoration.badges[0]?.tone).toBe('danger');
    expect(decoration.badges[0]?.faded).toBe(true);
    expect(decoration.badges[0]?.title).toMatch(/stale/);
  });

  it('caps the strip and keeps what it dropped in the last badge’s title', () => {
    const badges = cappedBadges([
      { glyph: 'D', tone: 'danger', title: 'delegatecall', overlay: 'danger-ops' },
      { glyph: 'X', tone: 'danger', title: 'selfdestruct', overlay: 'danger-ops' },
      { glyph: 'A', tone: 'warn', title: 'inline assembly', overlay: 'danger-ops' },
      { glyph: 'L', tone: 'warn', title: 'low-level call', overlay: 'danger-ops' },
      { glyph: '$', tone: 'warn', title: 'sends value', overlay: 'danger-ops' },
    ]);
    expect(badges).toHaveLength(MAX_BADGES);
    expect(badges.at(-1)?.glyph).toBe('+');
    expect(badges.at(-1)?.title).toBe('low-level call, sends value');
  });

  it('encodes the strip so a themed colour cannot truncate the data URI', () => {
    const strip = badgeStrip(
      [{ glyph: 'D', tone: 'danger', title: 'delegatecall', overlay: 'danger-ops' }],
      FALLBACK_PALETTE,
    );
    // A raw `#` in a data URI starts a fragment: the rest of the SVG would be
    // dropped and the badge would silently not draw.
    expect(strip?.image.includes('#')).toBe(false);
    expect(strip?.image.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(strip?.width).toBeGreaterThan(0);
    expect(badgeStrip([], FALLBACK_PALETTE)).toBeNull();
  });
});

describe('the other two channels', () => {
  it('sizes a node by its cyclomatic complexity, in buckets', () => {
    expect(complexityPadding(1)).toBe(BASE_PADDING);
    expect(complexityPadding(4)).toBeGreaterThan(complexityPadding(2));
    expect(complexityPadding(40)).toBe(complexityPadding(21));
  });

  it('takes a node’s confidence from its least certain edge', () => {
    const worst = nodeUncertainty([
      { from: 'a', to: 'b', resolution: 'semantic' },
      { from: 'b', to: 'c', resolution: 'unresolved' },
      { from: 'c', to: 'd', resolution: 'ambiguous' },
    ]);
    // The same rollup rule `aggregate.ts` uses: an aggregate is only as certain
    // as its least certain member.
    expect(worst.get('b')).toBe('unresolved');
    expect(worst.get('a')).toBe('semantic');
    expect(worst.get('c')).toBe('unresolved');
  });
});

describe('what the elements carry', () => {
  const flagged = fn('src/Vault.sol:Vault.sweep()', {
    flags: { ...fn('x').flags, hasDelegatecall: true },
    metrics: { sloc: 30, cyclomatic: 12, maxDepth: 3 },
  });
  const drawn = view({
    view: 'contract',
    nodes: [{ type: 'node', id: flagged.id, node: flagged, parent: null }],
    edges: [],
    elements: 1,
  });

  it('is exactly the view’s own translation when no overlay is on', () => {
    const plain = toElements(drawn, PRESETS.contract);
    const node = plain.nodes[0];
    expect(node?.data.badges).toBeUndefined();
    expect(node?.data.pad).toBe(`${String(BASE_PADDING)}px`);
    expect(node?.classes.includes('rv-')).toBe(false);
  });

  it('adds only overlay data on top, never replacing the view’s', () => {
    const plain = toElements(drawn, PRESETS.contract);
    const lit = toElements(drawn, PRESETS.contract, {
      active: only('danger-ops', 'complexity'),
      data: null,
    });
    const before = plain.nodes[0];
    const after = lit.nodes[0];

    expect(after?.data.label).toBe(before?.data.label);
    expect(after?.classes.startsWith(before?.classes ?? '')).toBe(true);
    expect(after?.data.badges).toMatch(/^data:image\/svg\+xml/);
    expect(after?.data.badgeTitles).toBe('D delegatecall');
    expect(after?.data.pad).toBe(`${String(complexityPadding(12))}px`);
  });

  it('leaves a cluster alone — it stands for what is not drawn', () => {
    const clustered = view({
      nodes: [
        {
          type: 'cluster',
          id: 'dir:src',
          path: 'src',
          label: 'src',
          parent: null,
          expanded: false,
          members: 40,
          internalEdges: 12,
        },
      ],
    });
    const lit = toElements(clustered, PRESETS.protocol, {
      active: new Set(OVERLAY_NAMES),
      data: null,
    });
    // The aggregation layer sends counts, not the attributes of what it hid, so
    // a clean-looking box is the honest answer here rather than a claim.
    expect(lit.nodes[0]?.data.badges).toBeUndefined();
    expect(lit.nodes[0]?.classes).toBe('cluster collapsed');
  });
});

describe('coverage', () => {
  it('reports zero for an overlay with nothing to say in this view', () => {
    const contracts = [contract('src/Vault.sol:Vault'), contract('src/Pair.sol:Pair')];
    const counts = overlayCoverage(contracts, only('access-control', 'danger-ops'), null, NONE);
    // The protocol map draws contracts; six of the eight overlays are about
    // functions. Silence here is what the legend turns into a sentence.
    expect(counts['access-control']).toBe(0);
    expect(counts['danger-ops']).toBe(0);
  });

  it('counts the nodes one overlay marked, not what another one did', () => {
    const nodes = [
      fn('src/Vault.sol:Vault.a()', { flags: { ...fn('x').flags, hasAssembly: true } }),
      fn('src/Vault.sol:Vault.b()', { visibility: 'internal' }),
    ];
    const counts = overlayCoverage(nodes, only('danger-ops', 'attack-surface'), null, NONE);
    expect(counts['danger-ops']).toBe(1);
    // `a` is external and reachable; `b` is internal but reachable, so only the
    // entrypoint border is drawn.
    expect(counts['attack-surface']).toBe(1);
  });
});

describe('edges keep the channels they had in 7b', () => {
  it('does not let an overlay touch an edge’s class list', () => {
    const a = fn('src/Vault.sol:Vault.a()');
    const b = fn('src/Vault.sol:Vault.b()');
    const drawn = view({
      view: 'call',
      nodes: [
        { type: 'node', id: a.id, node: a, parent: null },
        { type: 'node', id: b.id, node: b, parent: null },
      ],
      edges: [
        {
          type: 'edge',
          id: 'e1',
          edge: edge({ id: 'e1', from: a.id, to: b.id, resolution: 'ambiguous' }),
          from: a.id,
          to: b.id,
        },
      ],
    });

    const plain = toElements(drawn, PRESETS.call);
    const lit = toElements(drawn, PRESETS.call, {
      active: new Set(OVERLAY_NAMES),
      data: null,
    });
    // Edge colour, style and weight belong to the view (kind, resolution,
    // call-site count) and no overlay was given them.
    expect(lit.edges).toEqual(plain.edges);
  });
});
