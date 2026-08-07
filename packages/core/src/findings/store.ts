/**
 * `.axiomap/findings.json` — imported findings at rest.
 *
 * §5 lists three things Axiomap writes into a user's repo and this is a fourth,
 * so it is worth saying why it exists and which side of §5's line it falls on.
 * `review.json` is tracked because it is audit state a human authored;
 * `graph.json` and `cache/` are ignored because they are derived. This file is
 * derived — it is a projection of the Slither run the user already has — so it
 * is ignored, and `ensureAxiomapDir` writes it into `.axiomap/.gitignore`.
 *
 * It is persisted at all because a host showing imported findings needs a source
 * that does not require re-running Slither every time the graph is opened, and
 * because `import-findings` should mean something after the process exits.
 *
 * Node ids are the join, the same as `review.json`, and so is the mechanism
 * that keeps a stored finding honest: each mapped node carries the `bodyHash`
 * it had when Slither's result was imported, and `findingStaleness` reports one
 * whose body has since changed. Without that, the inspector would report a
 * High-severity finding on a function rewritten after the scan — which is the
 * failure §8's review invalidation exists to prevent, in a different file.
 */

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { AxiomapGraph } from '../graph/build.js';
import { AXIOMAP_DIR } from '../project/axiomap-dir.js';
import { sourceRefSchema } from '../graph/schema.js';
import type { ImportedFinding } from './slither.js';

/** Bump on any change a consumer could notice, per §3's reasoning. */
export const FINDINGS_SCHEMA_VERSION = 1;

export const FINDINGS_FILE = 'findings.json';

export const findingNodeSchema = z.object({
  id: z.string(),
  /** The node's `bodyHash` when the finding was imported (§8's mechanism). */
  bodyHash: z.string(),
});

export const importedFindingSchema = z.object({
  id: z.string(),
  check: z.string(),
  impact: z.string(),
  confidence: z.string(),
  description: z.string(),
  nodes: z.array(findingNodeSchema),
  locations: z.array(sourceRefSchema),
});

export const findingsFileSchema = z.object({
  schemaVersion: z.literal(FINDINGS_SCHEMA_VERSION),
  source: z.object({
    tool: z.string(),
    /** The file that was imported, as given on the command line. */
    file: z.string(),
    at: z.string(),
  }),
  findings: z.array(importedFindingSchema),
});

export type FindingsFile = z.infer<typeof findingsFileSchema>;

export class FindingsSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindingsSchemaError';
  }
}

/** `<root>/.axiomap/findings.json`. */
export function findingsPath(root: string): string {
  return path.join(root, AXIOMAP_DIR, FINDINGS_FILE);
}

export function serializeFindings(file: FindingsFile): string {
  return `${JSON.stringify(
    {
      schemaVersion: file.schemaVersion,
      source: file.source,
      findings: [...file.findings].sort((a, b) => a.id.localeCompare(b.id)),
    },
    null,
    2,
  )}\n`;
}

export function writeFindings(target: string, file: FindingsFile): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeFindings(file), 'utf8');
}

export function parseFindings(text: string, source = '<memory>'): FindingsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new FindingsSchemaError(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== FINDINGS_SCHEMA_VERSION) {
    throw new FindingsSchemaError(
      `${source} has schemaVersion ${String(version)}, but this build of Axiomap writes ` +
        `${FINDINGS_SCHEMA_VERSION}. Re-run "axiomap import-findings".`,
    );
  }

  const result = findingsFileSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new FindingsSchemaError(
      `${source} does not match the findings schema` +
        (issue === undefined ? '' : ` at ${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}

/**
 * What a stored finding is worth against the graph in front of you.
 *
 * The same three values `review/state.ts` uses, and deliberately so — an
 * auditor should not have to learn two vocabularies for one idea.
 *
 * - `current` — every node it names is there with the body it was found on.
 * - `stale` — a body changed after the scan. Slither's claim may still hold; it
 *   is no longer evidence that it does.
 * - `orphaned` — no node it names is in the graph any more.
 */
export type FindingStaleness = 'current' | 'stale' | 'orphaned';

export interface FindingStatusReport {
  finding: ImportedFinding;
  staleness: FindingStaleness;
  /** Node ids whose body changed since the import. */
  changed: string[];
  /** Node ids that are no longer in the graph. */
  missing: string[];
}

export function findingStaleness(
  file: FindingsFile,
  graph: AxiomapGraph,
): FindingStatusReport[] {
  return file.findings.map((finding) => {
    const changed: string[] = [];
    const missing: string[] = [];

    for (const node of finding.nodes) {
      if (!graph.hasNode(node.id)) {
        missing.push(node.id);
        continue;
      }
      const attributes = graph.getNodeAttributes(node.id);
      const now = attributes.kind === 'Function' ? attributes.bodyHash : '';
      if (now !== node.bodyHash) changed.push(node.id);
    }

    // Orphaned only when *nothing* it named survives: a finding spanning a
    // caller and a callee, one of which was deleted, is still about live code
    // and reporting it as gone would lose it.
    const staleness: FindingStaleness =
      missing.length === finding.nodes.length && finding.nodes.length > 0
        ? 'orphaned'
        : changed.length > 0 || missing.length > 0
          ? 'stale'
          : 'current';

    return { finding, staleness, changed, missing };
  });
}

/** An absent file is no findings, not an error — nobody has imported any. */
export function readFindings(target: string): FindingsFile | null {
  if (!fs.existsSync(target)) return null;
  return parseFindings(fs.readFileSync(target, 'utf8'), target);
}
