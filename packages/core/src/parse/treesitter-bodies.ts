/**
 * Expression-level analysis of a function body — the input to Phase 2's
 * heuristic resolver.
 *
 * Backend-specific on purpose: this walks tree-sitter nodes directly, the way
 * `treesitter.ts` does, and produces only the neutral types from
 * `interface.ts`. A second backend would bring its own walker; nothing
 * downstream would notice.
 *
 * The rule that shapes every decision here: **record what was written, never
 * what it means.** `IPair(pair).mint(to)` becomes "a cast-shaped call named
 * `mint` on type `IPair`", not an edge to `Pair.mint`. The parser has no symbol
 * table and cannot tell `Deposit({...})` (a struct literal) from `scale(x, y)`
 * (a free function) — both are a bare call here, and `resolve/` sorts them out
 * with the table in hand. Guessing at this layer would produce exactly the
 * confidently-wrong graph §6 forbids.
 *
 * Grammar facts this depends on, all verified against the vendored grammar:
 *
 * - Every expression slot is wrapped in an `expression` node with a single
 *   named child, so nearly everything starts with `unwrap`.
 * - A cast is spelled two ways. `address(x)` is a `type_cast_expression`
 *   (primitive target); `IPair(x)` is an ordinary `call_expression` with an
 *   identifier callee, indistinguishable from a function call until you know
 *   `IPair` is a type.
 * - Call options attach as a `struct_expression` wrapping the callee:
 *   `to.call{value: v}(...)` and `new Pair{salt: s}()`.
 * - Inline assembly is a separate node family (`yul_*`). Yul identifiers can
 *   name Solidity locals, but binding them soundly means modelling Yul scope,
 *   so this reads only the EVM builtins — enough for §10's flags, and it never
 *   invents a variable reference.
 */

import type { Node } from 'web-tree-sitter';

import {
  emptyFunctionFlags,
  type ParsedCall,
  type ParsedFunctionFlags,
  type ParsedFunctionMetrics,
  type ParsedIdentifierUse,
  type ParsedLocal,
  type ParsedNameRef,
  type ParsedParam,
} from './interface.js';
import type { PositionIndex, SourceRef } from './positions.js';

type TsNode = Node;

export interface BodyAnalysis {
  calls: ParsedCall[];
  identifiers: ParsedIdentifierUse[];
  emits: ParsedNameRef[];
  reverts: ParsedNameRef[];
  locals: ParsedLocal[];
  flags: ParsedFunctionFlags;
  metrics: ParsedFunctionMetrics;
  /** Non-comment leaf tokens, in order — the input to `bodyHash`. */
  tokens: string[];
}

/** Nodes that open a nesting level for `maxDepth`. */
const BLOCK_NODES = new Set(['function_body', 'block_statement', 'assembly_statement']);

/** Statements that add a branch to the cyclomatic count. */
const BRANCH_NODES = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'do_while_statement',
  'catch_clause',
  'ternary_expression',
  'conditional_expression',
  'yul_if',
  'yul_for_statement',
]);

/** Yul builtins worth a flag. Everything else in assembly is ignored. */
const YUL_FLAGS: Record<string, keyof ParsedFunctionFlags> = {
  delegatecall: 'hasDelegatecall',
  call: 'hasLowLevelCall',
  callcode: 'hasLowLevelCall',
  staticcall: 'hasLowLevelCall',
  selfdestruct: 'hasSelfdestruct',
  create: 'hasCreate',
  create2: 'hasCreate',
  sstore: 'assemblyWritesState',
  sload: 'assemblyReadsState',
  tstore: 'assemblyWritesState',
  tload: 'assemblyReadsState',
};

/** Members that mutate their receiver in place. */
const MUTATING_MEMBERS = new Set(['push', 'pop']);

/**
 * `new` on a built-in type allocates memory; only `new Contract()` emits a
 * CREATE. `new bytes(n)` and `new uint256[](k)` are extremely common in library
 * code, and counting them would put `hasCreate` on half of OpenZeppelin.
 */
const ELEMENTARY_TYPE = /^(address|bool|string|bytes\d*|u?int\d*|fixed|ufixed)\b/;

function unwrap(node: TsNode | null): TsNode | null {
  let current = node;
  while (
    current !== null &&
    (current.type === 'expression' || current.type === 'parenthesized_expression')
  ) {
    const next = current.namedChildren.find((c) => c !== null && c.type !== 'comment');
    if (next === undefined || next === null) return current;
    current = next;
  }
  return current;
}

function namedChildren(node: TsNode): TsNode[] {
  return node.namedChildren.filter((c): c is TsNode => c !== null && c.type !== 'comment');
}

function firstNamed(node: TsNode): TsNode | null {
  return namedChildren(node)[0] ?? null;
}

function hasAnonymous(node: TsNode, token: string): boolean {
  return node.children.some((c) => c !== null && !c.isNamed && c.type === token);
}

/**
 * The identifier a write lands on: `pairs[a][b] = x` writes `pairs`, and
 * `s.field = x` writes `s`. Peels index and member access down to the root
 * name, and returns null for anything that is not rooted in one — a write
 * through a pointer is not attributable to a declaration.
 */
function baseIdentifier(node: TsNode | null): TsNode | null {
  let current = unwrap(node);
  for (;;) {
    if (current === null) return null;
    if (current.type === 'identifier') return current;
    if (
      current.type === 'member_expression' ||
      current.type === 'array_access' ||
      current.type === 'slice_access' ||
      current.type === 'index_access'
    ) {
      current = unwrap(firstNamed(current));
      continue;
    }
    return null;
  }
}

/** Every identifier written by a tuple assignment target. */
function assignmentTargets(node: TsNode | null): TsNode[] {
  const target = unwrap(node);
  if (target === null) return [];
  if (target.type === 'tuple_expression' || target.type === 'variable_declaration_tuple') {
    return namedChildren(target).flatMap((child) => assignmentTargets(child));
  }
  const base = baseIdentifier(target);
  return base === null ? [] : [base];
}

interface CalleeShape {
  call: Omit<ParsedCall, 'src' | 'argCount'>;
  /** Nodes already accounted for; visiting them again would double-count. */
  consumed: TsNode[];
  /** Sub-expressions still to visit — a cast's argument, a receiver, options. */
  visit: TsNode[];
}

class BodyWalker {
  readonly #positions: PositionIndex;
  readonly #skip = new Set<number>();
  /**
   * Call expressions already accounted for as the cast in `T(x).m()`.
   *
   * A cast is spelled as a call, so the inner `T(x)` is a `call_expression`
   * that the walk reaches again on its way down. Without this it is recorded a
   * second time as a bare call to `T` — invisible whenever `T` is a known
   * contract, because the resolver then discards it as a type conversion, and
   * a spurious unresolved edge whenever it is not.
   */
  readonly #consumedCalls = new Set<number>();

  readonly calls: ParsedCall[] = [];
  readonly identifiers: ParsedIdentifierUse[] = [];
  readonly emits: ParsedNameRef[] = [];
  readonly reverts: ParsedNameRef[] = [];
  readonly locals: ParsedLocal[] = [];
  readonly flags = emptyFunctionFlags();
  readonly tokens: string[] = [];

  #cyclomatic = 1;
  #maxDepth = 0;
  readonly #lines = new Set<number>();

  constructor(positions: PositionIndex) {
    this.#positions = positions;
  }

  ref(node: TsNode): SourceRef {
    return this.#positions.ref(node.startIndex, node.endIndex);
  }

  get metrics(): ParsedFunctionMetrics {
    return {
      sloc: this.#lines.size,
      cyclomatic: this.#cyclomatic,
      maxDepth: this.#maxDepth,
    };
  }

  // --- entry ------------------------------------------------------------

  walkBody(body: TsNode): void {
    this.#visit(body, 0);
  }

  #record(node: TsNode, write: boolean): void {
    this.identifiers.push({ name: node.text, write, src: this.ref(node) });
  }

  #skipNode(node: TsNode | null): void {
    if (node !== null) this.#skip.add(node.id);
  }

  // --- the walk ---------------------------------------------------------

  #visit(node: TsNode, depth: number): void {
    if (node.type === 'comment') return;

    if (node.childCount === 0) {
      this.tokens.push(node.text);
      this.#lines.add(this.#positions.lineIndexAt(node.startIndex));
    }

    const nextDepth = BLOCK_NODES.has(node.type) ? depth + 1 : depth;
    if (nextDepth > this.#maxDepth) this.#maxDepth = nextDepth;

    if (BRANCH_NODES.has(node.type)) this.#cyclomatic++;
    if (node.type === 'binary_expression' && this.#isShortCircuit(node)) this.#cyclomatic++;
    if (node.type === 'unchecked') this.flags.hasUnchecked = true;
    if (node.type === 'try_statement') this.flags.hasTryCatch = true;

    switch (node.type) {
      case 'assembly_statement':
        this.flags.hasAssembly = true;
        this.#visitAssembly(node, nextDepth);
        return;
      case 'call_expression':
        this.#visitCall(node, nextDepth);
        return;
      case 'assignment_expression':
      case 'augmented_assignment_expression':
        this.#visitAssignment(node, nextDepth);
        return;
      case 'update_expression':
        this.#visitUpdate(node, nextDepth);
        return;
      case 'unary_expression':
        if (hasAnonymous(node, 'delete')) this.#visitDelete(node, nextDepth);
        else break;
        return;
      case 'variable_declaration':
        this.#visitVariableDeclaration(node, nextDepth);
        return;
      case 'emit_statement':
        this.#visitNamedStatement(node, this.emits, nextDepth);
        return;
      case 'revert_statement':
        this.#visitNamedStatement(node, this.reverts, nextDepth);
        return;
      case 'member_expression':
        this.#visitMemberExpression(node, nextDepth);
        return;
      case 'call_struct_argument':
      case 'struct_field_assignment':
        // `Deposit({owner: msg.sender})` — `owner` names a struct field, not a
        // declaration in scope. Recording it as a read produces an edge to
        // whatever state variable happens to share the name.
        this.#skipNode(firstNamed(node));
        break;
      case 'identifier':
        if (!this.#skip.has(node.id)) this.#record(node, false);
        return;
      default:
        break;
    }

    for (const child of node.children) {
      if (child !== null) this.#visit(child, nextDepth);
    }
  }

  #isShortCircuit(node: TsNode): boolean {
    return node.children.some(
      (c) => c !== null && !c.isNamed && (c.type === '&&' || c.type === '||'),
    );
  }

  /**
   * Assembly contributes flags and tokens, nothing else. Yul identifiers are
   * deliberately not recorded: `sstore(slot, value)` names no state variable,
   * and a walker that matched Yul names against the symbol table would invent
   * reads and writes that are not there.
   */
  #visitAssembly(node: TsNode, depth: number): void {
    const walk = (current: TsNode): void => {
      if (current.type === 'comment') return;
      if (current.childCount === 0) {
        this.tokens.push(current.text);
        this.#lines.add(this.#positions.lineIndexAt(current.startIndex));
      }
      if (current.type === 'yul_evm_builtin') {
        const flag = YUL_FLAGS[current.text];
        if (flag !== undefined) this.flags[flag] = true;
      }
      if (BRANCH_NODES.has(current.type)) this.#cyclomatic++;
      for (const child of current.children) if (child !== null) walk(child);
    };
    for (const child of node.children) if (child !== null) walk(child);
    if (depth > this.#maxDepth) this.#maxDepth = depth;
  }

  /**
   * `member_expression` outside a call: `token.balance`, `Status.Active`,
   * `msg.sender`. The receiver is a read; the member name is not an identifier
   * use of its own, because it names a member rather than a declaration in
   * scope.
   */
  #visitMemberExpression(node: TsNode, depth: number): void {
    const children = namedChildren(node);
    // Only when the member is one of several children: a lone child is the
    // receiver of a malformed `a.` recovered mid-edit, not a member name.
    if (children.length > 1) this.#skipNode(children[children.length - 1] ?? null);
    for (const child of node.children) {
      if (child !== null) this.#visit(child, depth);
    }
  }

  #visitAssignment(node: TsNode, depth: number): void {
    const children = namedChildren(node);
    const target = children[0] ?? null;
    // `x = 1` writes only; `x += 1` genuinely reads and writes.
    const alsoReads = node.type === 'augmented_assignment_expression';

    for (const base of assignmentTargets(target)) {
      this.#record(base, true);
      if (alsoReads) this.#record(base, false);
      this.#skipNode(base);
    }

    for (const child of node.children) {
      if (child !== null) this.#visit(child, depth);
    }
  }

  #visitUpdate(node: TsNode, depth: number): void {
    const base = baseIdentifier(firstNamed(node));
    if (base !== null) {
      this.#record(base, true);
      this.#record(base, false);
      this.#skipNode(base);
    }
    for (const child of node.children) {
      if (child !== null) this.#visit(child, depth);
    }
  }

  #visitDelete(node: TsNode, depth: number): void {
    const base = baseIdentifier(firstNamed(node));
    if (base !== null) {
      this.#record(base, true);
      this.#skipNode(base);
    }
    for (const child of node.children) {
      if (child !== null) this.#visit(child, depth);
    }
  }

  #visitVariableDeclaration(node: TsNode, depth: number): void {
    const type =
      node.childForFieldName('type') ?? node.children.find((c) => c?.type === 'type_name') ?? null;
    const name =
      node.childForFieldName('name') ?? node.children.find((c) => c?.type === 'identifier') ?? null;
    if (name !== null) {
      this.locals.push({
        name: name.text,
        typeName: type?.text ?? '',
        src: this.ref(name),
      });
      this.#skipNode(name);
    }
    for (const child of node.children) {
      if (child !== null) this.#visit(child, depth);
    }
  }

  /** `emit E(a, b)` and `revert Err(a)` — and bare `revert("reason")`. */
  #visitNamedStatement(node: TsNode, out: ParsedNameRef[], depth: number): void {
    const first = unwrap(namedChildren(node)[0] ?? null);
    if (first !== null) {
      // `emit L.E(...)` names the event with the trailing identifier.
      const nameNode =
        first.type === 'member_expression'
          ? (namedChildren(first).at(-1) ?? null)
          : first.type === 'identifier'
            ? first
            : null;
      if (nameNode !== null) {
        out.push({ name: nameNode.text, src: this.ref(node) });
        this.#skipNode(nameNode);
      }
    }
    for (const child of node.children) {
      if (child !== null) this.#visit(child, depth);
    }
  }

  // --- calls ------------------------------------------------------------

  #visitCall(node: TsNode, depth: number): void {
    const callee = unwrap(firstNamed(node));
    const shape =
      callee === null || this.#consumedCalls.has(node.id) ? null : this.#describeCallee(callee);

    if (shape !== null) {
      const argCount = node.children.filter((c) => c?.type === 'call_argument').length;
      this.calls.push({ ...shape.call, argCount, src: this.ref(node) });
      this.#applyCallFlags(shape.call);
      for (const consumed of shape.consumed) this.#skipNode(consumed);
    }

    for (const child of node.children) {
      if (child !== null) this.#visit(child, depth);
    }
  }

  #applyCallFlags(call: Omit<ParsedCall, 'src' | 'argCount'>): void {
    if (call.hasValueOption) this.flags.sendsValue = true;
    if (call.shape === 'new') {
      if (!ELEMENTARY_TYPE.test(call.name.trim())) this.flags.hasCreate = true;
      return;
    }
    if (call.shape === 'bare' && call.name === 'selfdestruct') {
      this.flags.hasSelfdestruct = true;
      return;
    }
    if (call.shape !== 'member' && call.shape !== 'expression') return;
    switch (call.name) {
      case 'delegatecall':
        this.flags.hasDelegatecall = true;
        break;
      case 'call':
      case 'staticcall':
      case 'callcode':
        this.flags.hasLowLevelCall = true;
        break;
      case 'transfer':
      case 'send':
        // Only value-bearing on an address; the resolver keeps the edge honest.
        this.flags.sendsValue = true;
        break;
      default:
        break;
    }
  }

  /**
   * Classify a callee expression into one of `CallShape`'s cases.
   *
   * The tricky case is `T(x).m()`: the receiver is itself a `call_expression`
   * with an identifier callee and exactly one argument, which is how a cast to
   * a user-defined type is spelled. It is reported as `shape: 'cast'` with the
   * type in `receiver` — but only the *resolver* decides whether `T` really
   * names a type, because a one-argument call to a function returning a
   * contract looks identical here.
   */
  #describeCallee(callee: TsNode): CalleeShape | null {
    let core = callee;
    let hasValueOption = false;
    let hasSaltOption = false;
    const visit: TsNode[] = [];

    if (core.type === 'struct_expression') {
      for (const field of core.children) {
        if (field === null || field.type !== 'struct_field_assignment') continue;
        const key = firstNamed(field);
        if (key?.text === 'value') hasValueOption = true;
        if (key?.text === 'salt') hasSaltOption = true;
        this.#skipNode(key);
      }
      const inner = unwrap(firstNamed(core));
      if (inner === null) return null;
      core = inner;
    }

    const base = { hasValueOption, hasSaltOption };

    if (core.type === 'new_expression') {
      const type = namedChildren(core)[0] ?? null;
      return {
        call: { shape: 'new', name: type?.text ?? '', receiver: null, ...base },
        consumed: [...this.#identifiersIn(type), ...visit],
        visit,
      };
    }

    if (core.type === 'identifier') {
      return {
        call: { shape: 'bare', name: core.text, receiver: null, ...base },
        consumed: [core],
        visit,
      };
    }

    if (core.type !== 'member_expression') {
      // `f()(x)`, `arr[i](x)`, a type cast used as a callee — target unknowable.
      return {
        call: { shape: 'expression', name: core.text, receiver: null, ...base },
        consumed: [],
        visit,
      };
    }

    const parts = namedChildren(core);
    const member = parts[parts.length - 1] ?? null;
    if (member === null) return null;
    const receiver = unwrap(parts.length > 1 ? (parts[0] ?? null) : null);
    const name = member.text;

    if (receiver === null) return null;

    if (receiver.type === 'identifier') {
      if (receiver.text === 'super') {
        return {
          call: { shape: 'super', name, receiver: null, ...base },
          consumed: [member, receiver],
          visit,
        };
      }
      if (receiver.text === 'this') {
        return {
          call: { shape: 'this', name, receiver: null, ...base },
          consumed: [member, receiver],
          visit,
        };
      }
      if (MUTATING_MEMBERS.has(name)) {
        // `deposits.push(x)` mutates `deposits`; the resolver drops the call
        // edge once it knows the receiver is not a contract.
        this.#record(receiver, true);
      }
      return {
        call: { shape: 'member', name, receiver: receiver.text, ...base },
        // The receiver stays a read: `token.mint()` does read `token`.
        consumed: [member],
        visit,
      };
    }

    const cast = this.#castTypeOf(receiver);
    if (cast !== null) {
      return {
        call: { shape: 'cast', name, receiver: cast.type, ...base },
        consumed: [member, ...cast.consumed],
        visit,
      };
    }

    return {
      call: { shape: 'expression', name, receiver: receiver.text, ...base },
      consumed: [member],
      visit,
    };
  }

  /** `IPair(x)` and `address(x)` — the two spellings of a cast receiver. */
  #castTypeOf(node: TsNode): { type: string; consumed: TsNode[] } | null {
    if (node.type === 'type_cast_expression') {
      const type = firstNamed(node);
      return type === null ? null : { type: type.text, consumed: [] };
    }
    if (node.type !== 'call_expression') return null;
    const callee = unwrap(firstNamed(node));
    if (callee === null || callee.type !== 'identifier') return null;
    const argCount = node.children.filter((c) => c?.type === 'call_argument').length;
    if (argCount !== 1) return null;
    this.#consumedCalls.add(node.id);
    return { type: callee.text, consumed: [callee] };
  }

  #identifiersIn(node: TsNode | null): TsNode[] {
    if (node === null) return [];
    const out: TsNode[] = [];
    const walk = (current: TsNode): void => {
      if (current.type === 'identifier') out.push(current);
      for (const child of current.children) if (child !== null) walk(child);
    };
    walk(node);
    return out;
  }
}

/**
 * Analyse one function body.
 *
 * Parameters and named returns are prepended to `locals` because they shadow
 * state variables in exactly the same way, and the resolver only ever asks
 * "is this name local to the function".
 */
export function analyseBody(
  positions: PositionIndex,
  body: TsNode | null,
  params: readonly ParsedParam[],
  returns: readonly ParsedParam[],
): BodyAnalysis {
  const walker = new BodyWalker(positions);

  const declared: ParsedLocal[] = [];
  for (const param of [...params, ...returns]) {
    if (param.name !== null && param.name !== '') {
      declared.push({ name: param.name, typeName: param.typeName, src: param.src });
    }
  }

  if (body !== null) walker.walkBody(body);

  return {
    calls: walker.calls,
    identifiers: walker.identifiers,
    emits: walker.emits,
    reverts: walker.reverts,
    locals: [...declared, ...walker.locals],
    flags: walker.flags,
    metrics: walker.metrics,
    tokens: walker.tokens,
  };
}
