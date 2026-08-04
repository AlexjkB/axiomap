/**
 * `.axiomap/review.json` on disk.
 *
 * Separate from `state.ts` so every operation on review state stays a pure
 * function over a plain object, and only this file touches `fs` (§6).
 *
 * Written sorted, two-space indented, with a trailing newline. It is a
 * committed file that several auditors edit through the tool at once, and a
 * deterministic layout is what makes a git merge conflict in it a two-line
 * conflict rather than a whole-file one.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AXIOMAP_DIR } from '../project/axiomap-dir.js';
import { parseReview, type ReviewEntry, type ReviewState } from './state.js';

export const REVIEW_FILE = 'review.json';

/** `<root>/.axiomap/review.json`. */
export function reviewPath(root: string): string {
  return path.join(root, AXIOMAP_DIR, REVIEW_FILE);
}

/** An absent file is an empty review, not an error — nobody has reviewed yet. */
export function readReview(file: string): ReviewState {
  if (!fs.existsSync(file)) return {};
  return parseReview(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, file);
}

export function serializeReview(state: ReviewState): string {
  const out: Record<string, ReviewEntry> = {};
  for (const id of Object.keys(state).sort()) {
    const entry = state[id];
    if (entry === undefined) continue;
    // Fixed key order for the same reason `graph.json` has one: a file whose
    // byte layout depends on insertion order produces diffs nobody reads.
    out[id] = {
      status: entry.status,
      bodyHash: entry.bodyHash,
      ...(entry.reviewer === undefined ? {} : { reviewer: entry.reviewer }),
      ...(entry.note === undefined ? {} : { note: entry.note }),
      at: entry.at,
    };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function writeReview(file: string, state: ReviewState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeReview(state));
}
