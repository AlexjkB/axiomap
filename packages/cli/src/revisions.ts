/**
 * Materialising a git revision so it can be graphed (§12's `axiomap diff <refA>
 * <refB>` — "git revs or two paths").
 *
 * This lives in `cli/` rather than `core/` on purpose: §6 keeps `@axiomap/core`
 * to `fs` and nothing else, and checking out a revision means spawning `git`.
 * The engine takes two graphs; where the second one came from is this file's
 * problem.
 *
 * `git worktree add --detach` rather than `git archive | tar`: it is one
 * command, it needs no external tar, and it gives a real checkout so project
 * detection, remappings and imports all behave exactly as they do on a working
 * tree. The worktree is removed afterwards, including when the caller throws.
 *
 * Decision #1 pays for itself here. Diffing two revisions normally means
 * compiling both, which for a historical commit is usually impossible; a
 * compilation-free analysis can graph any checkout. The cost is that the older
 * revision has no build artifacts, so it is graphed at the syntactic tier while
 * the working tree may be at the semantic one — which the diff engine ignores
 * by construction (`diff/classify.ts`).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class RevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionError';
  }
}

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : String(error);
    throw new RevisionError(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`);
  }
}

export interface Revision {
  /** The directory to graph. */
  root: string;
  /** How it was named on the command line. */
  label: string;
  /** Cleanup. Always call it; a no-op for a plain path. */
  dispose: () => void;
}

/**
 * Resolve one side of a diff.
 *
 * An existing directory is used as it stands — that is §12's "or two paths",
 * and it is also how you diff a working tree against a tag. Anything else is
 * treated as a git revision and checked out.
 */
export function resolveRevision(ref: string, target: string): Revision {
  const asPath = path.resolve(ref);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
    return { root: asPath, label: ref, dispose: () => {} };
  }

  const repo = git(target, ['rev-parse', '--show-toplevel']).trim();
  const commit = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const relative = path.relative(repo, path.resolve(target));
  if (relative.startsWith('..')) {
    throw new RevisionError(
      `${target} is not inside the git repository at ${repo}, so "${ref}" cannot be resolved ` +
        'against it. Pass two directory paths instead.',
    );
  }

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-diff-'));
  git(repo, ['worktree', 'add', '--detach', '--quiet', worktree, commit]);

  const root = path.join(worktree, relative);
  if (!fs.existsSync(root)) {
    git(repo, ['worktree', 'remove', '--force', worktree]);
    throw new RevisionError(
      `"${relative}" does not exist at ${ref} (${commit.slice(0, 12)}). ` +
        'Check the path, or pick a revision where it is present.',
    );
  }

  return {
    root,
    label: `${ref} (${commit.slice(0, 12)})`,
    dispose: () => {
      git(repo, ['worktree', 'remove', '--force', worktree]);
    },
  };
}
