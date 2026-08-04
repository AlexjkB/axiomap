/**
 * The audit-relevant findings §8 calls "the actual product" — the raw node diff
 * above it is plumbing.
 *
 * Seven kinds, one per bullet in §8's list. Each is a comparison over two
 * graphs the analysis passes have already run on, never a re-analysis: Phase 4
 * put `externallyReachable`, `accessControl` and the flags on the nodes, and
 * recomputing any of them here would give a second answer that can disagree
 * with the first.
 *
 * ### `direct` versus `consequence`
 *
 * Three of §10's Function fields are transitive. Edit one leaf helper and
 * `externallyReachable` flips on every caller above it — so a finding derived
 * from one of those fields may land on a function whose own source is
 * untouched. Reporting those the same way as a real edit would fill the
 * re-review list with noise, and that list is the product.
 *
 * So every finding says which it is: `direct` when the node it names changed
 * itself, `consequence` when the node is unchanged and something it depends on
 * moved. Both are reported — "this function is now reachable from outside and
 * you did not touch it" is exactly the sentence an upgrade audit wants — but a
 * caller can rank, filter or fold them independently.
 */

import type { FunctionNode, GraphNode } from '../graph/schema.js';
import type { GraphDiff, NodeChange } from './classify.js';

export type FindingKind =
  | 'new-external-entrypoint'
  | 'access-control-weakened'
  | 'new-external-call'
  | 'became-payable'
  | 'storage-layout-changed'
  | 'became-externally-reachable'
  | 'new-dangerous-op';

export type FindingSeverity = 'high' | 'medium' | 'info';

export interface DiffFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  /** The node this is about, in after-space where it still exists. */
  node: string;
  message: string;
  /** `direct` when the node itself changed; `consequence` when it did not. */
  evidence: 'direct' | 'consequence';
}

const SEVERITY: Record<FindingKind, FindingSeverity> = {
  'access-control-weakened': 'high',
  'storage-layout-changed': 'high',
  'new-dangerous-op': 'high',
  'new-external-entrypoint': 'medium',
  'became-payable': 'medium',
  'became-externally-reachable': 'medium',
  'new-external-call': 'info',
};

const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, info: 2 };

/** §11's three levels as an order, so "weakened" is a comparison. */
const CONFIDENCE_RANK = { high: 2, low: 1, none: 0 } as const;

/**
 * The dangerous operations §8 names, plus the two that reach the same sinks.
 * `sendsValue` and `hasCreate` are in because a function that did not move
 * value and now does is the same class of change as one that did not use
 * `delegatecall` and now does.
 */
const DANGEROUS = [
  'hasAssembly',
  'hasDelegatecall',
  'hasLowLevelCall',
  'hasSelfdestruct',
  'hasCreate',
  'sendsValue',
] as const;

const EXTERNAL_CALL_SUBKINDS = new Set(['external', 'delegatecall', 'lowlevel']);

function isFunction(node: GraphNode | null): node is FunctionNode {
  return node !== null && node.kind === 'Function';
}

/**
 * `Contract.member` — enough to tell two same-named functions apart in one
 * line of output without printing a full id.
 *
 * `Factory.createPair` and `IFactory.createPair` both became payable in the
 * `defi/` fixture pair, and a message that said only `createPair` printed the
 * same sentence twice.
 */
function qualify(node: GraphNode): string {
  if (node.scope === null) return node.name;
  return `${node.scope.split(':').pop() ?? node.scope}.${node.name}`;
}

/** An entrypoint reports itself in its own `entrypoints` set (Phase 4). */
function isEntrypoint(node: FunctionNode): boolean {
  return node.entrypoints.includes(node.id);
}

function evidenceOf(change: NodeChange): 'direct' | 'consequence' {
  return change.status === 'unchanged' ? 'consequence' : 'direct';
}

/**
 * Every contract's storage layout: non-constant, non-immutable state variables
 * in declaration order, which is slot order.
 *
 * Declaration order rather than the `slot` field on purpose: slots exist only
 * with build artifacts, and §8's premise is that the old revision usually has
 * none. Constants, immutables and transients are excluded because they do not
 * occupy a slot, so inserting one is not a layout change.
 *
 * Bucketed by scope in one pass rather than filtered per contract. The
 * per-contract form was O(contracts × nodes) and cost **4.5 of the 5.7 seconds**
 * a self-diff of `large/` took — 2,719 contracts against 30,708 nodes is 167
 * million iterations for an answer that is one pass. Invisible on all four
 * correctness fixtures, which is the argument for benchmarking the diff at
 * scale rather than reasoning about it.
 */
function storageOrders(nodes: readonly GraphNode[]): Map<string, string[]> {
  const buckets = new Map<string, Extract<GraphNode, { kind: 'StateVariable' }>[]>();
  for (const node of nodes) {
    if (node.kind !== 'StateVariable' || node.scope === null) continue;
    if (node.isConstant || node.isImmutable || node.isTransient) continue;
    const list = buckets.get(node.scope);
    if (list === undefined) buckets.set(node.scope, [node]);
    else list.push(node);
  }

  const out = new Map<string, string[]>();
  for (const [scope, list] of buckets) {
    out.set(
      scope,
      list.sort((a, b) => a.src.offset - b.src.offset).map((node) => node.name),
    );
  }
  return out;
}

export function deriveFindings(diff: GraphDiff): DiffFinding[] {
  const findings: DiffFinding[] = [];
  const add = (
    kind: FindingKind,
    node: string,
    message: string,
    evidence: 'direct' | 'consequence',
  ): void => {
    findings.push({ kind, severity: SEVERITY[kind], node, message, evidence });
  };

  // External call edges leaving each function, both sides, keyed in
  // before-space by `classify.ts` so a renamed callee is the same callee.
  const externalCallsBefore = new Set<string>();
  const externalCallsAfter = new Set<string>();
  for (const edge of diff.edges) {
    const isExternal = (side: GraphDiff['edges'][number]['before']): boolean =>
      side !== null && side.kind === 'calls' && EXTERNAL_CALL_SUBKINDS.has(side.subkind ?? '');
    if (isExternal(edge.before)) externalCallsBefore.add(edge.from);
    if (isExternal(edge.after)) externalCallsAfter.add(edge.from);
  }

  for (const change of diff.nodes) {
    const evidence = evidenceOf(change);

    // --- added functions ------------------------------------------------
    if (change.status === 'added' && isFunction(change.after)) {
      const node = change.after;
      if (isEntrypoint(node)) {
        add(
          'new-external-entrypoint',
          node.id,
          `New ${node.visibility} entrypoint ${qualify(node)}` +
            (node.accessControl.confidence === 'none' ? ', with no recognised access control' : ''),
          'direct',
        );
      }
      for (const flag of DANGEROUS) {
        if (node.flags[flag]) {
          add('new-dangerous-op', node.id, `New function ${qualify(node)} uses ${flag}`, 'direct');
        }
      }
      continue;
    }
    if (change.before === null || change.after === null) continue;

    // --- matched functions ----------------------------------------------
    if (isFunction(change.before) && isFunction(change.after)) {
      const before = change.before;
      const after = change.after;

      if (before.stateMutability !== 'payable' && after.stateMutability === 'payable') {
        add('became-payable', after.id, `${qualify(after)} became payable`, evidence);
      }

      const mutating = after.stateMutability === 'nonpayable' || after.stateMutability === 'payable';
      const dropped =
        CONFIDENCE_RANK[after.accessControl.confidence] <
        CONFIDENCE_RANK[before.accessControl.confidence];
      if (mutating && dropped) {
        const lost = before.accessControl.modifiers.filter(
          (name) => !after.accessControl.modifiers.includes(name),
        );
        add(
          'access-control-weakened',
          after.id,
          `${qualify(after)} is state-mutating and its access control weakened from ` +
            `${before.accessControl.confidence} to ${after.accessControl.confidence}` +
            (lost.length === 0 ? '' : ` (lost ${lost.join(', ')})`),
          evidence,
        );
      }

      if (!before.externallyReachable && after.externallyReachable) {
        add(
          'became-externally-reachable',
          after.id,
          `${qualify(after)} was not reachable from outside and now is`,
          evidence,
        );
      }

      if (!externalCallsBefore.has(change.match?.before ?? '') && externalCallsAfter.has(change.match?.before ?? '')) {
        add(
          'new-external-call',
          after.id,
          `${qualify(after)} was self-contained and now calls out of its contract`,
          evidence,
        );
      }

      for (const flag of DANGEROUS) {
        if (!before.flags[flag] && after.flags[flag]) {
          add('new-dangerous-op', after.id, `${qualify(after)} now uses ${flag}`, evidence);
        }
      }
    }
  }

  // --- storage layout ---------------------------------------------------
  //
  // Per contract rather than per variable: §8's finding is about the layout,
  // and one inserted variable shifts every slot after it. Reporting each of
  // those as its own finding would say the same thing five times.
  const beforeLayouts = storageOrders(
    diff.nodes.map((c) => c.before).filter((n): n is GraphNode => n !== null),
  );
  const afterLayouts = storageOrders(
    diff.nodes.map((c) => c.after).filter((n): n is GraphNode => n !== null),
  );
  for (const change of diff.nodes) {
    if (change.kind !== 'Contract' || change.before === null || change.after === null) continue;
    const before = beforeLayouts.get(change.before.id) ?? [];
    const after = afterLayouts.get(change.after.id) ?? [];
    if (before.join(',') === after.join(',')) continue;
    add(
      'storage-layout-changed',
      change.after.id,
      `Storage layout of ${change.after.name} changed: [${before.join(', ')}] → [${after.join(', ')}]`,
      'direct',
    );
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.kind.localeCompare(b.kind) ||
      a.node.localeCompare(b.node) ||
      a.message.localeCompare(b.message),
  );
  return findings;
}
