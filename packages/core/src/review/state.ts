/**
 * Review state (§8) — `.axiomap/review.json`, keyed by stable node id.
 *
 * This is the one file Axiomap writes into a user's repo that is **meant to be
 * committed** (§5). It is shared across an audit team, merged by git, and read
 * by humans, so its shape is §8's verbatim: a flat map from node id to an
 * entry. No wrapper object, no envelope, no version field.
 *
 * The missing version field is deliberate rather than an oversight. Every
 * stored `bodyHash` is a hash of a string that begins with `b${HASH_VERSION}`,
 * so bumping the hashing rules changes every hash in the project and every
 * review reads as stale — which is exactly what a hashing change means. A
 * separate version field would be a second source of truth for the same fact.
 *
 * ### Review invalidation is the flagship feature (§8)
 *
 * `stalenessOf` is the whole of it: a review is current while the node's
 * `bodyHash` still matches the one recorded when it was reviewed, and stale the
 * moment it does not. Combined with the matcher, `migrateReview` carries a
 * review across a rename or a move — the same code in a new place has not been
 * un-reviewed — while still marking it stale if the body changed on the way.
 */

import { z } from 'zod';

import type { AxiomapGraph } from '../graph/build.js';
import type { NodeMatching } from '../diff/match.js';

export const reviewStatusSchema = z.enum(['reviewed', 'flagged', 'follow-up', 'ignored']);

export const reviewEntrySchema = z.object({
  status: reviewStatusSchema,
  /** The node's `bodyHash` at the moment it was reviewed. */
  bodyHash: z.string(),
  reviewer: z.string().optional(),
  note: z.string().optional(),
  /** ISO 8601. */
  at: z.string(),
});

export const reviewStateSchema = z.record(z.string(), reviewEntrySchema);

export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type ReviewEntry = z.infer<typeof reviewEntrySchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;

export class ReviewSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewSchemaError';
  }
}

export function parseReview(value: unknown, source = '<memory>'): ReviewState {
  const result = reviewStateSchema.safeParse(value);
  if (!result.success) {
    const [issue] = result.error.issues;
    const where = issue === undefined ? '' : ` at ${issue.path.join('.') || '<root>'}`;
    throw new ReviewSchemaError(
      `${source} is not valid review state${where}: ${issue?.message ?? 'unknown error'}. ` +
        'Expected a JSON object mapping node ids to { status, bodyHash, at }.',
    );
  }
  return result.data;
}

/**
 * What a stored review is worth against the graph in front of you.
 *
 * - `current` — the node is there and its body is the reviewed body.
 * - `stale` — the node is there and its body has changed. §8: it renders as
 *   `needs-re-review`, and this is the flagship feature.
 * - `orphaned` — nothing in the graph has this id any more. A diff can often
 *   say where it went; on its own, this file cannot, and saying "unchanged"
 *   would be a lie in the dangerous direction.
 */
export type ReviewStaleness = 'current' | 'stale' | 'orphaned';

export interface ReviewStatusReport {
  node: string;
  entry: ReviewEntry;
  staleness: ReviewStaleness;
  /** The node's hash now, absent when the node is gone. */
  currentBodyHash?: string;
}

export function stalenessOf(state: ReviewState, graph: AxiomapGraph): ReviewStatusReport[] {
  const out: ReviewStatusReport[] = [];
  for (const node of Object.keys(state).sort()) {
    const entry = state[node];
    if (entry === undefined) continue;
    if (!graph.hasNode(node)) {
      out.push({ node, entry, staleness: 'orphaned' });
      continue;
    }
    const attributes = graph.getNodeAttributes(node);
    const bodyHash = attributes.kind === 'Function' ? attributes.bodyHash : '';
    out.push({
      node,
      entry,
      staleness: bodyHash === entry.bodyHash ? 'current' : 'stale',
      currentBodyHash: bodyHash,
    });
  }
  return out;
}

export interface ReviewMigration {
  state: ReviewState;
  /** Ids that moved, `from` → `to`. */
  remapped: { from: string; to: string; confidence: number }[];
  /** Ids with no counterpart in the after graph. Their entries are kept. */
  dropped: string[];
}

/**
 * Carry review state from the before revision onto the after revision.
 *
 * A renamed or moved function has not been un-reviewed, and forcing a reviewer
 * to re-read a body that is byte-identical in a new place is the kind of noise
 * that gets a feature turned off. So matched ids are remapped and the stored
 * `bodyHash` is left alone — which means a node that moved *and* changed comes
 * out remapped and stale, and is on the re-review list for the right reason.
 *
 * An entry with no counterpart is **kept under its old id**, not deleted. This
 * function does not own the user's file; a match the matcher could not make is
 * not proof the code is gone, and silently discarding somebody's audit notes is
 * not a thing to do on a heuristic.
 */
export function migrateReview(state: ReviewState, matching: NodeMatching): ReviewMigration {
  const out: ReviewState = {};
  const remapped: ReviewMigration['remapped'] = [];
  const dropped: string[] = [];

  for (const id of Object.keys(state).sort()) {
    const entry = state[id];
    if (entry === undefined) continue;
    const match = matching.byBefore.get(id);
    if (match === undefined) {
      out[id] = entry;
      dropped.push(id);
      continue;
    }
    out[match.after] = entry;
    if (match.after !== id) {
      remapped.push({ from: id, to: match.after, confidence: match.confidence });
    }
  }
  return { state: out, remapped, dropped };
}

/** Set one node's review status. Pure — the input state is not touched. */
export function setReviewStatus(
  state: ReviewState,
  node: string,
  entry: ReviewEntry,
): ReviewState {
  return { ...state, [node]: entry };
}
