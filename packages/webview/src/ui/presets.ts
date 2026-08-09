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
  /**
   * Whether the *engine* reads the focus when drawing this view.
   *
   * Wider than `needsFocus`: the state-access map takes an optional focus that
   * narrows it to one contract, so it uses one without requiring one. The
   * protocol map and the inheritance view ignore it entirely — `selectView`
   * calls `protocolView(graph, includeTests)` and never looks at it.
   *
   * This exists because a click now sets a focus without navigating, and a
   * request that carries a field the view does not read is still a *different
   * request*: the app would re-fetch and ELK would re-lay-out the protocol map
   * on every click, throwing away the viewport, to be handed back the graph
   * already on screen.
   */
  usesFocus: boolean;
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
  /**
   * Whether a node's flag summary may say `reads` / `writes`.
   *
   * False for the state-access map, where every edge already carries that per
   * *variable* and in colour. The node-level flag is not a second copy of it,
   * it is a worse one: `flags` is `writesState ? 'writes' : readsState &&
   * 'reads'`, so a function that does both — which is most of them — reports
   * only `writes` while its own edges correctly draw one of each. A label that
   * disagrees with the edges leaving it is worse than a label that says less.
   *
   * True everywhere else, where nothing else on screen answers "does this
   * touch storage at all" and §11's density target wants four facts per node.
   */
  stateInFlags: boolean;
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
   * Crossing-minimisation effort, measured rather than chosen: on the
   * 300-contract map in `test/scale.test.ts` — a deliberately dense one, every
   * drawn contract calling six others across directories — ELK's default of 7
   * takes 525 ms and this takes 272 ms.
   *
   * Both numbers depend entirely on the setting below, and that is the lesson
   * this line records. Measured first against a *flattened* hierarchy, the same
   * graph took 6.2 s at this thoroughness and 37 s with
   * `considerModelOrder.strategy: NODES_AND_EDGES` — so that option was removed
   * as ruinously expensive when it is nothing of the sort (218 ms here). Tuning
   * the cheap knobs first is how an hour goes into a 2x while a 23x sits
   * untouched one line below.
   */
  'elk.layered.thoroughness': '4',
  /*
   * Each directory is laid out inside its own box, and the boxes are then
   * placed. This is ELK's default for `layered` and it is the right one here,
   * which was only obvious once it was on screen: `INCLUDE_CHILDREN` flattens
   * the hierarchy into one graph, so two contracts in the same directory can
   * end up at opposite ends of the canvas — and since a compound node's box is
   * fitted around its children, that directory's box then wraps half the map
   * and everything unrelated inside it. A cluster has to be a place, or §9
   * rule 3's drill-down is pointing at nothing.
   */
  'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
  'elk.padding': '[top=32,left=16,bottom=16,right=16]',
};

export const PRESETS: Record<ViewName, ViewPreset> = {
  protocol: {
    view: 'protocol',
    label: 'Protocol map',
    hint: 'Contracts clustered by directory; cross-contract calls aggregated and weighted by call site. Click a directory to drill in, a contract to inspect it, double-click to open it.',
    needsFocus: false,
    usesFocus: false,
    focusKinds: ['Contract'],
    layout: { ...LAYERED, 'elk.direction': 'RIGHT' },
    partitioned: false,
    clustered: true,
    stateInFlags: true,
  },
  contract: {
    view: 'contract',
    label: 'Contract detail',
    hint: "One contract's members, with inherited members in their own tier. Click a function to open the call graph on it.",
    needsFocus: true,
    usesFocus: true,
    focusKinds: ['Contract'],
    layout: { ...LAYERED, 'elk.direction': 'DOWN' },
    partitioned: false,
    clustered: false,
    stateInFlags: true,
  },
  call: {
    view: 'call',
    label: 'Call graph',
    hint: 'Function level, rooted on a focus node (§9 rule 4). Callers to the left, callees to the right.',
    needsFocus: true,
    usesFocus: true,
    focusKinds: ['Function'],
    layout: { ...LAYERED, 'elk.direction': 'RIGHT' },
    partitioned: false,
    clustered: false,
    stateInFlags: true,
  },
  'state-access': {
    view: 'state-access',
    label: 'State access',
    hint: 'Functions left, storage right. Blue reads, orange writes — who can touch this.',
    needsFocus: false,
    usesFocus: true,
    focusKinds: ['Contract'],
    layout: {
      ...LAYERED,
      'elk.direction': 'RIGHT',
      'elk.partitioning.activate': 'true',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
    },
    partitioned: true,
    clustered: false,
    stateInFlags: false,
  },
  inheritance: {
    view: 'inheritance',
    label: 'Inheritance',
    hint: 'C3 order, bases above their derived contracts. Members that override or implement are drawn inside their contract.',
    needsFocus: false,
    usesFocus: false,
    focusKinds: ['Contract'],
    // `inherits` points derived → base (§10), so UP puts bases at the top.
    layout: { ...LAYERED, 'elk.direction': 'UP' },
    partitioned: false,
    clustered: false,
    stateInFlags: true,
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
