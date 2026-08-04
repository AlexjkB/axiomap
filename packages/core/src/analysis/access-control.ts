/**
 * Which functions are guarded, and how sure we are (§7 Phase 4, §10's
 * `accessControl`, §11's access-control overlay).
 *
 * Three levels, and the middle one is the point:
 *
 * | Level | Evidence |
 * |---|---|
 * | `high` | An applied modifier whose name is in §13's `accessControlModifiers` |
 * | `low`  | An inline `msg.sender`/`tx.origin` comparison, here or in an applied modifier |
 * | `none` | Neither |
 *
 * `none` is a statement about this tool, not about the code: it means *no
 * recognised guard was found*. §13 exists because every protocol spells its
 * guards differently, and the honest failure of a name list is a function that
 * reports `none` and turns out to be guarded by `onlyGovernor` — which is why
 * the inline-comparison evidence gives `low` rather than nothing, and why the
 * list is configuration rather than a constant.
 *
 * The reverse error is the one worth avoiding: an unrecognised modifier that
 * makes no sender comparison — `nonReentrant`, `whenNotPaused` — must not raise
 * the confidence. Those are modifiers and they are not access control.
 *
 * Modifier names come from `modifiedBy` edges rather than from the parse, so an
 * unresolvable modifier still counts by name (its edge points at a synthetic
 * `?not-found:` node carrying it). That keeps the pass a pure function over the
 * graph.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { AccessControl } from '../graph/schema.js';

/** §13's default `accessControlModifiers`, verbatim. */
export const DEFAULT_ACCESS_CONTROL_MODIFIERS: readonly string[] = [
  'onlyOwner',
  'onlyRole',
  'auth',
  'requiresAuth',
  'restricted',
];

export interface AccessControlOptions {
  /** §13's `accessControlModifiers`. Replaces the defaults rather than adding. */
  accessControlModifiers?: readonly string[];
}

export interface AppliedModifier {
  name: string;
  /** The modifier's own body compares against `msg.sender`/`tx.origin`. */
  checksSender: boolean;
}

/** The modifiers applied to a function, resolved or not, in edge order. */
export function appliedModifiers(graph: AxiomapGraph, id: string): AppliedModifier[] {
  const out: AppliedModifier[] = [];
  graph.forEachOutEdge(id, (_key, edge) => {
    if (edge.kind !== 'modifiedBy' || !graph.hasNode(edge.to)) return;
    const target = graph.getNodeAttributes(edge.to);
    out.push({
      name: target.name,
      checksSender: target.kind === 'Function' && target.flags.checksSender,
    });
  });
  return out;
}

export function computeAccessControl(
  graph: AxiomapGraph,
  options: AccessControlOptions = {},
): Map<string, AccessControl> {
  const recognised = new Set(
    options.accessControlModifiers ?? DEFAULT_ACCESS_CONTROL_MODIFIERS,
  );

  const result = new Map<string, AccessControl>();
  graph.forEachNode((_id, node) => {
    if (node.kind !== 'Function') return;

    const guards: string[] = [];
    let confidence: AccessControl['confidence'] = 'none';

    for (const modifier of appliedModifiers(graph, node.id)) {
      if (recognised.has(modifier.name)) {
        if (!guards.includes(modifier.name)) guards.push(modifier.name);
        confidence = 'high';
      } else if (modifier.checksSender) {
        if (!guards.includes(modifier.name)) guards.push(modifier.name);
        if (confidence === 'none') confidence = 'low';
      }
    }

    if (confidence === 'none' && node.flags.checksSender) confidence = 'low';

    guards.sort();
    result.set(node.id, { modifiers: guards, confidence });
  });

  return result;
}
