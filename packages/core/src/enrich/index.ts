/**
 * The semantic tier (§4) — everything below `GRAPH (usable)` in the pipeline.
 *
 * §5: **`enrich/` is the only directory allowed to require a compiler.** In
 * practice this directory does not even do that — it reads what a compiler
 * already wrote — but it is the only place that knows a compiler exists, and
 * the rest of the engine reaches it through one optional call that is allowed
 * to return `null`. `test/enrich-stub.test.ts` stubs this module out entirely
 * and asserts every fixture still builds a graph, which is the standing guard
 * on decision #1.
 *
 * ### Stale artifacts are the failure mode that matters
 *
 * Enrichment joins the graph to the AST by byte offset. If the artifact was
 * built from a different revision of a file, every offset in it is wrong, and
 * the damage is not a missing upgrade — it is a confident edge pointing at the
 * wrong function and a click that lands in the wrong place. A half-stale
 * artifact set is also the *normal* state of a working tree: you edit one file
 * and the other forty are still current.
 *
 * So coverage is decided per file, by comparing the compiler's copy of the
 * source to the bytes on disk. A file that does not match byte-for-byte is not
 * enriched, and its edges keep the honest heuristic labels they already had.
 *
 * ### Why not invoke solc
 *
 * §7 offers "or invoke solc directly via `solc-typed-ast`". That library
 * downloads compiler binaries, so adding it to `@axiomap/core` would put
 * `http`/`https` in the production dependency tree and fail §3's CI gate — the
 * zero-network invariant, which is a security property this tool is meant to be
 * able to demonstrate rather than a convention. Reading artifacts the user's own
 * toolchain produced gets the same ASTs with no network surface at all. The
 * deferral is recorded in §16.
 */

import fs from 'node:fs';
import path from 'node:path';

import type {
  ReferenceClass,
  SemanticOverlay,
  StorageSlot,
} from '../graph/semantic.js';
import type { EdgeKind, GraphDiagnostic } from '../graph/schema.js';
import type { DetectedProject } from '../project/detect.js';
import type { NodeId } from '../symbols/ids.js';
import type { SymbolTable } from '../symbols/table.js';
import { discoverBuildInfo, readBuildInfo, type BuildInfo } from './buildinfo.js';
import {
  emptyAstIndex,
  indexDeclarations,
  indexReferences,
  indexStorageLayout,
  referenceKey,
  relationKey,
  type AstIndex,
  type AstRelation,
} from './solc-ast.js';

export { buildInfoDirectories, discoverBuildInfo, readBuildInfo } from './buildinfo.js';
export type { BuildInfo } from './buildinfo.js';

export interface LoadSemanticOverlayOptions {
  project: DetectedProject;
  table: SymbolTable;
  /** Explicit build-info paths; discovery is skipped when given. */
  buildInfo?: readonly string[];
}

export interface SemanticOverlayLoad {
  /**
   * Null when artifacts were found but none of them could be used — stale,
   * unreadable, or compiled without ASTs. The load still comes back so its
   * diagnostics reach the build summary: "there are artifacts here and they are
   * no good" is the one thing a user needs told, and it is exactly what
   * returning nothing would swallow.
   */
  overlay: SemanticOverlay | null;
  diagnostics: GraphDiagnostic[];
  /** Files whose artifacts matched the source on disk. */
  covered: number;
  /** Files an artifact claimed but whose source has changed since. */
  stale: number;
}

/** §10's relations, in solc's vocabulary. */
const RELATION: Partial<Record<EdgeKind, AstRelation>> = {
  inherits: 'inherits',
  overrides: 'base',
  implements: 'base',
  modifiedBy: 'modifiedBy',
};

class BuildInfoOverlay implements SemanticOverlay {
  readonly compilers: readonly string[];
  readonly #index: AstIndex;
  /** Source key as the artifact spells it → project-relative path. */
  readonly #files: Map<string, string>;
  /** The reverse, which is what lookups arrive with. */
  readonly #keys: Map<string, string>;
  readonly #nodes: Map<number, NodeId>;
  readonly #declarations: Map<NodeId, number>;

  constructor(init: {
    compilers: readonly string[];
    index: AstIndex;
    files: Map<string, string>;
    nodes: Map<number, NodeId>;
  }) {
    this.compilers = init.compilers;
    this.#index = init.index;
    this.#files = init.files;
    this.#keys = new Map([...init.files].map(([key, file]) => [file, key]));
    this.#nodes = init.nodes;
    this.#declarations = new Map([...init.nodes].map(([id, node]) => [node, id]));
  }

  covers(file: string): boolean {
    return this.#keys.has(file);
  }

  reference(cls: ReferenceClass, file: string, offset: number): NodeId | null {
    const key = this.#keys.get(file);
    if (key === undefined) return null;
    const declaration = this.#index.references.get(referenceKey(key, offset))?.[cls];
    if (declaration === undefined) return null;
    // A declaration with no node of ours is a local, a struct member, or
    // something in a file the artifact covered and the project does not. There
    // is nothing to point an edge at, so this is "no information", not a
    // correction.
    return this.#nodes.get(declaration) ?? null;
  }

  confirms(kind: EdgeKind, from: NodeId, to: NodeId): boolean {
    const relation = RELATION[kind];
    if (relation === undefined) return false;
    const fromId = this.#declarations.get(from);
    const toId = this.#declarations.get(to);
    if (fromId === undefined || toId === undefined) return false;
    return this.#index.relations.has(relationKey(relation, fromId, toId));
  }

  selector(id: NodeId): string | undefined {
    const declaration = this.#declarations.get(id);
    if (declaration === undefined) return undefined;
    return this.#index.declarations.get(declaration)?.selector;
  }

  storage(id: NodeId): StorageSlot | undefined {
    const declaration = this.#declarations.get(id);
    if (declaration === undefined) return undefined;
    return this.#index.storage.get(declaration);
  }

  /** Source keys that were indexed, for the multi-compiler diagnostics. */
  get sourceKeys(): string[] {
    return [...this.#files.keys()];
  }
}

/**
 * Which project file an artifact's source key refers to, if any.
 *
 * Keys are toolchain-shaped: Foundry writes them project-relative
 * (`src/Pair.sol`), Hardhat writes dependencies as package specifiers
 * (`@openzeppelin/contracts/token/ERC20/ERC20.sol`) that live under
 * `node_modules/`. Candidates are tried in that order and then by suffix, and
 * the answer is only accepted if the bytes match — so a wrong guess cannot
 * survive into the graph.
 */
function candidatesFor(key: string, files: ReadonlySet<string>): string[] {
  const normalised = key.split(path.sep).join('/').replace(/^\.\//, '');
  const candidates = [normalised, `node_modules/${normalised}`];
  const suffix = `/${normalised}`;
  for (const file of files) {
    if (file.endsWith(suffix)) candidates.push(file);
  }
  return candidates;
}

function matchesOnDisk(root: string, file: string, content: string): boolean {
  let onDisk: Buffer;
  try {
    onDisk = fs.readFileSync(path.join(root, file));
  } catch {
    return false;
  }
  // Bytes, not strings: offsets are byte offsets (§10), and a comparison that
  // normalised line endings would accept an artifact whose every offset past
  // the first newline is wrong.
  return onDisk.equals(Buffer.from(content, 'utf8'));
}

/**
 * Load the semantic tier, or return `null` when there is nothing to load.
 *
 * `null` is the ordinary case, not an error: no artifacts, artifacts for a
 * different revision, or a project that does not compile at all. §7: **must
 * degrade silently to zero when nothing compiles.**
 */
export function loadSemanticOverlay(
  options: LoadSemanticOverlayOptions,
): SemanticOverlayLoad | null {
  const { project, table } = options;
  const diagnostics: GraphDiagnostic[] = [];

  const files = options.buildInfo ?? discoverBuildInfo(project);
  if (files.length === 0) return null;

  const projectFiles = new Set(table.files.keys());

  /** Project file → the artifact that owns it. Later files win; see `discoverBuildInfo`. */
  const owner = new Map<string, { info: BuildInfo; key: string }>();
  let stale = 0;

  for (const file of files) {
    const read = readBuildInfo(file);
    if ('error' in read) {
      diagnostics.push({
        severity: 'warning',
        message: `Ignoring build-info ${path.relative(project.root, file)}: ${read.error}`,
      });
      continue;
    }

    const info = read.info;
    for (const [key, content] of info.contents) {
      if (!info.asts.has(key)) continue;
      const match = candidatesFor(key, projectFiles).find(
        (candidate) => projectFiles.has(candidate) && matchesOnDisk(project.root, candidate, content),
      );
      if (match === undefined) {
        if (candidatesFor(key, projectFiles).some((candidate) => projectFiles.has(candidate))) {
          stale++;
        }
        continue;
      }
      owner.set(match, { info, key });
    }
  }

  if (owner.size === 0) {
    if (stale > 0) {
      diagnostics.push({
        severity: 'warning',
        message:
          `Found build artifacts, but all ${stale} source${stale === 1 ? '' : 's'} they cover ` +
          'have changed since they were compiled. Recompile to enable the semantic tier.',
      });
    }
    return { overlay: null, diagnostics, covered: 0, stale };
  }

  // Declarations first, across every covered file: classifying a reference
  // needs to know whether what it points at is a variable or a function, and
  // that target is regularly in another file.
  const index = emptyAstIndex();
  const sources = new Map<string, string>();
  const compilers = new Set<string>();

  for (const [file, { info, key }] of owner) {
    sources.set(key, file);
    compilers.add(info.solcVersion);
    indexDeclarations(key, info.asts.get(key), index);
  }

  for (const [, { info, key }] of owner) {
    indexReferences(key, info.asts.get(key), index);
    for (const layout of info.storageLayouts.get(key)?.values() ?? []) {
      indexStorageLayout(layout, index);
    }
  }

  // solc declaration ids → our stable node ids, joined on (file, byte offset).
  // Both sides record the declaration's own start, so this is exact; anything
  // that does not join is a declaration we have no node for (a local, a struct
  // member) and is left out rather than guessed at.
  const byPosition = new Map<string, NodeId>();
  for (const symbol of table.symbols.values()) {
    byPosition.set(`${symbol.file} ${symbol.src.offset}`, symbol.id);
  }

  const nodes = new Map<number, NodeId>();
  for (const [declaration, info] of index.declarations) {
    const file = sources.get(info.source);
    if (file === undefined) continue;
    const node = byPosition.get(`${file} ${info.offset}`);
    if (node !== undefined) nodes.set(declaration, node);
  }

  if (stale > 0) {
    diagnostics.push({
      severity: 'warning',
      message:
        `${stale} source file${stale === 1 ? ' has' : 's have'} changed since the build ` +
        'artifacts were written; those files keep heuristic resolution.',
    });
  }

  const compilerList = [...compilers].sort();
  if (compilerList.length > 1) {
    diagnostics.push({
      severity: 'info',
      message: `Build artifacts from ${compilerList.length} solc versions: ${compilerList.join(', ')}.`,
    });
  }

  return {
    overlay: new BuildInfoOverlay({
      compilers: compilerList,
      index,
      files: sources,
      nodes,
    }),
    diagnostics,
    covered: owner.size,
    stale,
  };
}
