import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<repo>/fixtures`, from `packages/core/test`. */
export const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures',
);

export function fixture(name: string): string {
  return path.join(FIXTURE_ROOT, name);
}

/**
 * The parser backend under test. A one-member list rather than an inlined
 * literal: Phase 1's bake-off ran every parser test against both candidates by
 * construction, and keeping the shape means a future backend (§16 names two)
 * is one entry here rather than a rewrite of every suite.
 */
export const BACKENDS = ['treesitter'] as const;

export const PARSER: (typeof BACKENDS)[number] = 'treesitter';
