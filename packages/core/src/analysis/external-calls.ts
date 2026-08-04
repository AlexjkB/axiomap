/**
 * External-call classification, and the reentrancy *shape* that falls out of it
 * (§7 Phase 4, §10's `reentrancy`, §11's reentrancy-surface overlay).
 *
 * §11 is explicit that this is "a heuristic highlighter, not a detector", and
 * the UI copy has to say so. What it computes is narrow and checkable: control
 * left this contract, and then this body wrote to storage.
 *
 * ### Which calls leave the contract
 *
 * By subkind (§10): `external`, `delegatecall` and `lowlevel`. `internal` and
 * `super` do not. `library` is the interesting one — it does not leave the
 * contract by itself, since an internal library function is inlined and an
 * external one runs on this contract's storage under `delegatecall` — but
 * `SafeERC20.safeTransfer` most certainly reaches a foreign contract, and that
 * is the single most common shape of the bug this overlay is looking for.
 *
 * So the classification is transitive: a call is external-reaching if it is
 * directly external, or if its callee is a function in this project that
 * reaches one. Without that, `_transferOut(); balances[msg.sender] = 0;` —
 * checks-effects-interactions violated through one helper — reads as clean.
 *
 * The cost is precision, in the direction §11 already accepts: a function three
 * hops above a token transfer is flagged. `guarded` is what makes that
 * tolerable, and the `sites` on the edges are what make it checkable.
 *
 * ### "Then write"
 *
 * Writes are transitive on the same terms, and for the same reason: `swap()`
 * ends `_update(balance0, balance1)`, and the write to `reserve0` is inside
 * `_update`. A rule that only counted `writes` edges on this function would
 * find nothing on `defi/` — or on most real code, since the effects half of
 * checks-effects-interactions is usually a helper.
 *
 * Both sides are byte offsets in the same body (§10 puts a `SourceRef` on every
 * call site and every state access), so the ordering test is a comparison of
 * numbers: the earliest external-reaching call site against any later write —
 * a write edge's own site, or the site of a call that reaches one. No
 * control-flow modelling: a write in a branch that cannot run after the call
 * still counts, which is the conservative direction for a highlighter.
 *
 * Two things this deliberately does not see. A `creates` edge is not counted as
 * leaving the contract — `new Pair()` runs a constructor whose code is in this
 * project and visible as its own node. And an `assembly` `delegatecall` is a
 * flag with no edge and no call site (`Proxy.fallback` in `pathological/`), so
 * there is no offset to order anything against; `flags.hasDelegatecall` is
 * what surfaces that one.
 */

import type { AxiomapGraph } from '../graph/build.js';
import { appliedModifiers } from './access-control.js';
import type { CallSubkind, Reentrancy } from '../graph/schema.js';

/** §13's default `reentrancyGuards`. */
export const DEFAULT_REENTRANCY_GUARDS: readonly string[] = ['nonReentrant'];

/** Subkinds where control leaves this contract outright. */
export const EXTERNAL_CALL_SUBKINDS: ReadonlySet<CallSubkind> = new Set<CallSubkind>([
  'external',
  'delegatecall',
  'lowlevel',
]);

export interface ExternalCallOptions {
  /** §13's `reentrancyGuards`. Replaces the defaults rather than adding. */
  reentrancyGuards?: readonly string[];
}

export type CallClass =
  /** Control leaves this contract at this call site. */
  | 'external'
  /** Stays inside, but the callee reaches an external call. */
  | 'reaches-external'
  /** Stays inside. */
  | 'internal';

export interface FunctionExternalCalls {
  /** External-reaching call sites, by byte offset, sorted. */
  externalSites: number[];
  /** True when any outgoing call is `external` or `reaches-external`. */
  reachesExternalCall: boolean;
  /** State writes, this body's own and those reached through a call, sorted. */
  writeSites: number[];
  reentrancy: Reentrancy;
}

export interface ExternalCallResult {
  /** Per edge id — every `calls` edge in the graph. */
  byEdge: Map<string, CallClass>;
  byFunction: Map<string, FunctionExternalCalls>;
}

/**
 * Close a set of functions backwards over `calls` edges: everything that
 * reaches one of them, to a fixpoint.
 *
 * Only the static target propagates. `possibleTargets` on an interface call fan
 * out from an edge that is already external, and following them from a
 * *non*-external call would attribute an implementation's behaviour to a caller
 * that never reaches it.
 */
function closeOverCallers(
  callers: ReadonlyMap<string, readonly string[]>,
  seeds: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (result.has(current)) continue;
    result.add(current);
    for (const caller of callers.get(current) ?? []) {
      if (!result.has(caller)) queue.push(caller);
    }
  }
  return result;
}

/**
 * The reverse call graph, and the functions that call out of the contract
 * directly — one pass over the edges, because both closures below need them.
 */
function callGraph(graph: AxiomapGraph): {
  callers: Map<string, string[]>;
  direct: Set<string>;
} {
  const callers = new Map<string, string[]>();
  const direct = new Set<string>();
  graph.forEachEdge((_key, edge, source) => {
    if (edge.kind !== 'calls') return;
    if (edge.subkind !== undefined && EXTERNAL_CALL_SUBKINDS.has(edge.subkind)) direct.add(source);
    const list = callers.get(edge.to);
    if (list === undefined) callers.set(edge.to, [source]);
    else list.push(source);
  });
  return { callers, direct };
}

/**
 * Functions that write storage themselves. `flags.writesState` rather than the
 * `writes` edges alone, because a `sstore` in an `assembly` block names no
 * variable to bind and so produces no edge (§10).
 */
function directWriters(graph: AxiomapGraph): Set<string> {
  const writers = new Set<string>();
  graph.forEachNode((_id, node) => {
    if (node.kind === 'Function' && node.flags.writesState) writers.add(node.id);
  });
  return writers;
}

export function classifyExternalCalls(
  graph: AxiomapGraph,
  options: ExternalCallOptions = {},
): ExternalCallResult {
  const guards = new Set(options.reentrancyGuards ?? DEFAULT_REENTRANCY_GUARDS);
  const { callers, direct } = callGraph(graph);
  const reachesExternal = closeOverCallers(callers, direct);
  const reachesWrite = closeOverCallers(callers, directWriters(graph));

  const byEdge = new Map<string, CallClass>();
  const externalSites = new Map<string, number[]>();
  const writeSites = new Map<string, number[]>();

  const push = (into: Map<string, number[]>, id: string, offsets: readonly number[]): void => {
    const sites = into.get(id) ?? [];
    sites.push(...offsets);
    into.set(id, sites);
  };

  graph.forEachEdge((_key, edge, source) => {
    const offsets = edge.sites.map((site) => site.offset);
    if (edge.kind === 'writes') {
      push(writeSites, source, offsets);
      return;
    }
    if (edge.kind !== 'calls') return;

    const isDirect = edge.subkind !== undefined && EXTERNAL_CALL_SUBKINDS.has(edge.subkind);
    const klass: CallClass = isDirect
      ? 'external'
      : reachesExternal.has(edge.to)
        ? 'reaches-external'
        : 'internal';
    byEdge.set(edge.id, klass);

    if (klass !== 'internal') push(externalSites, source, offsets);
    // The call site is where the write happens, from this body's point of view.
    if (reachesWrite.has(edge.to)) push(writeSites, source, offsets);
  });

  const byFunction = new Map<string, FunctionExternalCalls>();
  const ascending = (a: number, b: number): number => a - b;
  graph.forEachNode((_id, node) => {
    if (node.kind !== 'Function') return;

    const calls = (externalSites.get(node.id) ?? []).sort(ascending);
    const writes = (writeSites.get(node.id) ?? []).sort(ascending);
    const earliest = calls[0];
    const externalCallThenWrite =
      earliest !== undefined && writes.some((offset) => offset > earliest);
    const guarded = appliedModifiers(graph, node.id).some((m) => guards.has(m.name));

    byFunction.set(node.id, {
      externalSites: calls,
      reachesExternalCall: calls.length > 0,
      writeSites: writes,
      reentrancy: { externalCallThenWrite, guarded },
    });
  });

  return { byEdge, byFunction };
}
