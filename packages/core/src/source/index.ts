/**
 * Reading the user's source, for the one consumer that needs the bytes rather
 * than the graph: §11's inline code preview.
 *
 * Separate from `query/` on purpose — see `slice.ts` for the reasoning. Nothing
 * else in the engine reads a source file after the parse.
 */

export {
  DEFAULT_SLICE_LIMIT,
  sliceNode,
  SourceUnavailableError,
  type SourceSlice,
  type SourceSliceOptions,
} from './slice.js';
