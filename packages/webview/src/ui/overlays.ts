/**
 * §11's eight overlays, and the channel budget that keeps them readable.
 *
 * §11 is unusually specific about this and says why: "Eight combinable overlays
 * will turn into mud unless each owns a channel outright … this table is the
 * contract." So the allocation is written here once, as data, and everything
 * downstream reads it:
 *
 * | Channel | Overlay |
 * |---|---|
 * | Node fill | Review state |
 * | Node border colour | Access control & attack surface |
 * | Node border style | Resolution confidence |
 * | Node opacity | Reachability dimming (attack surface) |
 * | Node badges | Danger ops, imported findings, **reentrancy surface** |
 * | Node size | Complexity heatmap |
 *
 * Two of those rows need a word.
 *
 * **Border colour has two tenants, and §11 put them there** — "Access control &
 * attack surface — the primary audit signal". They are one signal read at two
 * strengths, so the precedence is fixed rather than by paint order: where access
 * control has a verdict about a function, it wins, because "externally callable
 * with no recognised guard" is strictly more specific than "externally
 * callable". Attack surface keeps the opacity channel outright and colours the
 * entrypoints access control says nothing about.
 *
 * **The reentrancy surface has no row in §11's table.** It is one of the eight
 * named overlays and the table allocates channels to seven of them; nothing else
 * is free, and §11's own rule is that an overlay which cannot be given a free
 * channel does not ship. Badges are the channel that is explicitly *stackable*
 * and already has two tenants, each owning a distinct glyph rather than a
 * distinct visual property — so a third glyph is what that channel is for, and
 * it is the only allocation that does not evict something. AXIOMAP.md §11 is
 * amended to name it.
 *
 * Everything in this file is a pure function of a view, the overlay data and the
 * active set. That is deliberate: what an overlay claims about a node is exactly
 * the kind of thing that is easy to get subtly wrong and hard to see wrong, and
 * it should be checkable without a canvas.
 */

import type { FunctionNode, GraphNode, OverlayData, Resolution } from '@axiomap/core';

export type OverlayName =
  | 'attack-surface'
  | 'access-control'
  | 'reentrancy'
  | 'danger-ops'
  | 'resolution'
  | 'complexity'
  | 'review'
  | 'findings';

/** How a badge is coloured. Semantic, never decorative (§11). */
export type Tone = 'danger' | 'warn' | 'info' | 'ok' | 'dim';

export interface Badge {
  /** One character, drawn in the node's top-right corner. */
  glyph: string;
  tone: Tone;
  /** What it means, for the legend and the inspector. */
  title: string;
  /** Which overlay put it there, so toggling one removes only its own. */
  overlay: OverlayName;
}

export interface LegendEntry {
  /** A glyph for badge overlays, a swatch class for the colour channels. */
  glyph?: string;
  tone?: Tone;
  swatch?: string;
  label: string;
}

export interface OverlayDefinition {
  name: OverlayName;
  label: string;
  /** The channel this overlay owns, named in the UI so the budget is visible. */
  channel: string;
  /** §11's own description, or the honest restatement of it. */
  hint: string;
  legend: readonly LegendEntry[];
  /** True when the overlay is empty without the host's audit-state files. */
  needsHostData?: boolean;
}

/** §11's list, in §11's order. */
export const OVERLAYS: readonly OverlayDefinition[] = [
  {
    name: 'attack-surface',
    label: 'Attack surface',
    channel: 'border colour + opacity',
    hint: 'External entrypoints outlined; anything nothing external can reach is dimmed. Reachability is over the edges this graph has — in structural mode that is entrypoints only.',
    legend: [
      { swatch: 'sw-entry', label: 'externally callable' },
      { swatch: 'sw-dim', label: 'not externally reachable' },
    ],
  },
  {
    name: 'access-control',
    label: 'Access control',
    channel: 'border colour',
    hint: 'State-mutating externals by what guard was recognised. `none` means no recognised guard was found, not that the function is unguarded (§10).',
    legend: [
      { swatch: 'sw-ac-none', label: 'no recognised guard' },
      { swatch: 'sw-ac-low', label: 'inline sender check only' },
      { swatch: 'sw-ac-high', label: 'recognised modifier' },
    ],
  },
  {
    name: 'reentrancy',
    label: 'Reentrancy surface',
    channel: 'badge',
    hint: 'External call followed by a state write, and whether a configured guard is applied. A heuristic highlighter, not a detector (§11).',
    legend: [
      { glyph: 'R', tone: 'danger', label: 'call-then-write, no recognised guard' },
      { glyph: 'R', tone: 'ok', label: 'call-then-write, guarded' },
    ],
  },
  {
    name: 'danger-ops',
    label: 'Danger ops',
    channel: 'badges',
    hint: 'Assembly, delegatecall, selfdestruct, low-level call, contract creation, value transfer.',
    legend: [
      { glyph: 'D', tone: 'danger', label: 'delegatecall' },
      { glyph: 'X', tone: 'danger', label: 'selfdestruct' },
      { glyph: 'A', tone: 'warn', label: 'inline assembly' },
      { glyph: 'L', tone: 'warn', label: 'low-level call' },
      { glyph: '$', tone: 'warn', label: 'sends value' },
      { glyph: 'C', tone: 'info', label: 'creates a contract' },
    ],
  },
  {
    name: 'resolution',
    label: 'Resolution confidence',
    channel: 'border style',
    hint: 'Where the graph is uncertain: a node is drawn as its least certain incident edge. Edges always carry this on their own line style (§4).',
    legend: [
      { swatch: 'sw-res-solid', label: 'semantic or heuristic' },
      { swatch: 'sw-res-dashed', label: 'an ambiguous edge touches it' },
      { swatch: 'sw-res-dotted', label: 'an unresolved edge touches it' },
    ],
  },
  {
    name: 'complexity',
    label: 'Complexity',
    channel: 'node size',
    hint: 'Cyclomatic complexity, from Phase 2 metrics. Bigger is more branching.',
    legend: [
      { swatch: 'sw-cx-low', label: '1–2' },
      { swatch: 'sw-cx-mid', label: '3–10' },
      { swatch: 'sw-cx-high', label: '11+' },
    ],
  },
  {
    name: 'review',
    label: 'Review state',
    channel: 'node fill',
    hint: 'From .axiomap/review.json. A review whose body hash no longer matches is stale — §8 calls that needs-re-review, and it overrides the recorded status.',
    legend: [
      { swatch: 'sw-rv-reviewed', label: 'reviewed' },
      { swatch: 'sw-rv-flagged', label: 'flagged' },
      { swatch: 'sw-rv-follow-up', label: 'follow-up' },
      { swatch: 'sw-rv-stale', label: 'stale — body changed since review' },
      { swatch: 'sw-rv-ignored', label: 'ignored' },
    ],
    needsHostData: true,
  },
  {
    name: 'findings',
    label: 'Imported findings',
    channel: 'badges',
    hint: 'From .axiomap/findings.json (slither --json). Slither’s words, not ours. A finding on a body that changed after the scan is drawn dim.',
    legend: [
      { glyph: '!', tone: 'danger', label: 'High impact' },
      { glyph: '!', tone: 'warn', label: 'Medium impact' },
      { glyph: '!', tone: 'info', label: 'Low / Informational' },
      { glyph: '!', tone: 'dim', label: 'stale — body changed since the scan' },
    ],
    needsHostData: true,
  },
];

export const OVERLAY_NAMES: readonly OverlayName[] = OVERLAYS.map((overlay) => overlay.name);

export function overlayDefinition(name: OverlayName): OverlayDefinition {
  const found = OVERLAYS.find((overlay) => overlay.name === name);
  // Unreachable: `OverlayName` is the union of the names above. Stated rather
  // than asserted, because a `!` here would be a silent undefined later.
  if (found === undefined) throw new Error(`No overlay named "${name}".`);
  return found;
}

/** What one node looks like once every active overlay has had its say. */
export interface NodeDecoration {
  classes: string[];
  badges: Badge[];
  /** §11's size channel: cytoscape padding, since node size is label + padding. */
  padding: number;
}

/** Padding at complexity 1, and what the base stylesheet uses with no overlay. */
export const BASE_PADDING = 8;

/**
 * Cyclomatic complexity → node padding.
 *
 * Buckets rather than a continuous scale, because §11's heatmap is read at a
 * glance and five sizes are distinguishable where thirty are not. The top
 * bucket is open-ended: a function at 60 is not thirty times the node of one at
 * 2, it is simply in the worst bucket, which is the honest reading.
 */
export function complexityPadding(cyclomatic: number): number {
  if (cyclomatic <= 2) return BASE_PADDING;
  if (cyclomatic <= 5) return 13;
  if (cyclomatic <= 10) return 19;
  if (cyclomatic <= 20) return 26;
  return 34;
}

function isFunction(node: GraphNode): node is FunctionNode {
  return node.kind === 'Function';
}

/** Externally callable as declared — §12's `externals`, in one predicate. */
export function isExternallyCallable(node: FunctionNode): boolean {
  if (node.subkind === 'modifier' || node.subkind === 'constructor') return false;
  return node.visibility === 'public' || node.visibility === 'external';
}

function mutatesState(node: FunctionNode): boolean {
  return node.stateMutability !== 'view' && node.stateMutability !== 'pure';
}

const RESOLUTION_RANK: Record<Resolution, number> = {
  semantic: 0,
  heuristic: 1,
  ambiguous: 2,
  unresolved: 3,
};

/**
 * The least certain edge touching each node.
 *
 * §11 gives resolution confidence the node border *style*, and a node has no
 * resolution of its own — only its edges do. The worst incident edge is the
 * same rollup rule `aggregate.ts` uses for a folded edge, and for the same
 * reason: rounding uncertainty up is the flattery §4 refuses.
 */
export function nodeUncertainty(
  edges: readonly { from: string; to: string; resolution: Resolution }[],
): Map<string, Resolution> {
  const worst = new Map<string, Resolution>();
  const note = (id: string, resolution: Resolution): void => {
    const current = worst.get(id);
    if (current === undefined || RESOLUTION_RANK[resolution] > RESOLUTION_RANK[current]) {
      worst.set(id, resolution);
    }
  };
  for (const edge of edges) {
    note(edge.from, edge.resolution);
    note(edge.to, edge.resolution);
  }
  return worst;
}

export interface DecorationInputs {
  active: ReadonlySet<OverlayName>;
  /** The host's two audit-state files, or null before they have arrived. */
  data: OverlayData | null;
  /** From {@link nodeUncertainty}, over the edges of the view being drawn. */
  uncertainty: ReadonlyMap<string, Resolution>;
}

function dangerBadges(node: FunctionNode): Badge[] {
  const badges: Badge[] = [];
  const add = (glyph: string, tone: Tone, title: string): void => {
    badges.push({ glyph, tone, title, overlay: 'danger-ops' });
  };
  if (node.flags.hasDelegatecall) add('D', 'danger', 'delegatecall');
  if (node.flags.hasSelfdestruct) add('X', 'danger', 'selfdestruct');
  if (node.flags.hasAssembly) add('A', 'warn', 'inline assembly');
  if (node.flags.hasLowLevelCall) add('L', 'warn', 'low-level call');
  if (node.flags.sendsValue) add('$', 'warn', 'sends value');
  if (node.flags.hasCreate) add('C', 'info', 'creates a contract');
  return badges;
}

function findingTone(impact: string, stale: boolean): Tone {
  if (stale) return 'dim';
  if (impact === 'High') return 'danger';
  if (impact === 'Medium') return 'warn';
  return 'info';
}

/**
 * One node, decorated by every active overlay.
 *
 * Order matters only where §11 gave one channel two tenants, and there the rule
 * is stated above rather than implied by which branch runs last.
 */
export function decorate(node: GraphNode, inputs: DecorationInputs): NodeDecoration {
  const { active, data, uncertainty } = inputs;
  const classes: string[] = [];
  const badges: Badge[] = [];
  let padding = BASE_PADDING;

  const fn = isFunction(node) ? node : null;

  // --- node fill: review state -------------------------------------------
  if (active.has('review') && data !== null) {
    const entry = data.review[node.id];
    if (entry !== undefined) {
      // §8: a stale review renders as needs-re-review, whatever it once said.
      classes.push(entry.staleness === 'stale' ? 'rv-stale' : `rv-${entry.status}`);
    }
  }

  // --- node border colour: access control, then attack surface ------------
  let borderClaimed = false;
  if (active.has('access-control') && fn !== null && isExternallyCallable(fn) && mutatesState(fn)) {
    classes.push(`ac-${fn.accessControl.confidence}`);
    borderClaimed = true;
  }
  if (active.has('attack-surface') && fn !== null) {
    if (isExternallyCallable(fn) && !borderClaimed) classes.push('surf-entry');
    // Opacity is attack surface's outright, so the dimming applies either way.
    if (!fn.externallyReachable) classes.push('surf-unreachable');
  }

  // --- node border style: resolution confidence ---------------------------
  if (active.has('resolution')) {
    const worst = uncertainty.get(node.id);
    if (worst === 'ambiguous' || worst === 'unresolved') classes.push(`res-node-${worst}`);
  }

  // --- node size: complexity ---------------------------------------------
  if (active.has('complexity') && fn !== null) {
    padding = complexityPadding(fn.metrics.cyclomatic);
  }

  // --- badges: reentrancy, danger ops, findings ---------------------------
  if (active.has('reentrancy') && fn !== null && fn.reentrancy.externalCallThenWrite) {
    badges.push({
      glyph: 'R',
      tone: fn.reentrancy.guarded ? 'ok' : 'danger',
      title: fn.reentrancy.guarded
        ? 'external call then state write — a configured guard is applied'
        : 'external call then state write — no recognised guard',
      overlay: 'reentrancy',
    });
  }
  if (active.has('danger-ops') && fn !== null) badges.push(...dangerBadges(fn));
  if (active.has('findings') && data !== null) {
    for (const finding of data.findings[node.id] ?? []) {
      badges.push({
        glyph: '!',
        tone: findingTone(finding.impact, finding.staleness !== 'current'),
        title:
          `${finding.check} (${finding.impact})` +
          (finding.staleness === 'current' ? '' : ' — stale: the body changed after the scan'),
        overlay: 'findings',
      });
    }
  }

  return { classes, badges, padding };
}

/**
 * How many drawn nodes each active overlay actually said something about.
 *
 * This exists because of what the first screenshots showed: six of the eight
 * overlays are about functions, and the protocol map draws contracts. Turning
 * "Access control" on there changed nothing on screen and reported nothing —
 * which is the same silence §4 refuses everywhere else in this tool, in a tool
 * whose argument is honesty about what it knows. An overlay with nothing to say
 * in this view now says that, rather than looking like a clean bill of health.
 *
 * Counted by running each overlay alone, so one overlay's coverage is not
 * inflated by another's classes.
 */
export function overlayCoverage(
  nodes: readonly GraphNode[],
  active: ReadonlySet<OverlayName>,
  data: OverlayData | null,
  uncertainty: ReadonlyMap<string, Resolution>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of active) {
    const alone = new Set<OverlayName>([name]);
    let touched = 0;
    for (const node of nodes) {
      const decoration = decorate(node, { active: alone, data, uncertainty });
      if (
        decoration.classes.length > 0 ||
        decoration.badges.length > 0 ||
        decoration.padding !== BASE_PADDING
      ) {
        touched += 1;
      }
    }
    counts[name] = touched;
  }
  return counts;
}

/** Badges past this are replaced by a `+`; a node label is not a list. */
export const MAX_BADGES = 4;

export function cappedBadges(badges: readonly Badge[]): Badge[] {
  if (badges.length <= MAX_BADGES) return [...badges];
  const shown = badges.slice(0, MAX_BADGES - 1);
  const hidden = badges.slice(MAX_BADGES - 1);
  return [
    ...shown,
    {
      glyph: '+',
      tone: 'dim',
      title: hidden.map((badge) => badge.title).join(', '),
      overlay: hidden[0]?.overlay ?? 'danger-ops',
    },
  ];
}
