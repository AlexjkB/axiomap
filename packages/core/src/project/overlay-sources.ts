/**
 * §11's two file-backed overlays, read off disk.
 *
 * Review state (§8) and imported findings (decision #4) are the only overlay
 * inputs that are not in the graph, and every host that draws overlays has to
 * read them: `axiomap serve` did in Phase 7c, and Phase 8's extension does now.
 * The reading is three lines; the *policy* is the part worth having once.
 *
 * **A malformed file is a warning and an absent overlay, not a dead host.** The
 * graph is what the user asked for, and refusing to show it because somebody
 * hand-edited `review.json` into invalid JSON would lose them the tool over a
 * file the tool can rewrite. The warning still surfaces, so nothing is silent.
 *
 * Absent and empty stay distinguishable — `null` versus a file with no entries.
 * "Nobody has reviewed anything" and "everything is unreviewed" are the same
 * picture and different sentences, and §4's rule about saying what was found
 * applies to the overlays as much as to the graph.
 */

import fs from 'node:fs';

import { findingsPath, readFindings, type FindingsFile } from '../findings/store.js';
import type { ReviewState } from '../review/state.js';
import { readReview, reviewPath } from '../review/store.js';

export interface OverlayFiles {
  /** `.axiomap/review.json`, or null when the file is not there. */
  review: ReviewState | null;
  /** `.axiomap/findings.json`, or null when the file is not there. */
  findings: FindingsFile | null;
  /** One sentence per file that exists and could not be read. */
  warnings: string[];
}

export function readOverlayFiles(root: string): OverlayFiles {
  const warnings: string[] = [];

  let review: ReviewState | null = null;
  try {
    const file = reviewPath(root);
    review = fs.existsSync(file) ? readReview(file) : null;
  } catch (error) {
    warnings.push(
      `Review state not loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let findings: FindingsFile | null = null;
  try {
    findings = readFindings(findingsPath(root));
  } catch (error) {
    warnings.push(
      `Imported findings not loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { review, findings, warnings };
}
