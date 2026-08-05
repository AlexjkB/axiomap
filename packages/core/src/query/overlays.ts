/**
 * The two overlays whose data is not in the graph (§11).
 *
 * Six of §11's eight overlays read attributes the graph already carries —
 * `externallyReachable`, `accessControl`, `reentrancy`, `flags`,
 * `metrics.cyclomatic`, and every edge's `resolution`. The other two,
 * **review state** and **imported findings**, live in files the host reads:
 * `.axiomap/review.json` (§8, committed) and `.axiomap/findings.json`
 * (derived from a Slither run the user did themselves, decision #4).
 *
 * So this is the projection of those two files onto node ids, and nothing more.
 * It is in `query/` rather than in the webview for the reason every other query
 * is (§5: "the API both CLI and webview consume"), and because the staleness
 * rule that decides what an entry is *worth* is already written twice in this
 * package — `stalenessOf` and `findingStaleness` — and must not acquire a third
 * implementation in a renderer.
 *
 * ### Why this may leave the host at all, given §9 rule 1
 *
 * Rule 1 is that the webview never receives the graph. This is not the graph:
 * it is one small map per audit-state file, keyed by ids, with no source, no
 * bodies, no edges and no attributes. A project with no reviews and no findings
 * sends two empty objects. The alternative — asking per drawn node — would put
 * a round trip behind every repaint to answer a question whose entire input is
 * a file a human wrote by hand.
 *
 * ### Staleness is carried, never flattened away
 *
 * §8 makes review invalidation the flagship feature, and a badge that says
 * `reviewed` on a body that has changed since the review is the exact failure
 * it exists to prevent. `staleness` therefore travels beside `status` rather
 * than being folded into it, so the renderer shows both what was claimed and
 * whether the claim still stands.
 */

import type { AxiomapGraph } from '../graph/build.js';
import type { FindingsFile, FindingStaleness } from '../findings/store.js';
import { findingStaleness } from '../findings/store.js';
import type { ReviewStaleness, ReviewState, ReviewStatus } from '../review/state.js';
import { stalenessOf } from '../review/state.js';

/** One node's review state, as §11's fill channel needs it. */
export interface OverlayReview {
  status: ReviewStatus;
  staleness: ReviewStaleness;
  /** ISO 8601, from the entry. */
  at: string;
  reviewer?: string;
  note?: string;
}

/** One finding on one node. Slither's words are kept verbatim — they are its claim. */
export interface OverlayFinding {
  id: string;
  check: string;
  impact: string;
  confidence: string;
  description: string;
  staleness: FindingStaleness;
}

export interface OverlaySummary {
  reviewed: number;
  flagged: number;
  followUp: number;
  ignored: number;
  /** Entries whose node is still there and whose body has changed (§8). */
  stale: number;
  /** Entries naming a node this graph does not have. */
  orphaned: number;
  findings: number;
  findingsStale: number;
}

export interface OverlayData {
  /** Node id → review state. Only ids somebody has reviewed appear. */
  review: Record<string, OverlayReview>;
  /** Node id → findings landing on it, worst impact first. */
  findings: Record<string, OverlayFinding[]>;
  summary: OverlaySummary;
  /** Whether each file was present at all — an empty overlay and a missing one differ. */
  sources: { review: boolean; findings: boolean };
}

export interface OverlaySources {
  /** `.axiomap/review.json`, already parsed. Null when the file is absent. */
  review?: ReviewState | null;
  /** `.axiomap/findings.json`, already parsed. Null when the file is absent. */
  findings?: FindingsFile | null;
}

/**
 * Slither's impact words, ordered. Unknown words sort last rather than being
 * dropped: a detector suite that grows a new severity should still draw.
 */
const IMPACT_ORDER: Record<string, number> = {
  High: 0,
  Medium: 1,
  Low: 2,
  Informational: 3,
  Optimization: 4,
};

const UNKNOWN_IMPACT = 5;

export function impactRank(impact: string): number {
  return IMPACT_ORDER[impact] ?? UNKNOWN_IMPACT;
}

export function overlayData(graph: AxiomapGraph, sources: OverlaySources = {}): OverlayData {
  const review: Record<string, OverlayReview> = {};
  const findings: Record<string, OverlayFinding[]> = {};
  const summary: OverlaySummary = {
    reviewed: 0,
    flagged: 0,
    followUp: 0,
    ignored: 0,
    stale: 0,
    orphaned: 0,
    findings: 0,
    findingsStale: 0,
  };

  const reviewState = sources.review ?? null;
  if (reviewState !== null) {
    for (const report of stalenessOf(reviewState, graph)) {
      if (report.entry.status === 'reviewed') summary.reviewed += 1;
      else if (report.entry.status === 'flagged') summary.flagged += 1;
      else if (report.entry.status === 'follow-up') summary.followUp += 1;
      else summary.ignored += 1;

      if (report.staleness === 'stale') summary.stale += 1;
      if (report.staleness === 'orphaned') {
        // Nothing to paint: the node is gone. Counted so the UI can say so
        // rather than quietly showing fewer badges than the file has entries.
        summary.orphaned += 1;
        continue;
      }

      review[report.node] = {
        status: report.entry.status,
        staleness: report.staleness,
        at: report.entry.at,
        ...(report.entry.reviewer === undefined ? {} : { reviewer: report.entry.reviewer }),
        ...(report.entry.note === undefined ? {} : { note: report.entry.note }),
      };
    }
  }

  const findingsFile = sources.findings ?? null;
  if (findingsFile !== null) {
    for (const report of findingStaleness(findingsFile, graph)) {
      summary.findings += 1;
      if (report.staleness === 'stale') summary.findingsStale += 1;
      if (report.staleness === 'orphaned') continue;

      for (const node of report.finding.nodes) {
        if (!graph.hasNode(node.id)) continue;
        const entry: OverlayFinding = {
          id: report.finding.id,
          check: report.finding.check,
          impact: report.finding.impact,
          confidence: report.finding.confidence,
          description: report.finding.description,
          // Per node, not per finding: a finding spanning a caller and a callee
          // is stale *on the body that changed*, and painting the other one
          // stale too would send an auditor to re-read code nobody touched.
          staleness: report.missing.includes(node.id)
            ? 'orphaned'
            : report.changed.includes(node.id)
              ? 'stale'
              : 'current',
        };
        const list = findings[node.id];
        if (list === undefined) findings[node.id] = [entry];
        else list.push(entry);
      }
    }

    for (const list of Object.values(findings)) {
      list.sort(
        (a, b) => impactRank(a.impact) - impactRank(b.impact) || a.id.localeCompare(b.id),
      );
    }
  }

  return {
    review,
    findings,
    summary,
    sources: { review: reviewState !== null, findings: findingsFile !== null },
  };
}
