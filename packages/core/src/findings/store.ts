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
 * It is persisted at all because §11's imported-findings overlay needs a source
 * that does not require re-running Slither every time the graph is opened, and
 * because `import-findings` should mean something after the process exits.
 *
 * Node ids are the join, the same as `review.json`, which means a finding
 * survives a rebuild and goes stale in the same way and for the same reasons.
 */

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { AXIOMAP_DIR } from '../project/axiomap-dir.js';
import { sourceRefSchema } from '../graph/schema.js';

/** Bump on any change a consumer could notice, per §3's reasoning. */
export const FINDINGS_SCHEMA_VERSION = 1;

export const FINDINGS_FILE = 'findings.json';

export const importedFindingSchema = z.object({
  id: z.string(),
  check: z.string(),
  impact: z.string(),
  confidence: z.string(),
  description: z.string(),
  nodes: z.array(z.string()),
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

/** An absent file is no findings, not an error — nobody has imported any. */
export function readFindings(target: string): FindingsFile | null {
  if (!fs.existsSync(target)) return null;
  return parseFindings(fs.readFileSync(target, 'utf8'), target);
}
