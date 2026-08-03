/**
 * Heuristic resolution — names to edges, with an honest confidence on each.
 *
 * This is the module §4 is about. Everything above it is syntax; everything
 * below it is presentation. The rule it exists to enforce is in §6: **an
 * `ambiguous` or `unresolved` edge is the correct answer.** Nothing here ever
 * picks a plausible candidate to make the graph look complete, and every
 * downgrade records a `reason`, both because the UI shows it and because §16
 * wants the unresolved buckets instrumented before anyone tries to shrink them.
 *
 * What is genuinely resolvable without a compiler, and why (§4): declared types
 * are syntactically present. `IERC20 public token;` makes `token.transfer()`
 * resolvable; `IVault(addr).deposit()` names the type in the cast; a local
 * declaration carries its type too. The gaps are real but narrow — overloads
 * needing argument-type inference, `super` through an unresolvable base chain,
 * function pointers, and selector dispatch.
 *
 * Resolution order for a bare `f(...)`, per §4: the current contract, then its
 * syntactic inheritance chain, then file-level free functions.
 */

import type { ParsedCall, ParsedParam } from '../parse/interface.js';
import type { SourceRef } from '../parse/positions.js';
import type { CallSubkind, EdgeKind, Resolution } from '../graph/schema.js';
import { normaliseTypeName, type NodeId } from '../symbols/ids.js';
import type {
  AnySymbol,
  ContractSymbol,
  FunctionSymbol,
  StateVariableSymbol,
  SymbolTable,
} from '../symbols/table.js';
import { ProjectScope } from './scope.js';

export { ProjectScope, type Linearization } from './scope.js';

export interface EdgeDraft {
  kind: EdgeKind;
  subkind?: CallSubkind;
  from: NodeId;
  to: NodeId;
  resolution: Resolution;
  src: SourceRef;
  possibleTargets?: NodeId[];
  crossTrustBoundary?: boolean;
  linearizationIndex?: number;
  reason?: string;
}

/** A synthetic target standing in for something that could not be bound. */
export interface UnresolvedTarget {
  id: NodeId;
  name: string;
  reason: string;
  file: string;
  src: SourceRef;
}

export interface ResolveResult {
  edges: EdgeDraft[];
  unresolvedTargets: Map<NodeId, UnresolvedTarget>;
  scope: ProjectScope;
}

/**
 * Global functions that are part of the language, not the project. A call to
 * one is not an edge — there is no node to point at, and an `unresolved` edge
 * per `require` would drown the score in noise that means nothing.
 */
const GLOBAL_BUILTINS = new Set([
  'require',
  'assert',
  'revert',
  'keccak256',
  'sha256',
  'sha3',
  'ripemd160',
  'ecrecover',
  'addmod',
  'mulmod',
  'selfdestruct',
  'suicide',
  'blockhash',
  'blobhash',
  'gasleft',
  'type',
  'payable',
  'unchecked',
]);

/** Members of built-in types: `abi.encode`, `bytes.concat`, `arr.push`. */
const BUILTIN_MEMBER_RECEIVERS = new Set(['abi', 'msg', 'block', 'tx', 'string', 'bytes', 'super']);

const ARRAY_MEMBERS = new Set(['push', 'pop', 'length']);

/** Low-level members of `address`. Their targets are unknowable statically. */
const LOW_LEVEL_MEMBERS: Record<string, CallSubkind> = {
  call: 'lowlevel',
  staticcall: 'lowlevel',
  callcode: 'lowlevel',
  delegatecall: 'delegatecall',
  transfer: 'lowlevel',
  send: 'lowlevel',
};

/** Members every `address` has that are values, not calls. */
const ADDRESS_VALUE_MEMBERS = new Set(['balance', 'code', 'codehash']);

const ELEMENTARY = /^(address|bool|string|bytes\d*|u?int\d*|fixed|ufixed)\b/;

const TYPE_SYMBOL_KINDS: ReadonlySet<string> = new Set([
  'contract',
  'struct',
  'enum',
  'userDefinedValueType',
]);

/** Types with built-in members only — nothing a call edge could point at. */
const NON_CONTRACT_TYPE_KINDS: ReadonlySet<string> = new Set([
  'struct',
  'enum',
  'userDefinedValueType',
]);

function isElementary(type: string): boolean {
  return ELEMENTARY.test(type.trim());
}

/** `IERC20[] memory` → `IERC20`; `mapping(address => uint256)` → itself. */
function baseTypeName(type: string): string {
  const normalised = normaliseTypeName(type);
  if (normalised.startsWith('mapping')) return normalised;
  return normalised
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b(memory|storage|calldata|payable)\b/g, '')
    .trim();
}

function paramTypes(params: readonly ParsedParam[]): string[] {
  return params.map((p) => normaliseTypeName(p.typeName));
}

function isFunctionPointerType(type: string): boolean {
  return /^function\s*\(/.test(type.trim());
}

class Resolver {
  readonly #table: SymbolTable;
  readonly #scope: ProjectScope;
  readonly edges: EdgeDraft[] = [];
  readonly unresolvedTargets = new Map<NodeId, UnresolvedTarget>();

  constructor(table: SymbolTable) {
    this.#table = table;
    this.#scope = new ProjectScope(table);
  }

  get scope(): ProjectScope {
    return this.#scope;
  }

  // --- edge emission ----------------------------------------------------

  #emit(edge: EdgeDraft): void {
    this.edges.push(edge);
  }

  /**
   * Point an edge at a synthetic `Unresolved` node. The id is the callee name
   * so that every unresolved `call` in a project collapses onto one node the
   * UI can filter on; the individual call sites stay on the edges.
   */
  #unresolved(
    from: NodeId,
    kind: EdgeKind,
    name: string,
    reason: string,
    src: SourceRef,
    subkind?: CallSubkind,
  ): void {
    const id = `?${name}`;
    if (!this.unresolvedTargets.has(id)) {
      this.unresolvedTargets.set(id, { id, name, reason, file: src.file, src });
    }
    this.#emit({
      kind,
      from,
      to: id,
      resolution: 'unresolved',
      src,
      reason,
      ...(subkind === undefined ? {} : { subkind }),
    });
  }

  /**
   * One call site, one or more candidates. A single candidate is `heuristic`;
   * several are all emitted as `ambiguous`, per §4's rule on overloads.
   */
  #emitCandidates(
    from: NodeId,
    kind: EdgeKind,
    candidates: readonly AnySymbol[],
    src: SourceRef,
    options: {
      subkind?: CallSubkind;
      reason: string;
      possibleTargets?: (target: AnySymbol) => NodeId[];
      crossTrustBoundary?: boolean;
    },
  ): void {
    const resolution: Resolution = candidates.length > 1 ? 'ambiguous' : 'heuristic';
    for (const candidate of candidates) {
      const targets = options.possibleTargets?.(candidate) ?? [];
      this.#emit({
        kind,
        from,
        to: candidate.id,
        resolution,
        src,
        ...(options.subkind === undefined ? {} : { subkind: options.subkind }),
        ...(targets.length > 0 ? { possibleTargets: targets } : {}),
        ...(options.crossTrustBoundary === true ? { crossTrustBoundary: true } : {}),
        ...(candidates.length > 1 ? { reason: options.reason } : {}),
      });
    }
  }

  // --- entry ------------------------------------------------------------

  run(): void {
    for (const file of this.#table.files.values()) {
      for (const id of file.declarations) {
        const symbol = this.#table.symbols.get(id);
        if (symbol === undefined) continue;
        // `declares` is containment, not resolution: file → top-level,
        // contract → member. It is excluded from the resolution score.
        this.#emit({
          kind: 'declares',
          from: symbol.scope ?? file.file,
          to: symbol.id,
          resolution: 'heuristic',
          src: symbol.src,
        });
      }
    }

    for (const symbol of this.#table.symbols.values()) {
      if (symbol.kind === 'contract') this.#resolveContract(symbol);
      else if (symbol.kind === 'function' || symbol.kind === 'modifier') {
        this.#resolveFunction(symbol);
      }
    }
  }

  // --- contracts --------------------------------------------------------

  #resolveContract(contract: ContractSymbol): void {
    const linearization = this.#scope.linearization(contract.id);

    for (const baseName of contract.baseNames) {
      const candidates = this.#scope.contracts(contract.file, baseName);
      if (candidates.length === 0) {
        this.#unresolved(
          contract.id,
          'inherits',
          baseName,
          'base contract not found in file scope or project',
          contract.src,
        );
        continue;
      }
      const resolution: Resolution = candidates.length > 1 ? 'ambiguous' : 'heuristic';
      for (const base of candidates) {
        const index = linearization.order.indexOf(base.id);
        this.#emit({
          kind: 'inherits',
          from: contract.id,
          to: base.id,
          resolution,
          src: contract.src,
          ...(index >= 0 ? { linearizationIndex: index } : {}),
          ...(candidates.length > 1
            ? { reason: `${candidates.length} contracts named ${baseName}` }
            : {}),
        });
      }
    }
  }

  // --- functions --------------------------------------------------------

  #resolveFunction(fn: FunctionSymbol): void {
    const contract = fn.scope === null ? null : this.#scope.contract(fn.scope);

    this.#resolveOverrides(fn, contract);
    this.#resolveModifiers(fn, contract);
    this.#resolveStateAccess(fn, contract);
    this.#resolveNameRefs(fn, contract, fn.emits, 'emits', 'event');
    this.#resolveNameRefs(fn, contract, fn.reverts, 'reverts', 'error');

    for (const call of fn.calls) this.#resolveCall(fn, contract, call);
  }

  /**
   * `overrides` when the base declaration has a body, `implements` when it does
   * not. Every base in the chain that declares the same signature gets an
   * edge — which is what `override(ERC20, ERC20Pausable)` means, and what makes
   * `inheritance/src/GovernedToken.sol` a useful fixture.
   */
  #resolveOverrides(fn: FunctionSymbol, contract: ContractSymbol | null): void {
    if (contract === null || fn.subkind === 'constructor') return;
    const signature = paramTypes(fn.params).join(',');

    for (const ancestorId of this.#scope.linearization(contract.id).order) {
      if (ancestorId === contract.id) continue;
      const ancestor = this.#scope.contract(ancestorId);
      if (ancestor === null) continue;
      for (const memberId of ancestor.members) {
        const member = this.#table.symbols.get(memberId);
        if (member === undefined) continue;
        if (member.kind !== fn.kind || member.name !== fn.name) continue;
        if (paramTypes(member.params).join(',') !== signature) continue;
        this.#emit({
          kind: member.hasBody ? 'overrides' : 'implements',
          from: fn.id,
          to: member.id,
          resolution: 'heuristic',
          src: fn.src,
        });
      }
    }
  }

  /**
   * A modifier invocation list also carries base-constructor arguments —
   * `constructor(...) ERC20("Governed", "GOV")` parses identically to a
   * modifier. Resolving the name decides which it was; a name that turns out to
   * be a base contract becomes a call to that contract's constructor, not a
   * bogus `modifiedBy` edge.
   */
  #resolveModifiers(fn: FunctionSymbol, contract: ContractSymbol | null): void {
    for (const name of fn.modifierNames) {
      const modifiers =
        contract === null
          ? []
          : this.#scope.members(contract.id, name).filter((m) => m.kind === 'modifier');

      if (modifiers.length > 0) {
        this.#emitCandidates(fn.id, 'modifiedBy', modifiers, fn.src, {
          reason: `${modifiers.length} modifiers named ${name} in the inheritance chain`,
        });
        continue;
      }

      const bases = this.#scope.contracts(fn.file, name);
      const isBase =
        contract !== null &&
        bases.some((base) => this.#scope.linearization(contract.id).order.includes(base.id));
      if (isBase) {
        const constructors = bases.flatMap((base) =>
          this.#scope.members(base.id, 'constructor').filter((m) => m.kind === 'function'),
        );
        if (constructors.length > 0) {
          this.#emitCandidates(fn.id, 'calls', constructors, fn.src, {
            subkind: 'internal',
            reason: 'base constructor invocation',
          });
        }
        // A base with no declared constructor is not an edge and not a gap.
        continue;
      }

      this.#unresolved(
        fn.id,
        'modifiedBy',
        name,
        'modifier not found in the inheritance chain',
        fn.src,
      );
    }
  }

  /**
   * State access (§4: strictly easier than call resolution).
   *
   * A name is a state access when it is not shadowed by a local and it names a
   * state variable in the contract's chain, or a file-level constant in scope.
   * Locals win: `inheritance/src/Shadowing.sol` declares a local `_greeting`
   * over a base state variable of the same name, and reporting a read there
   * would be wrong in the view that is meant to answer "who can touch this".
   */
  #resolveStateAccess(fn: FunctionSymbol, contract: ContractSymbol | null): void {
    const locals = new Set(fn.locals.map((l) => l.name));

    for (const use of fn.identifiers) {
      if (locals.has(use.name)) continue;

      let target: StateVariableSymbol | null = null;
      if (contract !== null) {
        const member = this.#scope
          .members(contract.id, use.name)
          .find((m) => m.kind === 'stateVariable');
        if (member !== undefined) target = member;
      }
      if (target === null) {
        const fileLevel = this.#scope
          .visible(fn.file, use.name)
          .find((s) => s.kind === 'stateVariable');
        if (fileLevel !== undefined) target = fileLevel;
      }
      if (target === null) continue;

      this.#emit({
        kind: use.write ? 'writes' : 'reads',
        from: fn.id,
        to: target.id,
        resolution: 'heuristic',
        src: use.src,
      });
    }
  }

  /** `emit E(...)` and `revert Err(...)` — contract chain, then file scope. */
  #resolveNameRefs(
    fn: FunctionSymbol,
    contract: ContractSymbol | null,
    refs: readonly { name: string; src: SourceRef }[],
    kind: EdgeKind,
    symbolKind: 'event' | 'error',
  ): void {
    for (const ref of refs) {
      const inChain =
        contract === null
          ? []
          : this.#scope.members(contract.id, ref.name).filter((m) => m.kind === symbolKind);
      const candidates =
        inChain.length > 0
          ? inChain
          : this.#scope.visible(fn.file, ref.name).filter((s) => s.kind === symbolKind);

      if (candidates.length === 0) {
        this.#unresolved(
          fn.id,
          kind,
          ref.name,
          `${symbolKind} not found in the inheritance chain or file scope`,
          ref.src,
        );
        continue;
      }
      this.#emitCandidates(fn.id, kind, candidates, ref.src, {
        reason: `${candidates.length} ${symbolKind}s named ${ref.name} in scope`,
      });
    }
  }

  // --- calls ------------------------------------------------------------

  #resolveCall(fn: FunctionSymbol, contract: ContractSymbol | null, call: ParsedCall): void {
    switch (call.shape) {
      case 'new':
        this.#resolveNew(fn, call);
        return;
      case 'bare':
        this.#resolveBare(fn, contract, call);
        return;
      case 'super':
        this.#resolveSuper(fn, contract, call);
        return;
      case 'this':
        this.#resolveOnSelf(fn, contract, call);
        return;
      case 'member':
        this.#resolveMember(fn, contract, call);
        return;
      case 'cast':
        this.#resolveCast(fn, contract, call);
        return;
      case 'expression':
        this.#resolveOnExpression(fn, call);
        return;
      default:
        return;
    }
  }

  /**
   * `new` is only a `creates` edge for a contract. `new bytes(n)` and
   * `new uint256[](k)` allocate memory — no CREATE, no node to point at, and
   * emitting `unresolved` for them would bury the real unresolved calls under
   * library noise.
   */
  #resolveNew(fn: FunctionSymbol, call: ParsedCall): void {
    if (isElementary(call.name) || call.name.includes('[')) return;
    const candidates = this.#scope.contracts(fn.file, baseTypeName(call.name));
    if (candidates.length === 0) {
      this.#unresolved(fn.id, 'creates', call.name, 'contract type not in scope', call.src);
      return;
    }
    this.#emitCandidates(fn.id, 'creates', candidates, call.src, {
      reason: `${candidates.length} contracts named ${call.name}`,
    });
  }

  /**
   * A bare call is the one place a call and a *type conversion* are spelled
   * identically: `Deposit({...})` builds a struct, `IPair(x)` casts, and
   * `scale(a, b)` calls a free function. Functions are looked up first, and a
   * name that resolves to a type instead is not an edge at all.
   */
  #resolveBare(fn: FunctionSymbol, contract: ContractSymbol | null, call: ParsedCall): void {
    if (GLOBAL_BUILTINS.has(call.name)) return;

    const local = fn.locals.find((l) => l.name === call.name);
    if (local !== undefined) {
      const reason = isFunctionPointerType(local.typeName)
        ? 'call through a function pointer'
        : 'call through a local value';
      this.#unresolved(fn.id, 'calls', call.name, reason, call.src, 'internal');
      return;
    }

    const inChain =
      contract === null
        ? []
        : this.#scope.members(contract.id, call.name).filter((m) => m.kind === 'function');
    const free = this.#scope.visible(fn.file, call.name).filter((s) => s.kind === 'function');
    const functions = inChain.length > 0 ? inChain : free;

    if (functions.length > 0) {
      const chosen = narrowByArity(functions, call.argCount);
      this.#emitCandidates(fn.id, 'calls', chosen, call.src, {
        subkind: this.#subkindFor(chosen[0] as FunctionSymbol, 'internal'),
        reason: `${chosen.length} overloads of ${call.name}; argument types need inference`,
        possibleTargets: (target) => this.#overridesOf(target),
      });
      return;
    }

    // A state variable of function-pointer type, called by name.
    const pointer =
      contract === null
        ? undefined
        : this.#scope.members(contract.id, call.name).find((m) => m.kind === 'stateVariable');
    if (pointer !== undefined && isFunctionPointerType(pointer.typeName)) {
      this.#unresolved(
        fn.id,
        'calls',
        call.name,
        'call through a function pointer',
        call.src,
        'internal',
      );
      return;
    }

    if (this.#namesAType(fn.file, contract, call.name)) return;

    this.#unresolved(
      fn.id,
      'calls',
      call.name,
      'no function of that name in the contract, its bases, or file scope',
      call.src,
      'internal',
    );
  }

  /**
   * `super.m()` needs the linearization, so its confidence is the chain's.
   * §4 lists this as a genuine gap when the base chain cannot be resolved —
   * the answer there is every candidate, marked ambiguous.
   */
  #resolveSuper(fn: FunctionSymbol, contract: ContractSymbol | null, call: ParsedCall): void {
    if (contract === null) {
      this.#unresolved(fn.id, 'calls', call.name, 'super outside a contract', call.src, 'super');
      return;
    }

    const linearization = this.#scope.linearization(contract.id);
    const candidates: FunctionSymbol[] = [];
    for (const ancestorId of linearization.order) {
      if (ancestorId === contract.id) continue;
      const ancestor = this.#scope.contract(ancestorId);
      if (ancestor === null) continue;
      for (const memberId of ancestor.members) {
        const member = this.#table.symbols.get(memberId);
        if (member === undefined || member.kind !== 'function') continue;
        if (member.name !== call.name || !member.hasBody) continue;
        candidates.push(member);
      }
      // C3 dispatch stops at the first base that implements it.
      if (candidates.length > 0 && linearization.certainty === 'certain') break;
    }

    if (candidates.length === 0) {
      this.#unresolved(
        fn.id,
        'calls',
        call.name,
        'no implementation of that name in the base chain',
        call.src,
        'super',
      );
      return;
    }

    if (linearization.certainty === 'ambiguous') {
      for (const candidate of candidates) {
        this.#emit({
          kind: 'calls',
          subkind: 'super',
          from: fn.id,
          to: candidate.id,
          resolution: 'ambiguous',
          src: call.src,
          reason: 'inheritance chain could not be linearized with certainty',
        });
      }
      return;
    }

    const chosen = narrowByArity(candidates, call.argCount);
    this.#emitCandidates(fn.id, 'calls', chosen, call.src, {
      subkind: 'super',
      reason: `${chosen.length} implementations reachable through super`,
    });
  }

  /** `this.m()` — an external call into the contract's own surface. */
  #resolveOnSelf(fn: FunctionSymbol, contract: ContractSymbol | null, call: ParsedCall): void {
    if (contract === null) {
      this.#unresolved(fn.id, 'calls', call.name, 'this outside a contract', call.src, 'external');
      return;
    }
    const candidates = this.#scope
      .members(contract.id, call.name)
      .filter((m) => m.kind === 'function');
    if (candidates.length === 0) {
      this.#unresolved(
        fn.id,
        'calls',
        call.name,
        'no such function on this contract',
        call.src,
        'external',
      );
      return;
    }
    this.#emitCandidates(fn.id, 'calls', narrowByArity(candidates, call.argCount), call.src, {
      subkind: 'external',
      reason: `${candidates.length} overloads of ${call.name}`,
    });
  }

  #resolveCast(fn: FunctionSymbol, contract: ContractSymbol | null, call: ParsedCall): void {
    const typeName = call.receiver ?? '';
    if (isElementary(typeName)) {
      this.#resolveOnElementary(fn, contract, call, baseTypeName(typeName));
      return;
    }
    const contracts = this.#scope.contracts(fn.file, baseTypeName(typeName));
    if (contracts.length === 0) {
      this.#unresolved(
        fn.id,
        'calls',
        call.name,
        `cast to unknown type ${typeName}`,
        call.src,
        'external',
      );
      return;
    }
    this.#resolveOnContracts(fn, call, contracts, 'external');
  }

  #resolveMember(fn: FunctionSymbol, contract: ContractSymbol | null, call: ParsedCall): void {
    const receiver = call.receiver ?? '';

    if (BUILTIN_MEMBER_RECEIVERS.has(receiver)) return;

    // `import * as L from "..."` — members are that file's top-level names.
    const namespace = this.#scope.unitAlias(fn.file, receiver);
    if (namespace !== null) {
      const exported = this.#table.files.get(namespace)?.exports.get(call.name);
      const symbol = exported === undefined ? undefined : this.#table.symbols.get(exported);
      if (symbol !== undefined && symbol.kind === 'function') {
        this.#emitCandidates(fn.id, 'calls', [symbol], call.src, {
          subkind: this.#subkindFor(symbol, 'internal'),
          reason: 'namespace member',
        });
        return;
      }
    }

    // `MyType.wrap(x)` / `.unwrap(x)` on a user-defined value type, and members
    // of a struct or enum type used as a namespace. These are built-in members
    // of the type, not declarations, so there is nothing to point at.
    if (this.#namesANonContractType(fn.file, contract, receiver)) return;

    // A contract or library named directly: `AmmMath.sqrt(x)`.
    const named = this.#scope.contracts(fn.file, receiver);
    if (named.length > 0 && !this.#hasVariable(fn, contract, receiver)) {
      this.#resolveOnContracts(
        fn,
        call,
        named,
        named[0]?.contractKind === 'library' ? 'library' : 'external',
      );
      return;
    }

    const type = this.#typeOfVariable(fn, contract, receiver);
    if (type === null) {
      this.#unresolved(
        fn.id,
        'calls',
        call.name,
        `receiver ${receiver} has no declared type in scope`,
        call.src,
        'external',
      );
      return;
    }

    if (isElementary(type)) {
      this.#resolveOnElementary(fn, contract, call, baseTypeName(type));
      return;
    }

    const contracts = this.#scope.contracts(fn.file, baseTypeName(type));
    if (contracts.length > 0) {
      this.#resolveOnContracts(fn, call, contracts, 'external');
      return;
    }

    if (ARRAY_MEMBERS.has(call.name)) return;

    this.#resolveOnElementary(fn, contract, call, baseTypeName(type));
  }

  /**
   * `f().m()`, `arr[i].m()` — nothing names the receiver's type.
   *
   * The trailing-identifier check is a concession to the grammar: in
   * `a.length != 0 && !abi.decode(x)` it parses the whole left operand as the
   * receiver of `.decode`, so a textual `abi` at the end of the receiver is the
   * real receiver. Narrow on purpose — it only ever suppresses an edge to a
   * language builtin, never invents one.
   */
  #resolveOnExpression(fn: FunctionSymbol, call: ParsedCall): void {
    const trailing = /([A-Za-z_$][\w$]*)\s*$/.exec(call.receiver ?? '')?.[1];
    if (trailing !== undefined && BUILTIN_MEMBER_RECEIVERS.has(trailing)) return;
    if (ARRAY_MEMBERS.has(call.name)) return;
    const lowLevel = LOW_LEVEL_MEMBERS[call.name];
    this.#unresolved(
      fn.id,
      'calls',
      call.name,
      'receiver is an expression with no syntactically declared type',
      call.src,
      lowLevel ?? 'external',
    );
  }

  /**
   * A receiver whose declared type is elementary or a struct. Three outcomes:
   * a `using ... for` attachment (a real library edge), a low-level member
   * (honestly unresolved — the target is chosen at runtime), or a value member
   * like `.balance` that is not a call at all.
   */
  #resolveOnElementary(
    fn: FunctionSymbol,
    contract: ContractSymbol | null,
    call: ParsedCall,
    type: string,
  ): void {
    const attached = this.#usingFor(fn, contract, type, call.name);
    if (attached.length > 0) {
      this.#emitCandidates(fn.id, 'calls', attached, call.src, {
        subkind: 'library',
        reason: `${attached.length} attached functions named ${call.name} for ${type}`,
      });
      return;
    }

    if (ARRAY_MEMBERS.has(call.name) || ADDRESS_VALUE_MEMBERS.has(call.name)) return;

    const lowLevel = LOW_LEVEL_MEMBERS[call.name];
    if (lowLevel !== undefined) {
      this.#unresolved(
        fn.id,
        'calls',
        call.name,
        `${call.name} on ${type}: the target is determined at runtime`,
        call.src,
        lowLevel,
      );
      return;
    }

    this.#unresolved(
      fn.id,
      'calls',
      call.name,
      `no function ${call.name} attached to ${type} by a using-for directive`,
      call.src,
      'external',
    );
  }

  /**
   * Resolve a member against one or more candidate contracts.
   *
   * Interface calls are the edges §10 says auditors care about most: the edge
   * goes to the *interface* function, `possibleTargets` lists every
   * implementation in the project, and `crossTrustBoundary` is set. A call to a
   * public state variable resolves to the variable itself — the compiler's
   * implicit getter has no declaration to point at, and the variable is the
   * thing the auditor wants to land on.
   */
  #resolveOnContracts(
    fn: FunctionSymbol,
    call: ParsedCall,
    contracts: readonly ContractSymbol[],
    defaultSubkind: CallSubkind,
  ): void {
    const functions: FunctionSymbol[] = [];
    const getters: StateVariableSymbol[] = [];
    let crossTrustBoundary = false;

    for (const contract of contracts) {
      for (const member of this.#scope.members(contract.id, call.name)) {
        if (member.kind === 'function') {
          functions.push(member);
          if (contract.contractKind === 'interface') crossTrustBoundary = true;
        } else if (member.kind === 'stateVariable' && member.visibility === 'public') {
          getters.push(member);
        }
      }
    }

    if (functions.length > 0) {
      const chosen = narrowByArity(functions, call.argCount);
      const subkind = this.#subkindFor(chosen[0] as FunctionSymbol, defaultSubkind);
      this.#emitCandidates(fn.id, 'calls', chosen, call.src, {
        subkind,
        reason: `${chosen.length} candidates named ${call.name}`,
        possibleTargets: (target) => this.#implementationsOf(target),
        ...(crossTrustBoundary ? { crossTrustBoundary: true } : {}),
      });
      return;
    }

    if (getters.length > 0) {
      this.#emitCandidates(fn.id, 'calls', getters, call.src, {
        subkind: 'external',
        reason: `${getters.length} public state variables named ${call.name}`,
      });
      return;
    }

    if (ARRAY_MEMBERS.has(call.name)) return;

    this.#unresolved(
      fn.id,
      'calls',
      call.name,
      `no member ${call.name} on ${contracts.map((c) => c.name).join('/')}`,
      call.src,
      defaultSubkind,
    );
  }

  // --- helpers ----------------------------------------------------------

  #subkindFor(target: FunctionSymbol | undefined, fallback: CallSubkind): CallSubkind {
    if (target === undefined || target.scope === null) return fallback;
    const owner = this.#scope.contract(target.scope);
    if (owner?.contractKind === 'library') return 'library';
    return fallback;
  }

  #hasVariable(fn: FunctionSymbol, contract: ContractSymbol | null, name: string): boolean {
    return this.#typeOfVariable(fn, contract, name) !== null;
  }

  /** Local declarations shadow state variables, exactly as in Solidity. */
  #typeOfVariable(
    fn: FunctionSymbol,
    contract: ContractSymbol | null,
    name: string,
  ): string | null {
    const local = fn.locals.find((l) => l.name === name);
    if (local !== undefined) return local.typeName;
    if (contract !== null) {
      const member = this.#scope.members(contract.id, name).find((m) => m.kind === 'stateVariable');
      if (member !== undefined) return member.typeName;
    }
    const fileLevel = this.#scope.visible(fn.file, name).find((s) => s.kind === 'stateVariable');
    return fileLevel === undefined ? null : fileLevel.typeName;
  }

  #namesAType(file: string, contract: ContractSymbol | null, name: string): boolean {
    return this.#namesKind(file, contract, name, TYPE_SYMBOL_KINDS);
  }

  #namesANonContractType(
    file: string,
    contract: ContractSymbol | null,
    name: string,
  ): boolean {
    return this.#namesKind(file, contract, name, NON_CONTRACT_TYPE_KINDS);
  }

  #namesKind(
    file: string,
    contract: ContractSymbol | null,
    name: string,
    kinds: ReadonlySet<string>,
  ): boolean {
    if (this.#scope.visible(file, name).some((s) => kinds.has(s.kind))) return true;
    if (contract === null) return false;
    return this.#scope.members(contract.id, name).some((s) => kinds.has(s.kind));
  }

  /**
   * `using L for T` and `using {f, g} for T`, contract-scoped.
   *
   * Not inherited: since 0.7 a using-for directive is active only in the
   * contract that declares it. A file-level `using ... global` would apply
   * everywhere, but the parser does not yet collect file-level directives and
   * no fixture uses one; see §16.
   */
  #usingFor(
    fn: FunctionSymbol,
    contract: ContractSymbol | null,
    type: string,
    member: string,
  ): AnySymbol[] {
    if (contract === null) return [];
    const out: AnySymbol[] = [];

    for (const directive of contract.usingFor) {
      const applies =
        directive.typeName === null || baseTypeName(directive.typeName) === baseTypeName(type);
      if (!applies) continue;

      if (directive.libraryName !== null) {
        for (const library of this.#scope.contracts(contract.file, directive.libraryName)) {
          for (const candidate of this.#scope.members(library.id, member)) {
            if (candidate.kind === 'function') out.push(candidate);
          }
        }
      }

      if (directive.functions.includes(member)) {
        for (const candidate of this.#scope.visible(fn.file, member)) {
          if (candidate.kind === 'function') out.push(candidate);
        }
      }
    }

    return out;
  }

  /**
   * §10's `possibleTargets` for an interface call: every contract in the
   * project that inherits the interface and implements the function.
   */
  #implementationsOf(target: AnySymbol): NodeId[] {
    if (target.kind !== 'function' || target.scope === null) return [];
    const owner = this.#scope.contract(target.scope);
    if (owner === null) return [];
    if (owner.contractKind !== 'interface' && !target.isVirtual) return [];
    return this.#overridesOf(target);
  }

  /** Implementations of a virtual or interface function in derived contracts. */
  #overridesOf(target: AnySymbol): NodeId[] {
    if (target.kind !== 'function' || target.scope === null) return [];
    const signature = paramTypes(target.params).join(',');
    const out: NodeId[] = [];
    for (const derivedId of this.#scope.derivedFrom(target.scope)) {
      const derived = this.#scope.contract(derivedId);
      if (derived === null) continue;
      for (const memberId of derived.members) {
        const member = this.#table.symbols.get(memberId);
        if (member === undefined || member.kind !== 'function') continue;
        if (member.name !== target.name || !member.hasBody) continue;
        if (paramTypes(member.params).join(',') !== signature) continue;
        out.push(member.id);
      }
    }
    return out;
  }
}

/**
 * Solidity has no default arguments, so an exact arity match is a real
 * discriminator between overloads. When nothing matches — a miscounted
 * argument, or a call to something that is not what it looks like — every
 * candidate survives and the edge goes out ambiguous rather than wrong.
 */
function narrowByArity<T extends AnySymbol>(candidates: readonly T[], argCount: number): T[] {
  const exact = candidates.filter(
    (c) => (c.kind === 'function' || c.kind === 'modifier') && c.params.length === argCount,
  );
  return exact.length > 0 ? exact : [...candidates];
}

export function resolveProject(table: SymbolTable): ResolveResult {
  const resolver = new Resolver(table);
  resolver.run();
  return {
    edges: resolver.edges,
    unresolvedTargets: resolver.unresolvedTargets,
    scope: resolver.scope,
  };
}
