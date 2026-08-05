import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Directory Axiomap creates inside the repository it is pointed at. */
export const AXIOMAP_DIR = '.axiomap';

/**
 * Contents of `.axiomap/.gitignore` (AXIOMAP.md §5).
 *
 * `graph.json` is derived, large, and a complete map of whatever code was last
 * analysed, so it stays out of git. `review.json` is deliberately absent from
 * this list: shared audit state is meant to be committed.
 *
 * `findings.json` is Phase 6's addition and not in §5's list. It is a
 * projection of the `slither --json` file the user already has, which puts it
 * on the derived side of §5's own distinction — the line is between artifacts
 * this tool computed and audit state a human authored, and an imported finding
 * is the former. Re-running `axiomap import-findings` reproduces it exactly.
 */
export const AXIOMAP_GITIGNORE = `graph.json
cache/
findings.json
*.tmp
`;

export interface EnsureAxiomapDirResult {
  /** Absolute path to the `.axiomap` directory. */
  dir: string;
  /** Absolute path to the managed `.gitignore`. */
  gitignore: string;
  /** True when this call created or rewrote the `.gitignore`. */
  wroteGitignore: boolean;
}

/**
 * Create `<root>/.axiomap/` and ship the safe git default into it.
 *
 * Every user of Axiomap is by definition handling code they may not own, so the
 * ignore file is written on first run rather than left to the user. An existing
 * file whose contents already match is left alone, so the mtime stays stable.
 */
export async function ensureAxiomapDir(root: string): Promise<EnsureAxiomapDirResult> {
  const dir = join(root, AXIOMAP_DIR);
  const gitignore = join(dir, '.gitignore');

  await mkdir(join(dir, 'cache'), { recursive: true });

  const existing = await readFile(gitignore, 'utf8').catch(() => undefined);
  if (existing === AXIOMAP_GITIGNORE) {
    return { dir, gitignore, wroteGitignore: false };
  }

  await writeFile(gitignore, AXIOMAP_GITIGNORE, 'utf8');
  return { dir, gitignore, wroteGitignore: true };
}
