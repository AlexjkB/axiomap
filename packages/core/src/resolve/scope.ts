/**
 * Name resolution scaffolding: what a file can see, what a contract inherits,
 * and in what order.
 *
 * Everything here is syntactic. A contract's bases are names that have to be
 * resolved through import scope before the chain can be walked at all, and when
 * that fails the answer is a chain marked `ambiguous` — never a shorter chain
 * presented as complete.
 */

import type { AnySymbol, ContractSymbol, FileSymbols, SymbolTable } from '../symbols/table.js';
import type { NodeId } from '../symbols/ids.js';

export type Certainty = 'certain' | 'ambiguous';

export interface Linearization {
  /** C3 order, most-derived first, including the contract itself. */
  order: NodeId[];
  /**
   * `ambiguous` when a base name did not resolve, resolved to more than one
   * contract, or C3 could not merge. `super` edges downgrade accordingly.
   */
  certainty: Certainty;
}

/**
 * Names visible at file scope, and the inheritance chains of every contract.
 *
 * Built once per project and read constantly, which is why both are eager maps
 * rather than lazy lookups — the resolver asks these questions once per call
 * site.
 */
export class ProjectScope {
  readonly #table: SymbolTable;
  /** file → visible top-level name → candidate declaration ids. */
  readonly #visible = new Map<string, Map<string, NodeId[]>>();
  readonly #linearizations = new Map<NodeId, Linearization>();
  /** contract id → contracts whose chain contains it, most-derived excluded. */
  readonly #derived = new Map<NodeId, NodeId[]>();

  constructor(table: SymbolTable) {
    this.#table = table;
    for (const file of table.files.values()) this.#visible.set(file.file, this.#visibleIn(file));
    for (const symbol of table.symbols.values()) {
      if (symbol.kind === 'contract') this.#linearise(symbol, new Set());
    }
    for (const [id, line] of this.#linearizations) {
      for (const ancestor of line.order) {
        if (ancestor === id) continue;
        const list = this.#derived.get(ancestor);
        if (list === undefined) this.#derived.set(ancestor, [id]);
        else list.push(id);
      }
    }
  }

  get table(): SymbolTable {
    return this.#table;
  }

  // --- file scope -------------------------------------------------------

  /**
   * Import semantics, in the order Solidity applies them:
   *
   * 1. the file's own top-level declarations;
   * 2. `import {X as Y}` and `import * as L` — explicit, already recorded per
   *    file by Phase 1;
   * 3. bare `import "path"`, which pulls in every top-level name of the target.
   *
   * An unresolved import contributes nothing and is not an error here — §4 says
   * dependent edges go `unresolved` and the build continues.
   */
  #visibleIn(file: FileSymbols): Map<string, NodeId[]> {
    const visible = new Map<string, NodeId[]>();
    const add = (name: string, id: NodeId): void => {
      const list = visible.get(name);
      if (list === undefined) visible.set(name, [id]);
      else if (!list.includes(id)) list.push(id);
    };

    for (const [name, id] of file.exports) add(name, id);

    for (const [local, origin] of file.imported) {
      const source = this.#table.files.get(origin.fromFile);
      if (source === undefined) continue;
      if (origin.originalName === '*') {
        // `import * as L` binds a namespace; its members are reached as `L.x`,
        // which the member resolver handles via `unitAlias`.
        continue;
      }
      const target = source.exports.get(origin.originalName);
      if (target !== undefined) add(local, target);
    }

    for (const bare of file.bareImports) {
      const source = this.#table.files.get(bare);
      if (source === undefined) continue;
      for (const [name, id] of source.exports) add(name, id);
    }

    return visible;
  }

  /** Declarations a file can refer to by this name. Empty when none. */
  visible(file: string, name: string): AnySymbol[] {
    const ids = this.#visible.get(file)?.get(name) ?? [];
    const out: AnySymbol[] = [];
    for (const id of ids) {
      const symbol = this.#table.symbols.get(id);
      if (symbol !== undefined) out.push(symbol);
    }
    return out;
  }

  /**
   * Contracts a name refers to from a file: imported first, then the
   * project-wide index.
   *
   * The global fallback is what makes a graph possible at all in a project
   * whose imports do not resolve — but it is also how `pathological/`'s two
   * `Duplicate` contracts would silently become one, so it returns every match
   * and the caller decides. Two matches is `ambiguous`, never a coin flip.
   */
  contracts(file: string, name: string): ContractSymbol[] {
    const local = this.visible(file, name).filter(
      (s): s is ContractSymbol => s.kind === 'contract',
    );
    if (local.length > 0) return local;

    const ids = this.#table.contractsByName.get(name) ?? [];
    const out: ContractSymbol[] = [];
    for (const id of ids) {
      const symbol = this.#table.symbols.get(id);
      if (symbol?.kind === 'contract') out.push(symbol);
    }
    return out;
  }

  /** `import * as L from "..."` → the file `L` names. */
  unitAlias(file: string, name: string): string | null {
    const origin = this.#table.files.get(file)?.imported.get(name);
    return origin !== undefined && origin.originalName === '*' ? origin.fromFile : null;
  }

  // --- inheritance ------------------------------------------------------

  /**
   * C3 linearization, in Solidity's spelling of it.
   *
   * Solidity lists bases most-base-first and linearizes right to left, so
   * `contract D is B, C` yields `[D, C, B, A]` and `contract E is C, B` yields
   * `[E, B, C, A]`. `inheritance/src/Diamond.sol` contains exactly that pair
   * because a resolver that ignores declaration order gets one of the two
   * wrong and still looks plausible.
   *
   * When the merge fails — an inconsistent hierarchy, or a base that did not
   * resolve — the result is a depth-first approximation marked `ambiguous`.
   * That downgrade is visible: every `super` edge resolved through it is
   * reported as ambiguous rather than heuristic.
   */
  #linearise(contract: ContractSymbol, visiting: Set<NodeId>): Linearization {
    const cached = this.#linearizations.get(contract.id);
    if (cached !== undefined) return cached;

    if (visiting.has(contract.id)) {
      // Cyclic inheritance is not valid Solidity, but a tolerant parse of a
      // half-written file can produce it.
      return { order: [contract.id], certainty: 'ambiguous' };
    }
    visiting.add(contract.id);

    let certainty: Certainty = 'certain';
    const bases: Linearization[] = [];
    const baseIds: NodeId[] = [];

    for (const baseName of contract.baseNames) {
      const candidates = this.contracts(contract.file, baseName);
      if (candidates.length !== 1) {
        certainty = 'ambiguous';
        if (candidates.length === 0) continue;
      }
      const base = candidates[0] as ContractSymbol;
      const line = this.#linearise(base, visiting);
      if (line.certainty === 'ambiguous') certainty = 'ambiguous';
      bases.push(line);
      baseIds.push(base.id);
    }

    // Right to left: `is B, C` merges L(C) before L(B).
    const reversed = [...bases].reverse().map((l) => [...l.order]);
    const direct = [...baseIds].reverse();
    const merged = c3Merge([...reversed, direct]);

    // Deduplicated unconditionally, not just on the fallback path: the cycle
    // guard above returns `[contract.id]` for a contract already being
    // linearized, and that entry flows back up into its own chain. A
    // linearization listing the same contract twice is malformed, and Phase 4
    // consumes this array rather than recomputing it.
    let order: NodeId[];
    if (merged === null) {
      certainty = 'ambiguous';
      order = dedupe([contract.id, ...reversed.flat()]);
    } else {
      order = dedupe([contract.id, ...merged]);
    }

    visiting.delete(contract.id);
    const result: Linearization = { order, certainty };
    this.#linearizations.set(contract.id, result);
    return result;
  }

  linearization(contractId: NodeId): Linearization {
    return this.#linearizations.get(contractId) ?? { order: [contractId], certainty: 'ambiguous' };
  }

  /** Contracts that inherit this one, directly or transitively. */
  derivedFrom(contractId: NodeId): NodeId[] {
    return this.#derived.get(contractId) ?? [];
  }

  contract(id: NodeId): ContractSymbol | null {
    const symbol = this.#table.symbols.get(id);
    return symbol?.kind === 'contract' ? symbol : null;
  }

  /**
   * Members named `name` visible in a contract, most-derived first.
   *
   * Overrides shadow the functions they override, so a derived declaration
   * suppresses any base declaration with the same signature. Genuine overloads
   * — same name, different signature — all survive, which is what makes an
   * ambiguous call edge fan out to every candidate.
   */
  members(contractId: NodeId, name: string): AnySymbol[] {
    const out: AnySymbol[] = [];
    const seen = new Set<string>();
    for (const id of this.linearization(contractId).order) {
      const contract = this.contract(id);
      if (contract === null) continue;
      for (const memberId of contract.members) {
        const member = this.#table.symbols.get(memberId);
        if (member === undefined || member.name !== name) continue;
        const key = `${member.kind}:${signatureKey(member)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(member);
      }
    }
    return out;
  }
}

function signatureKey(symbol: AnySymbol): string {
  if (symbol.kind === 'function' || symbol.kind === 'modifier') {
    return `${symbol.name}(${symbol.params.map((p) => p.typeName).join(',')})`;
  }
  return symbol.name;
}

function dedupe(ids: readonly NodeId[]): NodeId[] {
  const seen = new Set<NodeId>();
  const out: NodeId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Textbook C3 merge. Returns null when no candidate is a valid head, which is
 * exactly the case Solidity rejects as "linearization impossible".
 */
function c3Merge(sequences: NodeId[][]): NodeId[] | null {
  const lists = sequences.map((s) => [...s]).filter((s) => s.length > 0);
  const out: NodeId[] = [];

  while (lists.length > 0) {
    let head: NodeId | null = null;
    for (const list of lists) {
      const candidate = list[0] as NodeId;
      const inTail = lists.some((other) => other.indexOf(candidate) > 0);
      if (!inTail) {
        head = candidate;
        break;
      }
    }
    if (head === null) return null;

    out.push(head);
    for (let i = lists.length - 1; i >= 0; i--) {
      const list = lists[i] as NodeId[];
      if (list[0] === head) list.shift();
      if (list.length === 0) lists.splice(i, 1);
    }
  }

  return out;
}
