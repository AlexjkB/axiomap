/**
 * §11's five views, as *rendering* presets.
 *
 * §11: a view is "a filter + layout + styling preset over one graph, never a
 * separate pipeline". Phase 6 built the filter third — `core/query/views.ts`,
 * selection only — and this file is the other two thirds. There is no view
 * here that is not one of core's five, and no view of core's that is missing
 * one: `PRESETS` is keyed by `ViewName`, so a sixth view added to the engine
 * fails to compile until it has a way to be drawn.
 *
 * The layout knobs are ELK's, because §3 picked ELK and §9 rule 6 puts it in a
 * worker; the styling knobs are read by `style.ts`. Neither is a decision this
 * file makes twice — the same preset object drives both.
 */

import type { ViewName } from '@axiomap/core';

/** ELK options for one view, as `elk.*` keys. */
export type ElkOptions = Record<string, string>;

export interface ViewPreset {
  view: ViewName;
  /** What the toolbar calls it. */
  label: string;
  /** One line under the title, shown while the view is current. */
  hint: string;
  /** Whether `selectView` refuses this view without a focus node (§9 rule 4). */
  needsFocus: boolean;
  /** Node kinds a click can re-focus this view on. */
  focusKinds: readonly string[];
  layout: ElkOptions;
  /**
   * §11's state-access map is bipartite — "functions left, storage right" — and
   * that is a layout constraint rather than a style: ELK partitions.
   */
  partitioned: boolean;
  /** Directory clustering, matching `aggregate`'s own default for the view. */
  clustered: boolean;
}

/**
 * Shared ELK settings.
 *
 * `layered` is §3's choice and its reason — "ELK layered is correct for call
 * graphs" — and the two spacing numbers are the density §11 asks for: enough
 * room to read a four-fact node label, not enough to make a 300-contract map
 * scroll for a minute.
 */
const LAYERED: ElkOptions = {
  'elk.algorithm': 'layered',
  'elk.layered.spacing.nodeNodeBetweenLayers': '48',
  'elk.spacing.nodeNode': '24',
  /*
   * Crossing-minimisation effort, measured rather than chosen. On the
   * 300-contract map in `test/scale.test.ts` — a deliberately dense one, every
   * drawn contract calling six others across directories — ELK's default of 7
   * takes 8.2 s and this takes 5.5 s; on a realistically sparse map of the same
   * size, 0.76 s against 0.54 s.
   *
   * The setting that mattered far more was one that is *not* here any more:
   * `considerModelOrder.strategy: NODES_AND_EDGES` cost **37 s** on the same
   * graph, 4.5x everything else put together, for a tie-break rule that only
   * decides the order of otherwise-equal nodes. It was removed.
   */
  'elk.layered.thoroughness': '4',
  // Compound nodes are how a collapsed directory is drawn (§9 rule 3), and
  // without this ELK lays each cluster out in isolation and overlaps them.
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.padding': '[top=32,left=16,bottom=16,right=16]',
};

export const PRESETS: Record<ViewName, ViewPreset> = {
  protocol: {
    view: 'protocol',
    label: 'Protocol map',
    hint: 'Contracts clustered by directory; cross-contract calls aggregated and weighted by call site. Click a directory to drill in, a contract to open it.',
    needsFocus: false,
    focusKinds: ['Contract'],
    layout: { ...LAYERED, 'elk.direction': 'RIGHT' },
    partitioned: false,
    clustered: true,
  },
  contract: {
    view: 'contract',
    label: 'Contract detail',
    hint: "One contract's members, with inherited members in their own tier. Click a function to open the call graph on it.",
    needsFocus: true,
    focusKinds: ['Contract'],
    layout: { ...LAYERED, 'elk.direction': 'DOWN' },
    partitioned: false,
    clustered: false,
  },
  call: {
    view: 'call',
    label: 'Call graph',
    hint: 'Function level, rooted on a focus node (§9 rule 4). Callers to the left, callees to the right.',
    needsFocus: true,
    focusKinds: ['Function'],
    layout: { ...LAYERED, 'elk.direction': 'RIGHT' },
    partitioned: false,
    clustered: false,
  },
  'state-access': {
    view: 'state-access',
    label: 'State access',
    hint: 'Functions left, storage right. Blue reads, orange writes — who can touch this.',
    needsFocus: false,
    focusKinds: ['Contract'],
    layout: {
      ...LAYERED,
      'elk.direction': 'RIGHT',
      'elk.partitioning.activate': 'true',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
    },
    partitioned: true,
    clustered: false,
  },
  inheritance: {
    view: 'inheritance',
    label: 'Inheritance',
    hint: 'C3 order, bases above their derived contracts. Members that override or implement are drawn inside their contract.',
    needsFocus: false,
    focusKinds: ['Contract'],
    // `inherits` points derived → base (§10), so UP puts bases at the top.
    layout: { ...LAYERED, 'elk.direction': 'UP' },
    partitioned: false,
    clustered: false,
  },
};

export const PRESET_ORDER: readonly ViewName[] = [
  'protocol',
  'contract',
  'call',
  'state-access',
  'inheritance',
];

export function presetFor(view: ViewName): ViewPreset {
  return PRESETS[view];
}
