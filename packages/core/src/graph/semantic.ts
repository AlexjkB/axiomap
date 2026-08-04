/**
 * The seam between the graph and the semantic tier (§4, §5).
 *
 * §5 makes `enrich/` the only directory allowed to require a compiler, so the
 * *contract* lives here and the implementation lives there. Everything below is
 * plain data and pure functions over it: nothing in this file reads an
 * artifact, spawns solc, or knows what a build-info file looks like. Deleting
 * `enrich/` leaves this file compiling and the graph building — which is the
 * property `test/enrich-stub.test.ts` exists to keep true.
 *
 * ### What enrichment is allowed to do
 *
 * §7's Phase 3 exit criterion is that the enriched graph is *identical in shape*
 * to the heuristic one — same nodes, same edges keyed by `(kind, subkind, from,
 * to)` — with only confidence labels changing. So:
 *
 * - **Upgrade.** A site the compiler bound to the node we guessed becomes
 *   `semantic`. This is the overwhelming majority.
 * - **Retarget an `unresolved` edge.** §7 names this as one of the two legal
 *   shape changes: the synthetic `?` node loses an edge, a real node gains one,
 *   and the orphaned placeholder drops out.
 * - **Prune an `ambiguous` fan-out.** §4 emits an edge per overload candidate
 *   because nothing syntactic can choose between them. A compiler chooses, and
 *   keeping the losers would mean `full` mode asserting calls that do not
 *   happen.
 * - **Retarget a `heuristic` edge, loudly.** The compiler is right and we were
 *   wrong, so the edge moves — and a `warning` diagnostic says so, because per
 *   §7 that is a resolver bug to fix rather than a difference to live with.
 *
 * It may **not** add an edge. A solc AST yields call sites the heuristic tier
 * deliberately drops — type conversions, struct construction, `abi.*`, array
 * members, `new bytes(n)` — and walking every `FunctionCall` node would invent
 * edges Phase 2 never had and fail the criterion for a reason that is not a
 * resolver bug.
 */

import type { EdgeDraft } from '../resolve/index.js';
import type { NodeId } from '../symbols/ids.js';
import type { EdgeKind, GraphNode } from './schema.js';

/**
 * How a reference reads at a source position. One byte offset can host several
 * — in `token0.safeTransfer(to, amount)` the identifier, the member access and
 * the call all start at the same byte — so a lookup says which kind of
 * reference it wants rather than taking whatever was indexed first.
 */
export type ReferenceClass = 'call' | 'variable' | 'emit' | 'revert';

/** Which class of reference each edge kind is resolved by, if any. */
const REFERENCE_CLASS: Partial<Record<EdgeKind, ReferenceClass>> = {
  calls: 'call',
  creates: 'call',
  reads: 'variable',
  writes: 'variable',
  emits: 'emit',
  reverts: 'revert',
};

/**
 * Edge kinds the compiler confirms as a *relation* rather than at a call site.
 *
 * Their drafts carry the declaration's own `SourceRef` — an `inherits` edge
 * points at the contract, not at the name in the `is` clause — so there is no
 * site to look up. solc answers these directly: `baseContracts` for inheritance,
 * `baseFunctions` for overrides and implementations, `modifiers` for
 * `modifiedBy`.
 */
const RELATION_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'inherits',
  'overrides',
  'implements',
  'modifiedBy',
]);

export interface StorageSlot {
  /** Decimal, as a string: a slot is a uint256 and does not fit a number. */
  slot: string;
  offset: number;
}

/**
 * What the semantic tier knows, expressed so the graph can consume it without
 * knowing where it came from.
 */
export interface SemanticOverlay {
  /** solc versions that produced it, for the build summary. `0.8.28`, … */
  readonly compilers: readonly string[];
  /**
   * Project-relative files the compiler saw **byte-identically** to what is on
   * disk now. Stale artifacts are the one way enrichment can be actively
   * harmful: every offset in them would be wrong, and navigation would land in
   * the wrong place. Files that do not match are simply not enriched.
   */
  covers(file: string): boolean;
  /** The declaration the compiler bound at this site, as one of our node ids. */
  reference(cls: ReferenceClass, file: string, offset: number): NodeId | null;
  /** Whether the compiler agrees this relation exists. */
  confirms(kind: EdgeKind, from: NodeId, to: NodeId): boolean;
  selector(id: NodeId): string | undefined;
  storage(id: NodeId): StorageSlot | undefined;
}

export interface SemanticApplication {
  drafts: EdgeDraft[];
  /** Sites the compiler confirmed. */
  upgraded: number;
  /** `unresolved` edges that found a real target. */
  retargeted: number;
  /** `ambiguous` candidates the compiler ruled out. */
  pruned: number;
  /** Heuristic targets the compiler disagreed with — resolver bugs (§7). */
  corrected: number;
  warnings: string[];
}

function siteKey(draft: EdgeDraft): string {
  return `${draft.from}|${draft.kind}|${draft.src.file}|${draft.src.offset}`;
}

function upgrade(draft: EdgeDraft, to: NodeId): EdgeDraft {
  const next: EdgeDraft = { ...draft, to, resolution: 'semantic' };
  // The reason existed to explain an uncertainty that no longer exists.
  delete next.reason;
  return next;
}

/**
 * Apply the overlay to the resolver's edge drafts, **before** they collapse.
 *
 * Drafts are one per call site; collapsed edges are one per (from, to, kind,
 * subkind) and merge sites that may disagree. Upgrading before the collapse
 * means a call site the compiler confirmed and one it never saw merge under
 * §10's existing weakest-wins rule, rather than needing a second rule here.
 */
export function applySemanticOverlay(
  drafts: readonly EdgeDraft[],
  overlay: SemanticOverlay,
): SemanticApplication {
  // What the compiler bound at each ambiguous fan-out's site, so a candidate
  // can tell "the compiler chose my sibling" from "the compiler said nothing".
  const chosen = new Map<string, NodeId>();
  for (const draft of drafts) {
    if (draft.resolution !== 'ambiguous') continue;
    const cls = REFERENCE_CLASS[draft.kind];
    if (cls === undefined || !overlay.covers(draft.src.file)) continue;
    const target = overlay.reference(cls, draft.src.file, draft.src.offset);
    if (target !== null) chosen.set(siteKey(draft), target);
  }

  const out: EdgeDraft[] = [];
  const application: Omit<SemanticApplication, 'drafts'> = {
    upgraded: 0,
    retargeted: 0,
    pruned: 0,
    corrected: 0,
    warnings: [],
  };

  for (const draft of drafts) {
    // `declares` is containment; it never required resolving a name (§10) and
    // there is nothing for a compiler to confirm.
    if (draft.kind === 'declares' || !overlay.covers(draft.src.file)) {
      out.push(draft);
      continue;
    }

    if (RELATION_KINDS.has(draft.kind)) {
      if (overlay.confirms(draft.kind, draft.from, draft.to)) {
        application.upgraded++;
        out.push(upgrade(draft, draft.to));
      } else {
        out.push(draft);
      }
      continue;
    }

    const cls = REFERENCE_CLASS[draft.kind];
    if (cls === undefined) {
      out.push(draft);
      continue;
    }

    const target = overlay.reference(cls, draft.src.file, draft.src.offset);

    // Nothing was bound here. A low-level `.call` has no referenced
    // declaration by construction, and an `unresolved` edge staying unresolved
    // is the right answer rather than a gap.
    if (target === null) {
      out.push(draft);
      continue;
    }

    if (target === draft.to) {
      application.upgraded++;
      out.push(upgrade(draft, target));
      continue;
    }

    if (draft.resolution === 'unresolved') {
      application.retargeted++;
      out.push(upgrade(draft, target));
      continue;
    }

    if (draft.resolution === 'ambiguous' && chosen.get(siteKey(draft)) === target) {
      // A sibling candidate is the compiler's answer and will be upgraded on
      // its own turn. This one is not.
      application.pruned++;
      continue;
    }

    application.corrected++;
    application.warnings.push(
      `${draft.kind} edge from ${draft.from} at ${draft.src.file}:${draft.src.line}:${draft.src.column} ` +
        `resolved heuristically to ${draft.to}, but the compiler binds it to ${target}. ` +
        'The semantic answer is used; the heuristic resolver has a bug here.',
    );
    out.push(upgrade(draft, target));
  }

  return { drafts: out, ...application };
}

/**
 * Selectors and storage slots (§10), which exist only in the semantic tier.
 *
 * Mutates in place, on nodes the builder has just created and not yet handed
 * out. Both fields are absent rather than null when the compiler did not supply
 * them: a `slot` of `"0"` is a fact and no `slot` at all is the absence of one,
 * and §16's storage-collision work depends on being able to tell them apart.
 */
export function applySemanticNodeAttributes(
  nodes: readonly GraphNode[],
  overlay: SemanticOverlay,
): { selectors: number; slots: number } {
  let selectors = 0;
  let slots = 0;

  for (const node of nodes) {
    if (node.kind === 'Function') {
      const selector = overlay.selector(node.id);
      if (selector !== undefined) {
        node.selector = selector;
        selectors++;
      }
    } else if (node.kind === 'StateVariable') {
      const selector = overlay.selector(node.id);
      if (selector !== undefined) node.selector = selector;
      const slot = overlay.storage(node.id);
      if (slot !== undefined) {
        node.slot = slot.slot;
        node.offset = slot.offset;
        slots++;
      }
    }
  }

  return { selectors, slots };
}
