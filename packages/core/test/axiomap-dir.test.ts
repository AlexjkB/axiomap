import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AXIOMAP_GITIGNORE, ensureAxiomapDir } from '../src/index.js';

describe('ensureAxiomapDir', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'axiomap-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes .axiomap/.gitignore on first run', async () => {
    const result = await ensureAxiomapDir(root);

    expect(result.wroteGitignore).toBe(true);
    await expect(readFile(result.gitignore, 'utf8')).resolves.toBe(AXIOMAP_GITIGNORE);
  });

  it('ignores derived artifacts but not review.json', () => {
    const lines = AXIOMAP_GITIGNORE.trim().split('\n');

    expect(lines).toContain('graph.json');
    expect(lines).toContain('cache/');
    // Phase 6's addition. A projection of the user's own Slither run is on the
    // derived side of §5's line: this tool computed it, and re-running
    // `axiomap import-findings` reproduces it exactly.
    expect(lines).toContain('findings.json');
    // …and the one file that is not derived stays tracked.
    expect(lines).not.toContain('review.json');
  });

  it('is idempotent', async () => {
    await ensureAxiomapDir(root);
    const second = await ensureAxiomapDir(root);

    expect(second.wroteGitignore).toBe(false);
  });

  it('repairs a modified .gitignore', async () => {
    const { gitignore } = await ensureAxiomapDir(root);
    await writeFile(gitignore, 'graph.json\n', 'utf8');

    const repaired = await ensureAxiomapDir(root);

    expect(repaired.wroteGitignore).toBe(true);
    await expect(readFile(gitignore, 'utf8')).resolves.toBe(AXIOMAP_GITIGNORE);
  });
});
