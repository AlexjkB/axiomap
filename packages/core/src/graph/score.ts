/**
 * The resolution score and the three degradation modes (§4).
 *
 * The score is printed on every build — §4 requires it — but its real job is to
 * *select a mode*. Full, heuristic and structural are designed states with
 * their own UI copy, not error conditions, and the point of the threshold is
 * the sentence that follows it in §4: never let the tool sit in heuristic mode
 * producing a call graph it cannot stand behind.
 *
 * Two scores, deliberately:
 *
 * - `overall` covers every edge that required a name to be resolved, which is
 *   the number §4 prints.
 * - `calls` covers `calls` and `creates` only, and it is the one that selects
 *   the mode. Structural mode drops exactly those edge kinds, so it is the only
 *   score whose value changes what the tool will draw. Inheritance and state
 *   access resolve nearly perfectly (§4: state access is strictly easier), and
 *   folding them into the number that gates the call graph would mask a
 *   resolver that had failed at the hard part.
 *
 * Files outside §4's supported band are excluded from both. A 0.6 file is
 * graphed but it is not evidence about the resolver.
 */

import {
  CALL_EDGE_KINDS,
  STRUCTURAL_EDGE_KINDS,
  type GraphEdge,
  type GraphMode,
  type ResolutionCounts,
  type ResolutionScore,
} from './schema.js';

/**
 * Share of call edges that must be `semantic` or `heuristic` for the call graph
 * to be drawn at all.
 *
 * **Measured, not guessed** (§4). Phase 2 measured all four correctness
 * fixtures with no build artifacts present:
 *
 * | Fixture | call edges | confident | what the rest are |
 * |---|---|---|---|
 * | `minimal/` | 8 | 75% | one `.call{value:}`, one `.delegatecall` |
 * | `inheritance/` | 225 | 88% | OpenZeppelin overloads and `using`-for on expression receivers |
 * | `defi/` | 43 | 98% | one `.call` in `SafeTransfer` |
 * | `pathological/` | 6 | 50% | a function pointer, `encodeWithSelector`, a low-level call |
 *
 * `pathological/` is adversarial by construction and is the only fixture that
 * should fall through to structural mode. 0.70 sits above it and below all
 * three realistic projects.
 *
 * **§16's working assumption of 85% would have been wrong**, and usefully so:
 * it would have put `minimal/` — five hand-written contracts where every call
 * resolves except two deliberately unresolvable low-level ones — into
 * structural mode. The lesson is that the ratio is unstable on small projects,
 * because two honest `unresolved` edges out of eight is 75% while the same two
 * out of two hundred is noise. A small-project floor is the obvious refinement
 * and is deferred to §16 rather than guessed at here.
 */
export const DEFAULT_CALL_RESOLUTION_THRESHOLD = 0.7;

function emptyCounts(): ResolutionCounts {
  return { semantic: 0, heuristic: 0, ambiguous: 0, unresolved: 0, total: 0, confident: 1 };
}

function finish(counts: ResolutionCounts): ResolutionCounts {
  counts.confident =
    counts.total === 0 ? 1 : (counts.semantic + counts.heuristic) / counts.total;
  return counts;
}

export interface ScoreInput {
  edges: readonly GraphEdge[];
  /** Files whose pragma sits outside §4's supported band. */
  excludedFiles: ReadonlySet<string>;
}

export function scoreEdges(input: ScoreInput): ResolutionScore {
  const overall = emptyCounts();
  const calls = emptyCounts();

  for (const edge of input.edges) {
    if (STRUCTURAL_EDGE_KINDS.has(edge.kind)) continue;
    if (input.excludedFiles.has(edge.src.file)) continue;

    // An edge collapsed from N call sites counts N times: a function called
    // from twenty unresolved sites is twenty unresolved sites.
    const weight = edge.count;
    overall[edge.resolution] += weight;
    overall.total += weight;
    if (CALL_EDGE_KINDS.has(edge.kind)) {
      calls[edge.resolution] += weight;
      calls.total += weight;
    }
  }

  return {
    overall: finish(overall),
    calls: finish(calls),
    excludedFiles: input.excludedFiles.size,
  };
}

export interface ModeDecision {
  mode: GraphMode;
  reason: string;
}

/**
 * §4's table, in code. `full` requires artifacts, which is Phase 3 — until then
 * the presence of a single semantic edge is what distinguishes it, and there
 * are none.
 */
export function selectMode(
  score: ResolutionScore,
  threshold = DEFAULT_CALL_RESOLUTION_THRESHOLD,
): ModeDecision {
  const percent = (value: number): string => `${Math.round(value * 100)}%`;

  if (score.overall.semantic > 0) {
    return {
      mode: 'full',
      reason: `Build artifacts were available; ${percent(
        score.overall.semantic / Math.max(1, score.overall.total),
      )} of edges are compiler-certain.`,
    };
  }

  if (score.calls.total === 0) {
    return {
      mode: 'structural',
      reason:
        'No call sites were found, so there is no call graph to draw. Contracts, inheritance, members and state access are complete.',
    };
  }

  if (score.calls.confident >= threshold) {
    return {
      mode: 'heuristic',
      reason: `No build artifacts. ${percent(
        score.calls.confident,
      )} of call edges resolved confidently, at or above the ${percent(
        threshold,
      )} threshold; edges are labelled with their confidence.`,
    };
  }

  return {
    mode: 'structural',
    reason: `No build artifacts, and only ${percent(
      score.calls.confident,
    )} of call edges resolved confidently — below the ${percent(
      threshold,
    )} threshold. The call graph is withheld rather than drawn sparse and misleading. Contracts, inheritance, members and state access are unaffected; build the project to enable call edges.`,
  };
}
