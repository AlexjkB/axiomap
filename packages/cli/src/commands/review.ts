/**
 * `axiomap review <node> --status reviewed|flagged|follow-up` (§12).
 *
 * §8's review state is "designed to be committed and shared across an audit
 * team", and review invalidation is what §8 calls the flagship feature. This
 * command is the only way a human puts something into that file, so the thing
 * it has to get right is the `bodyHash`: the whole mechanism is that a review
 * records the hash of the body that was read, and goes stale the moment the
 * body differs.
 *
 * Which means the graph has to be current when a review is recorded. Recording
 * against a stale artifact would store the hash of a body the reviewer did not
 * read, and the review would then look current forever — a false *negative* on
 * the re-review list, which is the one direction this feature must not fail in.
 * `context.ts` handles that by rebuilding when a source is newer than the
 * artifact; this command is a reason that default is worth its cost.
 */

import {
  readReview,
  requireNode,
  reviewPath,
  setReviewStatus,
  stalenessOf,
  writeReview,
  type ReviewEntry,
  type ReviewStatus,
} from '@axiomap/core';

import { loadGraph, openProject, type CommonOptions } from '../context.js';
import { colour, count, definitions, heading, json, table } from '../output.js';

export const REVIEW_STATUSES: readonly ReviewStatus[] = [
  'reviewed',
  'flagged',
  'follow-up',
  'ignored',
];

export interface ReviewOptions extends CommonOptions {
  status?: string;
  reviewer?: string;
  note?: string;
  /** Remove the entry instead of setting one. */
  clear?: boolean;
  /** List the whole review state. */
  list?: boolean;
}

export interface ReviewResult {
  text: string;
  exitCode: number;
}

export async function runReview(
  ref: string | undefined,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const context = openProject(options);
  const file = reviewPath(context.root);
  const state = readReview(file);

  if (options.list === true || ref === undefined) {
    const loaded = await loadGraph(context, options);
    const reports = stalenessOf(state, loaded.graph);
    if (options.json === true) return { text: json({ file, reviews: reports }), exitCode: 0 };
    if (reports.length === 0) {
      return {
        text: colour.dim('No review state yet. Record one with:\n  axiomap review <node> --status reviewed\n'),
        exitCode: 0,
      };
    }
    return {
      text:
        heading(count(reports.length, 'review')) +
        table(reports, [
          { header: 'status', get: (row) => row.entry.status },
          {
            header: 'state',
            get: (row) => row.staleness,
            paint: (value, row) =>
              row.staleness === 'current'
                ? colour.green(value)
                : row.staleness === 'stale'
                  ? colour.yellow(value)
                  : colour.red(value),
          },
          { header: 'node', get: (row) => row.node },
          { header: 'reviewer', get: (row) => row.entry.reviewer ?? '' },
          { header: 'at', get: (row) => row.entry.at },
          { header: 'note', get: (row) => row.entry.note ?? '' },
        ]),
      exitCode: 0,
    };
  }

  const loaded = await loadGraph(context, options);
  const node = requireNode(loaded.graph, ref);

  if (options.clear === true) {
    if (state[node.id] === undefined) {
      return { text: colour.dim(`No review recorded for ${node.id}.\n`), exitCode: 0 };
    }
    const next = { ...state };
    delete next[node.id];
    writeReview(file, next);
    return { text: `Cleared review for ${node.id}.\n`, exitCode: 0 };
  }

  const status = options.status;
  if (status === undefined) {
    throw new Error(
      `axiomap review needs --status <${REVIEW_STATUSES.join('|')}> (or --clear, or --list).`,
    );
  }
  if (!REVIEW_STATUSES.includes(status as ReviewStatus)) {
    throw new Error(
      `"${status}" is not a review status. Use one of: ${REVIEW_STATUSES.join(', ')}.`,
    );
  }

  // §8 keys review state by node id and stores the body hash at review time.
  // A node with no body — an interface declaration — hashes to the empty string
  // by Phase 2's deliberate choice, so it can be reviewed but can never go
  // stale. That is correct: there is no body to change.
  const bodyHash = node.kind === 'Function' ? node.bodyHash : '';

  const entry: ReviewEntry = {
    status: status as ReviewStatus,
    bodyHash,
    ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    ...(options.note === undefined ? {} : { note: options.note }),
    at: new Date().toISOString(),
  };

  writeReview(file, setReviewStatus(state, node.id, entry));

  if (options.json === true) {
    return { text: json({ file, node: node.id, entry }), exitCode: 0 };
  }

  return {
    text:
      definitions([
        ['node', node.id],
        ['status', entry.status],
        ['bodyHash', bodyHash === '' ? colour.dim('none (no body — cannot go stale)') : bodyHash],
        ['reviewer', entry.reviewer ?? colour.dim('unset')],
        ['note', entry.note ?? colour.dim('unset')],
        ['file', file],
      ]) +
      colour.dim('\nreview.json is meant to be committed and shared (AXIOMAP.md §5).\n'),
    exitCode: 0,
  };
}
