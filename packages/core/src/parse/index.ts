import type { ParserId, SolidityParser } from './interface.js';
import { TreeSitterSolidityParser } from './treesitter.js';

export * from './interface.js';
export { PositionIndex, type SourceRef } from './positions.js';
export { TreeSitterSolidityParser } from './treesitter.js';

/**
 * The backend everything else in `core` uses.
 *
 * Phase 1 built two implementations behind `SolidityParser` and benchmarked
 * them; tree-sitter won and `antlr.ts` was deleted, per §5 — "a tolerant parser
 * you are not testing is a liability". `docs/decisions/0001-parser.md` records
 * the numbers and the reasoning.
 *
 * The seam stays. `ParserId` is a one-member union rather than a removed
 * concept because §16 already names two candidate replacements (Solar when it
 * ships JS bindings; `web-tree-sitter` for packaging), and because
 * `ParseCache` keys on it — entries written by one backend must never be read
 * by another.
 */
export const DEFAULT_PARSER_ID: ParserId = 'treesitter';

export function createParser(id: ParserId = DEFAULT_PARSER_ID): SolidityParser {
  switch (id) {
    case 'treesitter':
      return new TreeSitterSolidityParser();
  }
}
