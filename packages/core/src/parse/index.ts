import { AntlrSolidityParser } from './antlr.js';
import type { ParserId, SolidityParser } from './interface.js';
import { TreeSitterSolidityParser } from './treesitter.js';

export * from './interface.js';
export { PositionIndex, type SourceRef } from './positions.js';
export { AntlrSolidityParser } from './antlr.js';
export { TreeSitterSolidityParser } from './treesitter.js';

/**
 * The backend everything else in `core` uses.
 *
 * Phase 1 ships both and benchmarks them; once the bake-off is settled this
 * collapses to a single constructor and the loser's file is deleted (§5).
 * Until then, nothing outside `parse/` names a backend directly — that is the
 * point of the seam.
 */
export const DEFAULT_PARSER_ID: ParserId = 'antlr';

export function createParser(id: ParserId = DEFAULT_PARSER_ID): SolidityParser {
  switch (id) {
    case 'antlr':
      return new AntlrSolidityParser();
    case 'treesitter':
      return new TreeSitterSolidityParser();
  }
}
