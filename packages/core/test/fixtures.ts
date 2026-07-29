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

/** Both backends, so every parser test runs twice by construction. */
export const BACKENDS = ['antlr', 'treesitter'] as const;
