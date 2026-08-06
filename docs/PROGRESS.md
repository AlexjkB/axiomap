# Progress

Phase log. Read first, written last. One entry per completed phase, appended at the end.
Current phase is whatever comes after the last entry here — do not infer it from the
codebase.

---

## Phase 0 — Scaffold

**Date:** 2026-07-29
**Status:** complete

### Exit criteria

| Criterion | Result |
|---|---|
| `pnpm build` green | pass — 4 packages, `tsc -b` via turbo |
| `pnpm test` green | pass — 18 tests (4 core, 14 repo-level) |
| A deliberately-introduced `core → webview` import fails CI | pass — verified twice: as a real file (`eslint` exits 1) and as a permanent regression test |
| A deliberately-staged file under `fixtures/client/` is blocked by the pre-commit hook | pass — hook exits 1, `git add -f` does not get around it |

### What was built

- pnpm workspace + Turborepo; four packages (`core`, `webview`, `cli`, `vscode`) wired as
  TypeScript project references matching the permitted dependency graph.
- Strict TS baseline in `tsconfig.base.json` — `strict`, plus
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`. Turning these on later
  is a rewrite; turning them off is one line.
- ESLint flat config with `@typescript-eslint/no-restricted-imports` enforcing §5's
  dependency directions, including relative-path escapes (`../../webview/src/...`), and
  `allowTypeImports` so `webview → core` is types-only.
- `test/dependency-direction.test.ts` — lints probe sources through the real flat config
  via `ESLint#lintText`. §6 says exit criteria are tests, not vibes, and a lint rule that
  silently stops matching is exactly the failure this guards against.
- `scripts/check-no-network-deps.mjs` — walks `@axiomap/core`'s production dependency tree
  and its own sources, fails on `http`/`https`/`net`/`dns`/`undici` (§3). Verified against
  a planted violation.
- `scripts/pre-commit-guard.mjs` + husky/lint-staged: blocks non-public `fixtures/`
  paths, files over 1 MB, and `.sol` outside `fixtures/` and `packages/*/test/`; warns on
  high-entropy strings and known key shapes. Advisory-with-override via
  `AXIOMAP_ALLOW_COMMIT=1`, per §5.
- `ensureAxiomapDir()` in core — writes `.axiomap/.gitignore` (`graph.json`, `cache/`,
  `*.tmp`; **not** `review.json`) on first run, idempotently, and repairs a modified one.
  This is the only real behaviour in Phase 0 and it has the only unit tests.
- GitHub Actions CI: `pnpm check` job + a separate zero-network-dependency job.
- Full §5 directory layout, MIT `LICENSE`, `.gitignore`, `fixtures/client/` ignored and
  hook-blocked.

### Deviations from the spec

- **`packages/webview/src/main.tsx` and `packages/vscode/src/{panel,navigation,codelens}.ts`
  were not created.** They cannot typecheck without React and `@types/vscode`, which are
  Phase 7 and Phase 8 dependencies. Their directories exist; `bridge.ts` and
  `extension.ts` are real stubs so the dependency-direction rules have something to bind
  to. No scope change, nothing deferred beyond the phase that already owned it.
- **Root-level `test/` directory**, not in the §5 layout. It holds invariants that span
  packages and therefore belong to none of them. `pnpm test` runs turbo first, then this.
- **`.turbo/` added to `.gitignore`** — build output the spec's list predates.
- **Branch renamed `master` → `main`** before the first commit, matching §7 Phase 9's
  branch-protection instruction.

### Appended to §16

Nothing.

### Notes for the next session

- Phase 1 is the parser bake-off. It writes `docs/decisions/0001-parser.md` and deletes
  the losing implementation — both, not just the first.
- `pathological/` is written in Phase 1 (§14), not Phase 4.
- The pre-commit guard's `.sol` rule allows `fixtures/` and `packages/*/test/` only. Phase
  1 fixtures land in `fixtures/`, so this should not bite, but it is the rule to look at
  first if a commit is refused.

---

## Phase 1 — Parsing & symbol table

**Date:** 2026-07-29
**Status:** complete. `pnpm check` and `pnpm check:network` both green.

### Exit criteria

| Criterion | Result |
|---|---|
| Symbol table for all fixtures with hand-verified contract/function counts | pass — `packages/core/test/symbols.test.ts`. Counts for `minimal/` and `defi/` were derived by reading the sources and are commented with their derivation; `inheritance/` vendors OpenZeppelin so its hand-written contracts are asserted exactly and the vendored part structurally |
| Benchmark documented | pass — `docs/decisions/0001-parser.md`, with raw measurements in `0001-parser.json` |
| Parser choice committed | pass — **tree-sitter**. `parse/antlr.ts` and `@solidity-parser/parser` are deleted; the ADR records the decision and its consequences |

`pnpm check` is green: 8 turbo tasks, 103 tests — 89 in `core`, 14 repo-level. Three of
the core tests exercise the real worker threads and skip themselves when `dist/` is
absent; `pnpm check` builds first, so they run.

The core test count fell from 113 when the second backend went: every parser suite ran
twice by construction, and the 18-case `backend equivalence` sweep had nothing left to
compare. That sweep was worth its keep — it caught three real bugs in the tree-sitter
converter, all of them anonymous tokens in the grammar that a `namedChildren` walk misses
(parameter storage locations, `struct_member` ranges including their terminator, and
constructor visibility). It is replaced by a clean-parse sweep over the same fixture list.

### The bake-off

Full numbers in the ADR. Headline, on 911 files / 200,129 SLOC:

| Configuration | `@solidity-parser/parser` | `tree-sitter-solidity` |
|---|---|---|
| single-threaded cold | 72,141 ms | 4,545 ms |
| parallel cold | 27,778 ms | 1,925 ms |
| parallel warm (the §7 gate) | 612 ms | 612 ms |

Both pass the stated gate — warm is a dead tie because a warm run is disk-cache I/O, not
parsing. Everything that distinguishes them is elsewhere:

- **Cold parse is ~15× apart**, and cold is not a rare case. §8 makes diff a day-one
  constraint, and `axiomap diff` graphs a second git revision, which is always cold. On
  these numbers ANTLR makes a 200k-SLOC diff a ~28 s operation and tree-sitter makes it
  ~2 s.
- **Error recovery is not close.** On `pathological/src/SyntaxError.sol` — three contracts,
  syntax error inside the second — tree-sitter recovers all three. ANTLR's tolerant mode
  recovers nothing at all, not even the `pragma` on line 2. Decision #1 is the product, so
  this is the criterion a throughput number should not outvote.
- **Two costs favour ANTLR and no timer shows them.** `tree-sitter` builds through
  `node-gyp` and needs per-platform prebuilds in a `.vsix`. And
  `tree-sitter-solidity@1.2.13` lists **`yarn` in its runtime `dependencies`**, which drags
  `http`/`https`/`net`/`dns` into `@axiomap/core`'s production tree.

**Decision: tree-sitter**, running on `web-tree-sitter` over a vendored grammar `.wasm`
rather than the native binding. Recovery decided the backend; throughput agreed. Written
up in the ADR.

The WASM packaging was adopted to clear two problems the native binding brought — a
`node-gyp` build with per-platform prebuilds in the `.vsix`, and `tree-sitter-solidity`
listing `yarn` in its runtime dependencies, which put `http`/`https`/`net`/`dns` in
`@axiomap/core`'s production tree and failed §3's gate. Both are gone. **`@axiomap/core`'s
entire production dependency tree is now two pure-WASM packages** — `web-tree-sitter` and
`xxhash-wasm` — with no transitive dependencies of their own, which is a good thing to be
able to show an auditor.

**It was also expected to cost 1.5–2× throughput and instead gained ~1.5×**, on the same
fixture and host: single-cold 4,545 → 2,938 ms, parallel-cold 1,925 → 1,231 ms, warm
612 → 427 ms. The prediction was wrong. The likely reason is that this workload is
dominated by tree *walking* rather than parsing — the converter touches `type`, `text`,
`children` and `childForFieldName` on every node, and each crosses the N-API boundary in
the native binding. That reading is not profiled, but the direction reproduces across runs.

### What was built

- **`parse/`** — `interface.ts` (the seam), `positions.ts`, both backends, `cache.ts`,
  `workers.ts` + `worker-entry.ts`.
  - `PositionIndex` converts UTF-16 indices to byte offsets once, for both backends, so
    they cannot disagree. §10's warning about non-ASCII files is guarded by
    `pathological/src/Crlf.sol`, which is CRLF-terminated *and* multi-byte.
  - The pool round-robins files across workers and falls back to inline parsing when no
    built worker entry exists (which is the case under vitest's TS transform).
    `test/workers.test.ts` points it at `dist/` so the threaded path is covered too.
- **`project/`** — `detect.ts`, `foundry.ts`, `hardhat.ts`, `remappings.ts`, `imports.ts`,
  plus a small `toml.ts`.
  - Hardhat configs are parsed, never executed; there is a test whose config calls
    `process.exit(99)` to prove it.
  - Foundry's *implicit* `lib/<name>/ -> <name>/` remappings are reproduced. Real projects
    rely on these without writing them down.
- **`symbols/`** — `ids.ts`, `table.ts`, `version.ts`, `build.ts`. IDs follow §8's three
  worked examples and extend the same grammar to the namespaces §8 does not name.
- **Fixtures** — all five. `minimal/`, `defi/`, `pathological/` and the hand-written half
  of `inheritance/` are original; `inheritance/lib/` vendors 25 OpenZeppelin files (MIT,
  per §14).

### Deviations from the spec

- **The `SolidityParser` interface is declaration-level only.** No expressions, no call
  sites, none of §10's `flags`. Those are what Phase 2 resolves, and building them twice —
  once per backend — would pay the bake-off cost twice for information the bake-off does
  not use. Phase 2 extends the interface against whichever backend wins. This is
  sequencing, not scope: nothing is dropped.
- **`fixtures/large/` is a committed generator, not committed output.** §5 marks the
  directory tracked; its output is ~8 MB of derived Solidity across 911 files, which is
  what the pre-commit size guard exists to keep out of history. `generate.mjs` is seeded
  and reproduces byte-identically, which is what a benchmark actually needs.
  `fixtures/large/generated/` is gitignored and `pnpm bench:parser` creates it on demand.
- **`src/ingest.ts` is not in §5's layout.** The layout names directories; this is the one
  function that composes `parse/`, `project/` and `symbols/`, and putting it inside any of
  them would make that directory depend on the other two.
- **`turbo.json`'s `test` task now depends on `build`, not `^build`.** `test/workers.test.ts`
  needs this package's own `dist/` to exercise the real worker entry.
- **The version policy classifies on the *highest* version a pragma admits, not the
  lowest.** Written the other way first, which reported most of OpenZeppelin as below §4's
  0.5 hard floor — `pragma solidity >=0.4.16;` is unbounded above, and solc compiles those
  files at 0.8. A pinned or bounded old version still downgrades, which is the case §4
  actually cares about.

### §16 changes

- **Added then removed** the `web-tree-sitter` + vendored WASM entry. It was appended as a
  Tier 1 deferral while the bake-off was open, and implemented once tree-sitter won, so it
  no longer belongs in a backlog of what was deliberately left out.
- **"Incremental reparse on keystroke"** lost its "depends on which parser wins" blocker
  and is now gated on need alone.

### Notes for the next session

- **`createParser` is async now** — the WASM grammar has to be compiled before a parser
  exists. `SolidityParser.parse` is still synchronous, and the grammar load is memoised
  per process, so the cost lands once per thread rather than once per file. Phase 2 will
  add call sites; they need `await`.
- **The grammar `.wasm` lives in `packages/core/vendor/`** and is resolved with one
  module-relative path that works from both `src/parse/` and `dist/parse/`, because they
  sit at the same depth under the package root. `vendor/` is in the package's `files`.
  `test/parse.test.ts` asserts both facts — a packaging mistake here would otherwise
  surface as "every parse returns nothing" on a user's machine rather than in CI.
- **`web-tree-sitter` ships its own runtime `.wasm` inside `node_modules`**, separate from
  the grammar. It resolves fine for the CLI and tests. Bundling it into a `.vsix` is
  Phase 8's problem and is worth checking early there.
- `bench-parser.mjs` is no longer a bake-off. It is a single-backend harness that asserts
  §9's standing warm budget and exits non-zero on a miss, writing `docs/perf/ingest.json`.
  `docs/decisions/0001-parser.md` is frozen and no longer generated. §6's command table
  still describes the old behaviour.
- §14 wants `defi/` committed twice as two git tags with a hand-authored changeset between
  them. Not done — the changeset needs to be designed against the diff engine it exists to
  test, which is Phase 5. The fixture content is in place and ready to be tagged.
- `pathological/src/SyntaxError.sol` and `DoesNotCompile.sol` are load-bearing, not
  decoration. The first is the recovery benchmark; the second is decision #1 in one file.
  Neither should be "fixed".

---

## Phase 2 — Heuristic resolution & graph construction

**Date:** 2026-08-03
**Status:** complete. `pnpm check` and `pnpm check:network` both green.

### Exit criteria

| Criterion | Result |
|---|---|
| `graph.json` committed per fixture | pass — `packages/core/test/golden/`, four fixtures. Three are committed whole; `inheritance/` is committed for its hand-written `src/` plus a counts summary for the vendored OpenZeppelin subtree, for the reason below |
| Diffed on every run | pass — `test/golden.test.ts` runs inside `pnpm test`, and `pnpm test:golden` runs it alone (§6's command table already named it). Verified it fails on drift by mutating one committed edge and watching the suite go red |
| All node kinds | pass — every §10 kind appears in `minimal/` |
| All edge kinds | pass — all eleven appear in `minimal/`, asserted as an exact sorted list in `resolve.test.ts` so a new kind cannot appear unannounced |
| Resolution confidence tagging | pass — all four values produced and asserted, each with a `reason` on the two uncertain ones |
| Stable IDs | pass — unchanged from Phase 1's `symbols/ids.ts`; the graph keys on them directly |
| Body hashes | pass — `bodyHash` and `interfaceHash` on every function node, with tests for what must and must not change them |
| Serialization | pass — `graph/serialize.ts`, deterministic and byte-identical across builds, with `schemaVersion` refusal |

`pnpm check` is green: 165 tests in `core` (89 from Phase 1, 76 new) and 14 repo-level.

### The resolution score, measured

§16's open question — "what is an acceptable resolution score floor?" — is answered and
struck from the spec. Measured on all four fixtures with no build artifacts:

| Fixture | call edges | confident | overall | mode |
|---|---|---|---|---|
| `minimal/` | 8 | 75% | 94% | heuristic |
| `inheritance/` | 225 | 88% | 94% | heuristic |
| `defi/` | 43 | **98%** | 99% | heuristic |
| `pathological/` | 6 | 50% | 90% | **structural** |

`defi/` clears §16's 85% working assumption comfortably. But **the assumption itself was
wrong as a threshold**: at 85%, `minimal/` — five hand-written contracts whose only two
failures are a deliberate `.call{value:}` and a deliberate `.delegatecall` — would have
fallen into structural mode. The ratio is unstable on small inputs, so the threshold is set
at **70% of call edges** and the small-project floor that would fix the instability
properly is in §16 rather than guessed at here.

Two scores are computed, not one. `overall` covers every edge that required resolving a
name and is the number §4 prints; `calls` covers `calls` and `creates` only and is the one
that selects the mode, because structural mode drops exactly those kinds. Inheritance and
state access resolve near-perfectly, and folding them into the gate would mask a resolver
that had failed at the hard part.

Every fixture's unresolved edges were read individually. They are: low-level `call` and
`delegatecall` (target chosen at runtime), one function pointer, one
`abi.encodeWithSelector`, one call to a function that genuinely does not exist, and
eleven OpenZeppelin `using`-for calls on expression receivers. All are correct answers.
Two resolver bugs *were* found this way and fixed — `new bytes(n)` counted as contract
creation, and `MyType.wrap(x)` on a user-defined value type reported as an unresolved
call — which is the argument for reading the list rather than trusting the percentage.

### What was built

- **`parse/interface.ts` extended additively**, exactly as Phase 1 planned it. `ParsedFunction`
  gained call sites, identifier uses, emits, reverts, locals, flags, metrics and the two
  hashes. Nothing declaration-level changed shape. `PARSE_SCHEMA_VERSION` is 2, so every
  cached parse from Phase 1 invalidates rather than deserialising into the new type.
- **`parse/treesitter-bodies.ts`** — the body walker. Records what was *written*, never what
  it means: `IPair(x).mint()` is "a cast-shaped call named `mint` on type `IPair`", and the
  resolver decides whether `IPair` is even a type. The parser cannot tell `Deposit({...})`
  from `scale(a, b)` and does not try.
- **`resolve/scope.ts`** — file scope (own exports, aliased imports, `import * as`, bare
  imports) and C3 linearization in Solidity's spelling: bases merge right to left, so
  `is B, C` gives `[D, C, B, A]` and `is C, B` gives `[E, B, C, A]`. `inheritance/src/Diamond.sol`
  has both on purpose and both are asserted. A chain that cannot be merged is marked
  `ambiguous` and every `super` edge through it is downgraded to match.
- **`resolve/index.ts`** — the resolver. Seven call shapes, `using`-for attachment, public
  getter calls, base-constructor invocations that parse as modifiers, interface calls with
  `possibleTargets` and `crossTrustBoundary`, and state access with local shadowing.
- **`graph/schema.ts`** — zod as the source of truth, TypeScript inferred from it. The
  alternative fails in the direction that matters: a field added to the type but not the
  schema is written and then rejected on read.
- **`graph/{build,score,serialize,hash}.ts`** — graphology assembly with §10's call-site
  collapsing, the three modes, deterministic output, and §8's hashes.

### Deviations from the spec

All nine were reviewed at the phase boundary and none were reverted; §4, §5, §7, §10 and
§14 were amended so the spec states what the code does. Where the spec now covers it, the
entry says so.

- **A tenth node kind, `Unresolved`, not in §10's list.** *(§10 amended.)* §4 makes
  `unresolved` a first-class answer and "show me every unresolved external call" one of
  the most valuable queries in the tool — but an edge needs two endpoints. Unresolved
  calls point at a synthetic node named for the callee (`?call`, `?transform`), marked
  `synthetic: true` and carrying the reason. §10's list is of *declaration* kinds and a
  placeholder is not one. The alternative, hiding unresolved calls on a node attribute,
  would make the single most valuable query the only one that is not a graph query.
- **`inheritance/`'s golden is committed filtered.** *(§14 amended.)* Its full graph
  serializes to ~1.2 MB — over this repo's own pre-commit size guard, and far past the
  point where anyone reads the diff, which is the only thing that makes a golden useful.
  The hand-written `src/` contracts are committed whole; the 25 vendored OpenZeppelin
  files are pinned by a counts summary (nodes by kind, edges by kind, edges by
  resolution). A change in how OpenZeppelin resolves still fails the build; it fails as
  four numbers instead of forty thousand lines.
- **`ParsedFunctionFlags` carries two fields beyond §10** *(§10 amended)*,
  `assemblyReadsState` and `assemblyWritesState`. A `sstore` inside an `assembly` block
  touches storage without naming a variable the resolver could bind, and without them
  `Proxy.fallback()` would report `writesState: false` — wrong in exactly the file where
  it matters most. The graph ORs them into §10's two booleans and nothing else reads them.
- **Hashes are computed during the parse, though they live in `graph/hash.ts`** *(§5
  amended)* as §5's layout says. Computing them later would mean either keeping normalised
  body text in the disk cache (which would multiply its size) or re-reading every file.
  `parse/treesitter.ts` calls into `graph/hash.ts`; the definition of "the same body"
  stays in one file, in the directory §5 names.
- **C3 linearization is implemented in `resolve/`, though §7 lists it as a Phase 4
  analysis pass.** *(§7 amended; state access and cyclomatic complexity moved for the same
  reason.)* `super` dispatch cannot be resolved without it and §4 says so explicitly.
  Phase 4's pass should surface it over the graph — `linearizedBases` and
  `linearizationCertainty` are already on every contract node — rather than compute it a
  second time.
- **The score weights a collapsed edge by its call-site count.** *(§4 amended.)* §10
  collapses twenty calls to `_mint` into one edge; the score still counts twenty, because
  twenty unresolved call sites is twenty unresolved call sites and collapsing them would
  flatter the number.
- **`inherits` is emitted for every base; `implements` and `overrides` are
  function-level.** *(§10 amended.)* §10 lists all three without saying which level
  `implements` belongs to. A base that is an interface still gets `inherits` (it is the
  relation that carries `linearizationIndex`), and a function implementing an interface
  function gets `implements` while one overriding a base *with a body* gets `overrides`.
  That split is the one an auditor asks for.
- **`FileSymbols` gained `bareImports`.** `import "path"` pulls in every top-level name of
  the target, and Phase 1's `imports` array could not distinguish it after the fact.
- **`pnpm bench:parser` now times the graph build too.** §9's budget is "parsed **and
  graphed** in under 5 seconds warm", which was not measurable until this phase. Parse and
  graph are reported separately, since resolution is single-threaded and the parse is not.

### Performance

200,129 SLOC across 911 files, same host as Phase 1:

| Configuration | parse | graph | total |
|---|---|---|---|
| single-cold | 7,550 ms | 875 ms | 8,424 ms |
| parallel-cold | 3,197 ms | 802 ms | 3,999 ms |
| parallel-warm | 1,023 ms | 820 ms | **1,799 ms** |

§9's warm budget passes with the graph included, at about a third of it. **Parsing did get
substantially slower** — single-cold was 2,938 ms in Phase 1 — and that is expected rather
than a regression to chase: Phase 1 walked declarations only, and this phase walks every
statement and expression in every body. Warm went 427 → 1,023 ms for a related reason: the
cached parse result now carries call sites and identifier uses, so there is more JSON to
read back. The whole pipeline still lands well inside budget, so no optimisation work was
done; the numbers are recorded so a future regression has a baseline.

### §16 changes

- **Answered and struck the open question** on the resolution score floor, with the measured
  table and the note that the 85% working assumption would have been wrong.
- **Added Tier 2 — attached-library calls on expression receivers.** The largest unresolved
  bucket (11 of 15 on `inheritance/`). Resolving it is the same type-inference work item as
  overload resolution, and they should be done together.
- **Added Tier 2 — file-level `using ... for ... global` directives.** Not collected by the
  parser; no fixture uses one, and adding it untested would put untested code in the
  resolution path.
- **Added Tier 2 — a small-project floor for the mode threshold**, with `minimal/` at 75% as
  the motivating data point.
- **Noted on the existing overload/selector entry** that its "instrument why" trigger is
  already satisfied: every ambiguous and unresolved edge carries a `reason`.

### Long-term hardening, after the deviation review

Four changes made at the phase boundary, all in the same class: cheap now, expensive once
Phase 3 exists. Phase 3's exit criterion is *"the graph is identical in shape to the
heuristic-only graph"*, so anything that rewrites goldens has to land before that baseline
is being compared against — otherwise the baseline and the test move in the same step,
which is the situation §6's rule about goldens exists to prevent.

- **The artifact is 45% smaller.** At 200k SLOC `graph.json` was **78 MB**; it is now
  **42.8 MB** on disk, with nothing lost. Three parts: `edge.src` is not stored (it is
  `sites[0]` for every edge ever produced — verified across all 74,512), fields holding
  their schema default are not stored, and `.axiomap/graph.json` is written compact while
  goldens stay indented for the diff a human reads. `edge.id` is deliberately still stored:
  it is identity rather than an alias, and this is a public artifact people script against.
  A round-trip test asserts `parse(serialize(g))` deep-equals `g` for every fixture, which
  is what stops the serializer and the schema from drifting apart and losing a field
  silently.
- **Serialization no longer depends on object key insertion order.** `build.ts` adds
  optional fields through conditional spreads, so a node's byte layout depended on which
  optional fields it happened to have. Keys are now emitted in a fixed order, then
  alphabetically. Without this a refactor of an object literal reorders every golden, and a
  golden that reorders itself is one people learn to regenerate without reading.
- **A bodyless declaration has no `bodyHash`** — an empty string, not the hash of nothing.
  §8 matches a moved or renamed function by body hash, and every bodyless declaration
  hashing identically made them all mutual rename candidates: 10 of 39 functions on `defi/`,
  16 of 277 on `inheritance/`. This was the largest degenerate collision group in both
  fixtures, and it would have been the diff engine's biggest source of false positives
  before it was written. Changing it later would mean bumping `HASH_VERSION`, which
  invalidates every stored review — this phase was the last free window.
- **Synthetic `Unresolved` ids carry their failure category**: `?low-level:call`,
  `?function-pointer:transform`, `?not-found:undeclaredHelper`, from a closed five-value
  set on the node. Keyed on the bare name, an unresolvable `.call` and an ordinary missing
  function named `call` collapsed onto one node keeping whichever explanation was written
  first — and `call` is a common enough function name that this was when, not if. The
  category also turns §16's "instrument *why* edges are unresolved" into a count over
  categories, and lets §15's CI query fail on a new `?low-level:*` while ignoring churn
  elsewhere. Kept project-wide rather than per-caller: these nodes have no outgoing edges
  by construction, so a hop-limited traversal reaches one and stops, and project-wide is
  what keeps a diff clean — a new low-level call is one new *edge* to an existing node,
  not an added node and an added edge, and a rename does not churn a synthetic pair
  alongside the real one.
- **Params carry `indexed` and `storageLocation`.** Flipping `indexed` on an event
  parameter changes the ABI and breaks every log consumer, which is a §8 breaking change
  rather than a re-review trigger. Both hold their default on most parameters, so the
  serializer drops them and they cost nothing at rest.

The golden regeneration was verified rather than trusted: node and edge counts, every
edge's `(kind, subkind, from, to, resolution, count)`, and the resolution score are all
identical across the four fixtures, and the only `bodyHash` changes are exactly the
bodyless functions.

### Pre-Phase-3 audit

Phase 2 is what every later phase reads, so it was audited rather than declared done.
Coverage over `resolve/`, `graph/` and the body walker found the branches no test reached;
writing tests for them found two bugs that all four fixtures had missed.

**Two real bugs, both invisible to the goldens:**

- **A cast receiver was recorded twice.** `T(x).m()` spells the cast as a call, so the walk
  reached the inner `T(x)` again and recorded a second, bare call to `T`. Harmless whenever
  `T` is a known contract — the resolver discards it as a type conversion — and a spurious
  unresolved edge whenever it is not. Every fixture casts to a known type, so nothing caught
  it. Fixed by marking a cast's call expression consumed.
- **A cyclic inheritance chain listed a contract twice.** The cycle guard returns
  `[contract.id]` for a contract already being linearized, and that entry flowed back up into
  its own chain, so `A is B, B is A` produced `linearizedBases: [A, B, A]`. Phase 4 consumes
  this array rather than recomputing it. Fixed by deduplicating unconditionally.

**Coverage of the Phase 2 modules went 90.2% → 97.1% of statements, and 98.3% → 100% of
functions.** 16 new tests in `test/resolve-edges.test.ts` cover what no fixture reaches:
`this.f()`, `import * as` namespaces, bare imports, `using {f} for T`, a cast to an unknown
type, a local function pointer, unknown modifiers, events and errors, `super` with nothing
to dispatch to, members with no using-for attachment, missing members on a known contract —
and the malformed hierarchies a tolerant parse can produce but solc would reject outright:
a cycle, a contract inheriting itself, and a C3 merge that cannot be completed. The
requirement for those three is not that they resolve; it is that they terminate, say they
are uncertain, and invent nothing.

**Three properties are now tests rather than assumptions:**

- **The graph is byte-identical however many workers parsed it.** The goldens are all built
  single-threaded, so nothing would have noticed if the parallel path — the one every real
  `axiomap build` uses — diverged. It would have surfaced as `axiomap diff` reporting phantom
  changes because two revisions were parsed by different worker counts. It holds today;
  now it stays holding.
- **The graph is byte-identical warm or cold.** The disk cache returns a deserialized parse
  result, so a field that did not survive the JSON round-trip would make a cached build
  differ from the cold build the goldens pin.
- **`pathological/` has a second golden with the mode gate disabled.** It resolves below the
  threshold, so its committed graph is structural and contains no call edges at all — the
  one adversarial fixture's call resolution was pinned by nothing. `pathological.ungated.graph.json`
  now pins all six, including the function pointer, the selector dispatch and the low-level
  call.

`pnpm test:coverage` was added to §6's command table, framed as what it is: a way to find
branches no test reaches, not a number to move.

**Two gaps closed in the spec rather than the code:** §10 lists `natspec` on Contract and it
is not implemented — that was a silent gap between spec and code, now an explicit §16 entry
with its trigger. Nested namespace member calls (`H.Helpers.twice(a)`) resolve as
`dynamic-receiver`; the single-level form works, and the nested form is a §16 entry rather
than an undocumented limitation.

**§7's Phase 3 exit criterion now defines "identical in shape".** It was one sentence that
three different tests could have interpreted three ways. Shape is the node set plus the edge
set keyed by `(kind, subkind, from, to)`, against `test/golden/defi.graph.json` as the
baseline. The important half is the constraint it implies: **enrichment upgrades edges, it
does not discover them.** A solc AST yields call sites the heuristic tier deliberately drops
— type conversions, struct construction, `abi.*`, array members, `new bytes(n)` — and a
Phase 3 that walks every `FunctionCall` node will add edges Phase 2 never had and fail the
criterion for a reason that is not a resolver bug.

### Notes for the next session

- **Phase 3's exit criterion is a shape comparison**, and the heuristic graph it compares
  against is now committed. `defi/` must reach >95% semantic with artifacts *and* be
  identical in shape to `packages/core/test/golden/defi.graph.json`. Any structural
  difference is a heuristic-resolver bug to fix, not a golden to regenerate.
- **The `enrich/`-stubbed-out test §7 asks for is not written yet** — it belongs to Phase 3,
  since there is nothing to stub until `enrich/` exists. The property it guards already
  holds: `buildProjectGraph` never touches a compiler.
- **`selectMode` returns `full` as soon as one semantic edge exists.** That is the seam
  Phase 3 lands in; the mode copy is already written for it.
- `pathological/src/Indirect.sol` documents an overload pair whose ambiguity "the resolver
  must emit" — but the fixture never actually calls `pick`. Overload ambiguity is covered by
  `inheritance/` (13 real OpenZeppelin cases) and by an inline temp project in
  `resolve.test.ts`. Adding the missing call site to the fixture would change the counts
  Phase 1's `symbols.test.ts` asserts, so it was left alone deliberately.

---

## Phase 3 — Semantic enrichment

**Date:** 2026-08-03
**Status:** complete. `pnpm check` and `pnpm check:network` both green.

### Exit criteria

| Criterion | Result |
|---|---|
| On `defi/` with artifacts, resolution score exceeds 95% semantic | pass — **99%** (138 of 139 weighted edges). The one remainder is the `token.call(...)` in `SafeTransfer`, whose target is chosen at runtime; a compiler does not help with it and must not appear to. `test/enrich.test.ts` |
| The graph is *identical in shape* to the heuristic-only graph | pass — node set and edge set keyed by `(kind, subkind, from, to)` are equal to `test/golden/defi.graph.json`. Asserted twice: once on §7's shape definition, once field-by-field with only `resolution`, `possibleTargets`, `reason`, `selector`, `slot` and `offset` set aside |
| Any structural difference is a heuristic-resolver bug; fix it | pass — there were none. A compiler binding that disagrees with a heuristic edge now emits a `warning` diagnostic, and `defi/` produces zero |
| With `enrich/` stubbed out entirely, the full pipeline still builds a graph for every fixture | pass — `test/enrich-stub.test.ts`, four fixtures. **Keep this test forever** (§7) |
| Detect build-info: Foundry `out/build-info/`, Hardhat `artifacts/build-info/` | pass — both, and both probed whatever the detected project kind |
| Upgrade edges via `referencedDeclaration` | pass — every edge kind that required resolving a name reaches `semantic` on `defi/` |
| Selectors and storage layout where available | pass — `selector` on functions and public getters, `slot`/`offset` on state variables, both absent rather than null when the compiler did not supply them |
| Multiple solc versions in one project | pass — `test/enrich-artifacts.test.ts`, a 0.7.6 file and a 0.8.20 file with one build-info each |
| Degrades silently to zero when nothing compiles | pass — `minimal/`, `inheritance/` and `pathological/` build byte-identically with the tier enabled and disabled |

`pnpm check` is green: 218 tests in `core` (165 from Phase 2, 53 new) and 14 repo-level.

### `defi/`, both ways

| | mode | edges | semantic | heuristic | unresolved |
|---|---|---|---|---|---|
| no artifacts | heuristic | 139 | 0 | 138 | 1 |
| with artifacts | **full** | 139 | **138** | 0 | 1 |

Same 139 edges, same endpoints, same call sites. That is the whole criterion: enrichment
changed what the graph *claims to know*, not what it knows about.

### What was built

- **`enrich/buildinfo.ts`** — discovery and reading. A build-info file is the solc standard
  JSON input and output together, which is the only artifact carrying all three things this
  tier needs: ASTs with `referencedDeclaration`, the source text they were built from, and
  storage layouts. Foundry and Hardhat write the same file with a different `_format`, so
  both are read the same way. Parsing is hand-rolled rather than a zod schema on purpose —
  this is someone else's artifact in a format that varies by toolchain and version, and the
  useful behaviour is to take the fields that are there.
- **`enrich/solc-ast.ts`** — the AST reader. Reference sites keyed by byte offset,
  relations (`baseContracts`, `baseFunctions`, `modifiers`), selectors, storage slots.
- **`enrich/index.ts`** — coverage decided per file, then the two index passes.
- **`graph/semantic.ts`** — the seam and the application. The interface lives in `graph/`
  and the implementation in `enrich/`, so the graph consumes the semantic tier without
  importing it: `enrich/` can be deleted and this file still compiles.

### The join is a byte offset, and that is the whole trick

Both sides already speak byte offsets — solc's `src` is `"start:length:sourceIndex"` in
bytes, and Phase 1's `PositionIndex` converted the parse to bytes for this exact reason —
so a call site the heuristic tier found and the same call site in the AST agree on a
number. No name matching, no scope walking, no signature canonicalisation. §10's warning
about `src` was protecting this.

Two details were not free:

- **One offset hosts several references.** In `token0.safeTransfer(to, amount)` the
  identifier `token0`, the member access, and the call all start at the same byte. Indexed
  naively, the `reads` edge for `token0` matches the library function and gets "corrected"
  onto it — five of these on `defi/` in the first draft. References are therefore filed by
  what they *are* (`variable`, `call`, `emit`, `revert`) and looked up by what the edge
  kind needs.
- **The callee of a call is not "the first `referencedDeclaration` underneath it".**
  Following the receiver turns `token.call(data)` — honestly `unresolved`, because `.call`
  is a builtin with no declaration — into a confident edge pointing at the *variable*
  `token`. The unwrap follows `FunctionCallOptions` and `NewExpression` and stops.

Four edge kinds have no site to look up: an `inherits` draft carries the contract's own
`SourceRef`, not the name in the `is` clause, and `implements`/`overrides`/`modifiedBy` are
the same. Those are confirmed as *relations* from `baseContracts`, `baseFunctions` and
`modifiers` — which is solc's own answer to the question, and covers §10's
`overrides`/`implements` split in one list.

### Stale artifacts are the failure mode that matters

Enrichment joins on byte offsets, so an artifact built from a different revision of a file
does not produce a missing upgrade — it produces a *confident edge pointing at the wrong
function* and a click that lands in the wrong place. A half-stale artifact set is also the
normal state of a working tree: you edit one file and the other forty are still current.

So coverage is per file, and a file is covered only if the compiler's copy of the source is
byte-identical to what is on disk. Bytes, not strings: a comparison that normalised line
endings would accept an artifact whose every offset past the first newline is wrong, which
is the same class of bug `pathological/src/Crlf.sol` exists to catch in the parser.

### Deviations from the spec

- **`solc-typed-ast` is not used, and direct solc invocation is deferred.** *(§3's stack row
  and §7's Phase 3 amended; §16 entry added.)* §7 offered "detect build-info … **or** invoke
  solc directly via `solc-typed-ast`". That library downloads compiler binaries, so adding
  it to `@axiomap/core` would put `http`/`https` in the production dependency tree and fail
  §3's own CI gate — the zero-network invariant, which is a security property the README is
  meant to be able to point at, not a convention. Reading the standard-JSON ASTs that
  Foundry and Hardhat already write gets the same information with **no new dependency at
  all**: core's production tree is still two pure-WASM packages. The gap this leaves is a
  compilable project with no artifacts, where the answer is `forge build --build-info`;
  §16 records it with a trigger.
- **`GRAPH_SCHEMA_VERSION` is 2.** `selector`, `slot`, `offset` and `generator.compilers`
  are all optional and all absent without artifacts, so the four uncompiled goldens differ
  from Phase 2's by exactly one line — verified before regenerating, per §6. The bump is
  not decoration: a v1 reader handed a v2 graph would strip the new fields silently, and
  refusing a mismatch is the direction the version exists to protect.
- **The goldens are now built with enrichment off, and `defi/` has a second golden.**
  `defi/` ships artifacts, so an ordinary build of it is a semantic graph — without this
  every suite sharing those graphs would silently be testing the wrong tier. The heuristic
  graph is what §7 makes the baseline, so it stays the golden; `defi.enriched.graph.json`
  pins the other side, including every selector and every storage slot.
- **`fixtures/defi/out/build-info/*.json` is committed** (513 KB, under the pre-commit size
  guard), and the rest of `out/` is gitignored. CI has no solc, and a fixture whose expected
  output depends on a compiler being installed fails for a reason nobody can read from the
  diff. The three absolute paths forge writes into `input.allowPaths`/`basePath`/
  `includePaths` were scrubbed before committing — nothing reads them, and they should not
  be baked into a public repo.
- **A failure inside the semantic tier is caught and degraded**, not propagated. This came
  out of writing the stub test: with the stub throwing, `ingest.ts` failed the whole build,
  which means the pipeline *did* hard-depend on `enrich/` being present and working. It
  now catches, emits a warning diagnostic, and returns the syntactic graph. That is
  decision #1 in one statement — nothing this tier can do may cost the user the graph they
  would have had without it.
- **`SemanticOverlayLoad.overlay` is nullable** rather than the load being null. Artifacts
  that exist but are unusable — stale, truncated, compiled without ASTs — have something to
  say, and returning nothing would swallow exactly the diagnostic a user needs.

### §16 changes

- **Added Tier 1 — invoking a compiler rather than reading what one already wrote**, with
  the zero-network reasoning and `loadSemanticOverlay`'s interface as the seam.
- **Added Tier 1 — storage layout beyond a `slot` per variable**: the `types` half of
  `storageLayout` (packing, mapping and array slot derivation, struct offsets), which is
  input to the existing proxy/storage entry rather than a thing on its own.

### Notes for the next session

- **Phase 4 consumes, it does not recompute.** As with Phase 2's C3 linearization and state
  access: `selector` and `slot`/`offset` are on the nodes, and `resolution === 'semantic'`
  is how an analysis pass knows an edge is certain rather than inferred.
- **`selectMode` returns `full` on the first semantic edge**, which is now reachable. The
  copy was already written for it in Phase 2.
- **Foundry only writes `storageLayout` when asked** (`--extra-output storageLayout`, as
  the committed fixture artifact was). Hardhat includes it by default. Absent layout means
  no slots and nothing else.
- The `enrich/`-stubbed test has a second half that is easy to overlook: no module outside
  `enrich/` may import it at runtime, except `ingest.ts`. A type-only import is fine and is
  how `graph/` names the seam. If that assertion ever fails, the behavioural half has
  probably stopped meaning anything too.

### Pre-Phase-4 audit

Phase 3 was audited at the boundary the same way Phase 2 was, and for the same reason: it
is what every later phase reads. Coverage over `enrich/` and `graph/semantic.ts` found the
branches no test reached; probing the two properties Phase 2's audit had established for
the syntactic graph — determinism and round-trip — found **two real bugs, both invisible to
every test and both golden-clean**.

- **Build-info discovery was ordered by mtime.** Ordering decides which artifact owns a
  source when two of them cover it, and mtimes come from whenever a checkout happened to
  write the file. So a graph built from a fresh clone could differ from one built in place,
  and `axiomap diff` would report the difference as a change in the code — the same failure
  the "byte-identical however many workers" test exists to prevent, arriving by another
  route. Now sorted by path. Nothing is lost: an artifact is only used for a source whose
  bytes it still matches, so two that both qualify are both right, and the first is as good
  as the newest and reproducible besides.
- **A storage layout was trusted per file, and a slot is a whole-program property.**
  `Derived`'s first variable sits at whatever slot `Base` left free, so an artifact whose
  `Base` no longer matches disk hands back a well-formed layout for a `Derived` that *does*
  match, computed against a base that has since changed. The test that found it asserts a
  variable whose true slot is 1 does not get told it is slot 2. Layouts now come only from
  an artifact whose every project source still matches; edges are unaffected, because a
  reference into a changed file fails to join and degrades to no upgrade. A wrong slot is
  worse than no slot — §16's storage-collision work would read it as fact.

Three properties are now tests rather than assumptions:

- **The enriched graph round-trips through `parseGraph` without losing a field.** The
  existing fixed-point test builds every fixture with enrichment *off*, so `selector`,
  `slot`, `offset` and `generator.compilers` — the four fields this phase added — were
  covered by nothing. Phase 5 reads this artifact back.
- **`defi/` is byte-identical warm or cold with artifacts present.** The semantic tier joins
  on byte offsets that come from the parse, so a field the disk cache round-trip changed
  would land enrichment differently on the second build.
- **A superseded artifact is not reported as a stale source.** `out/build-info/` accumulates
  a file per compile and nothing prunes it, so the first draft's staleness count would have
  warned about changed files on every healthy Foundry project.

Two more small things: a relation the compiler does not state leaves the edge alone (it is
not evidence against it), and an unused accessor on the overlay is gone.

**Coverage of the Phase 3 modules is 98.6% of statements and 80.7% of branches.** What the
branches leave is `catch` arms for a file that vanishes mid-run and shape guards for AST
nodes solc does not currently produce — defensive by design, and each of them the honest
answer rather than a fallback.

### Notes for the next session, continued

- **Enrichment's cost at scale is unmeasured**, and is now a §16 entry rather than a note
  here. Measured on `defi/`: 55 ms to load a 513 KB build-info, which is 38.6x the size of
  the sources it describes. Extrapolating that ratio to `large/` gives ~300 MB of JSON per
  build against §9's 5-second budget — but it is an extrapolation from one small fixture,
  and measuring it needs a *compilable* perf fixture that does not exist yet. Deferred
  rather than guessed at: the seam for the obvious fix (a content-hash cache of the derived
  index, behind `loadSemanticOverlay`) already exists, and an artifact too large to parse
  degrades to the syntactic graph with a diagnostic rather than throwing.

---

## Phase 4 — Analysis passes

**Date:** 2026-08-04
**Status:** complete. `pnpm check` and `pnpm check:network` both green.

### Exit criteria

| Criterion | Result |
|---|---|
| Reachability pass | pass — `analysis/reachability.ts`. Entrypoints, `externallyReachable` and the full `entrypoints` set per function |
| Access-control heuristics | pass — `analysis/access-control.ts`, §11's three confidence levels against §13's configurable name list |
| External-call classification | pass — `analysis/external-calls.ts`, per call edge, plus §10's `reentrancy` |
| All pure functions over the graph | pass — each returns a new map and mutates nothing. `applyAnalysis` is the separate step that writes the results onto the nodes, so the passes stay runnable on a graph read back from disk in Phase 6 |
| Per-pass fixture tests with hand-verified output | pass — `test/analysis.test.ts`, 20 tests. Every expectation was derived by reading the fixture sources and written down before the pass was run against them |
| `pathological/` passes | pass — asserted twice, ungated and as it really builds in structural mode. The 29 entrypoints are enumerated in full, with a stated reason for each of the eight functions excluded |
| Phase 4 consumes rather than recomputes Phase 2's three items | pass — `linearizedBases` decides which contracts are deployable, `writes` edges and `flags.writesState` are the write side of the reentrancy shape, and nothing recomputes C3 or state access |

`pnpm check` is green: 243 tests in `core` (223 from Phase 3, 20 new) and 14 repo-level.

### The one thing the graph could not answer

§11 requires `low` access-control confidence "when the guard is an inline `require` rather
than a modifier" — and the graph had no way to know. `require` is a language builtin with
nothing to bind to, so the resolver drops it (correctly) and no edge records that a
comparison against `msg.sender` ever happened. Without it, §10's three-value confidence
enum has a dead middle value and `Proxy.upgradeTo` reports as unguarded.

So `flags.checksSender` is recorded at parse — `msg.sender` or `tx.origin` as an operand of
`==` or `!=` — in the same shape and for the same reason as Phase 2's two `assembly*`
flags: a syntactic fact the resolver structurally cannot produce. §10 is amended. The
analysis pass stays a pure function over the graph.

Equality only, and deliberately nothing more. `block.timestamp < deadline` is a comparison
and not a check; `balances[msg.sender] += x` mentions the sender and checks nothing; and
`msg.sender == address(0)` is indistinguishable from `msg.sender == owner` without types,
which is exactly the uncertainty `low` exists to carry. Across all four fixtures it fires
on five functions and all five are real sender comparisons — verified by reading each.

### What the passes decided, and why

- **A constructor is not an entrypoint.** No actor can call one on a live system, and
  §15's third item would fill with them. Code a constructor runs is still reached, through
  the `creates` edge of whoever deploys it: `Pair.constructor` is reachable on `defi/`
  because `Factory.createPair` does `new Pair{salt: salt}()`, and that is a test.
- **Reachability follows `possibleTargets`.** An interface call resolves to the interface's
  function and fans out to every implementation (§10). Following only the static target
  would report an implementation reached solely through an interface as unreachable — and
  §11 *dims* unreachable nodes, so that error hides live code. `Pair.mint` is reachable
  from `Router.addLiquidity` for this reason.
- **An inherited public function is an entrypoint.** The node for it lives on the base,
  which may be `abstract`, so a contract qualifies if it is deployable *or* is a base of
  something deployable. `Base.tag()` on `minimal/` is the case.
- **Both halves of the reentrancy shape are transitive.** `Pair.swap` transfers out through
  `SafeTransfer` (which bottoms out in `token.call`) and then writes the reserves inside
  `_update`. A rule that only looked at this body's own `writes` edges and `external`
  subkinds finds nothing on `defi/`, or on most real code, since the effects half of
  checks-effects-interactions is usually a helper. The cost is precision, in the direction
  §11 already accepts by calling this a highlighter rather than a detector — and it stays
  bounded: 4 of 39 functions on `defi/`, 0 of 277 on `inheritance/`, 2,611 of 14,446 on
  `large/`.
- **`default` visibility is not an entrypoint.** In 0.8 it only comes out of a recovered
  parse — `SyntaxError.sol`'s truncated function. Guessing `public` for a declaration the
  parser could not read is the confident-wrong answer §6 rules out.

### Structural mode gets an honest answer, not a blank one

`pathological/` builds in structural mode, so there are no `calls` or `creates` edges and
nothing propagates: reachability is the 29 entrypoints, plus `Legacy#onlyOwner`, which
`modifiedBy` still reaches. That is the true reachability of the graph as it exists rather
than a claim about the code, and `mode` is how a consumer tells the two apart. Both states
are asserted, because the difference between them is exactly the thing that would be easy
to report wrongly.

### Deviations from the spec

- **`flags.checksSender` is a tenth flag, not in §10's list.** *(§10 amended.)* Reasoning
  above.
- **`GRAPH_SCHEMA_VERSION` is 3 and `PARSE_SCHEMA_VERSION` is 3.** The graph bump carries
  §10's four Phase 4 fields and the new flag; all are defaulted, so the goldens gain only
  the lines where the analysis found something. The parse bump matters more than it looks:
  a cached v2 entry would deserialise with `checksSender` absent and report every inline
  guard as no guard at all, which is the wrong direction for this overlay to fail in.
- **The passes take `AxiomapGraph` and `applyAnalysis` mutates the nodes.** The objects
  mutated are the same ones the graph holds as attributes and the same ones `graph.json`
  serializes, so the two cannot drift; `analysis.test.ts` asserts that identity rather than
  assuming it.

### The golden diff

Purely additive, and verified as such rather than eyeballed: stripping the four new fields
and `checksSender` from the six regenerated goldens reproduces the committed v2 files
byte for byte, apart from `schemaVersion`. No node, edge, hash, count, resolution or score
changed. The new content was then read: `minimal/`'s fifteen functions were checked
one by one against the source, and `defi/`'s and `pathological/`'s findings are the
hand-derived expectations that `analysis.test.ts` already pins.

### Performance

The three passes cost about 180 ms on the `large/` fixture — 200,129 SLOC, 30,708 nodes,
74,512 edges, 5,425 entrypoints. §9's warm budget still passes with room:

| Configuration | parse | graph + analysis | total |
|---|---|---|---|
| single-cold | 7,619 ms | 1,103 ms | 8,730 ms |
| parallel-cold | 3,103 ms | 1,093 ms | 4,204 ms |
| parallel-warm | 999 ms | 984 ms | **1,983 ms** |

The first draft measured 3,217 ms warm, and the cause is worth recording because it is not
where it looks. Entrypoint sets are bitsets propagated to a fixpoint, which is fast; what
was slow was reading them back by testing all 5,425 entrypoint bits for each of 14,446
functions. Iterating only the set bits, word-wise and skipping empty words, is the whole
difference. The obvious implementation — one BFS per entrypoint — was never written; it is
O(entrypoints × edges) and would have been far worse than either.

### §16 changes

- **Added Tier 2 — reentrancy guards recognised by shape, not only by name.** `defi/`'s
  mutex is `lock`, not `nonReentrant`, so three genuinely guarded functions report
  `guarded: false`. The available syntactic check ("reads and writes the same variable")
  also matches a nonce, and a false *guard* silently suppresses a true warning — worse than
  the false alarm it would fix. Needs the `_` placeholder's position recorded at parse.
- **Added Tier 2 — sender checks through an accessor.** OpenZeppelin compares
  `_msgSender()`, which is a call rather than a member expression; following it into a base
  is resolution work, not a syntactic flag.

### Notes for the next session

- **Nothing reads `axiomap.config.json` yet.** §13's `entrypoints`,
  `accessControlModifiers` and `reentrancyGuards` are plumbed through
  `buildProjectGraph({ analysis })` and tested, but no phase has owned loading the file.
  Phase 6 is where it belongs — it is the phase that owns the command line, and the three
  knobs are useless without one. `renderCap` and `layout` are Phase 7's.
- **`defi/`'s three `lock`-guarded functions are the demonstration case for that config**,
  and there is a test that flips them to `guarded: true` with `reentrancyGuards: ['lock']`.
  If the CLI ends up shipping a starter config, that is the entry to copy.
- **`graphFromFile` reads a `graph.json` back as an `AxiomapGraph`**, committed just after
  this entry. `buildGraph` was the only thing that could produce one, and it needs a project
  on disk; everything from here consumes the artifact instead. The analysis passes run on
  either side of a serialize/parse round trip with identical results, and there is a test
  that says so.
- **The four Phase 4 fields are transitive, and a diff must not treat them as ordinary node
  attributes.** One edited leaf helper flips `externallyReachable`, `entrypoints` and
  `reentrancy` on every caller above it, so diffing them naively fills the "what must I
  re-review" list with functions whose source did not change — which is the one list §8
  makes the product. Phase 5 has both graphs and the passes are pure, so it can attribute a
  finding to the function whose *direct* evidence changed and report the rest as
  consequences of it. §8 already names "previously unreachable function became externally
  reachable" as a finding, so this needs deciding either way.
- **Phase 5 is the diff engine.** §14 still wants `defi/` committed twice as two git tags
  with a hand-authored changeset between them; Phase 1 deferred designing the changeset
  until the engine it exists to test existed. That is now.
- The four Phase 4 fields are on the Function nodes and round-trip through `parseGraph`,
  so Phase 5 can diff them: "previously unreachable function became externally reachable"
  and "access-control modifier removed from a state-mutating function" are two of §8's
  named findings and both are now a field comparison rather than an analysis.

---

## Phase 5 — Diff engine & review state

**Date:** 2026-08-04
**Status:** complete. `pnpm check` and `pnpm check:network` both green.

### Exit criteria

| Criterion | Result |
|---|---|
| `axiomap diff` between two commits of the `defi/` fixture | pass — `axiomap diff defi-v1 defi-v2 fixtures/defi`, a real command over two real git tags, asserted end to end in `packages/cli/test/diff.test.ts` |
| Correctly identifies a hand-authored set of changes | pass — the additions, removals and modifications are asserted as exact sorted lists, not as counts, so an extra or missing one fails. 20 changed nodes, 78 unchanged |
| …including one rename | pass — `Router.quote` → `Router.quoteAmount`, matched by body hash, reported `renamed` with `{interfaceHash, name}` as the only differences |
| …and one moved function | pass — `AmmMath.sortTokens` → `TokenOrder.sortTokens`, across a file and a library, matched by body hash, reported `moved` with `{file, scope}` |
| Node matching (§8's four tiers) | pass — all four fire on the fixture pair: exact, body, signature (`Pair._update(uint256,uint256)` → `Pair._update()`) and fuzzy (`Router.getAmountOut` → `Router.amountOutFor`, confidence 0.918) |
| Change classification | pass — §8's six statuses for nodes, four for edges, with the compared attribute set stated per node kind |
| Review invalidation | pass — `review/`, §8's flat `review.json` shape, `stalenessOf` and `migrateReview`. 10 tests, including the two failure directions: a review that survives a change it should not, and one thrown away for a change that was not one |

`pnpm check` is green: 277 tests in `core` (243 from Phase 4, 34 new), 21 in `cli`, and 14
repo-level.

### The changeset was written first

Deliberately, and in that order: the fixture v2 was hand-authored and tagged before any
matcher existed, so the engine was built to explain a changeset rather than the changeset
picked to flatter the engine. `docs/fixtures/defi-diff.md` is the changeset in prose and
says which §8 clause each edit exercises.

The two hard cases were planted on purpose and both work:

- **`Router.sweep` is added in the same commit that renames `getAmountOut` to
  `amountOutFor`, and takes the same three parameter types.** A matcher scoring on
  signature alone would pair it with `getAmountOut`. The name similarity and the
  call-neighbourhood overlap separate them by a wide margin — 0.918 against 0.20.
- **`AmmMath.min` is removed from the same library that `sortTokens` moves out of.** A
  removal and a move, one commit, one file. `min` is reported removed and `sortTokens`
  moved, because tier 2 matches on the body and `min`'s body has no counterpart.

### Where v2 lives, and why not on `main`

`defi-v2` is a child of the `defi-v1` commit and is **not merged into `main`**; the tag is
what keeps it reachable. §14 asks for two tags with a changeset between them and does not
say `main` has to advance to the second one — and advancing it would have been expensive
in exactly the wrong way. Every `defi/` golden, Phase 1's hand-verified symbol counts and
Phase 3's committed build-info are pinned to v1. Moving the fixture would have meant
regenerating all of them to make a *new* fixture pass, which is the shape of the mistake §6's
rule about goldens exists to prevent.

`out/build-info/` is dropped at v2, and that is not a shortcut: every source file changed,
so the v1 artifact covers none of them. It also makes the fixture the normal case rather
than the tidy one — §8's whole argument is that diff is cheap *because* neither revision has
to compile, so one side having artifacts and the other not is what a real
`axiomap diff v1 HEAD` looks like.

§14 and CI were amended: `actions/checkout` now uses `fetch-depth: 0`, because a shallow
checkout has no tags and the exit-criterion test **fails** rather than skipping when they
are missing.

### What was built

- **`diff/match.ts`** — §8's four tiers, run in order so a confident answer is never
  displaced by a speculative one. Two rules carry most of the weight: a bodyless
  declaration has no body hash and cannot match at tier 2 (Phase 2 made that the empty
  string for this exact reason — ten of `defi/`'s thirty-nine functions are interface
  declarations), and a hash bucket that cannot be resolved unambiguously is left for the
  later tiers rather than paired on iteration order.
- **`diff/classify.ts`** — the six statuses, and a stated list of compared attributes per
  node kind. What is *excluded* is the design: source positions, the semantic tier, derived
  metrics, and Phase 4's three transitive fields.
- **`diff/findings.ts`** — §8's seven findings, each a comparison over fields Phase 4
  already computed. Nothing is re-analysed.
- **`review/`** — `state.ts` (schema, staleness, migration; pure) and `store.ts` (the only
  file that touches `fs`).
- **`packages/cli`** — `axiomap diff <refA> <refB> [path] [--json]`, with git revisions
  materialised through `git worktree add --detach`.

### Three decisions worth the space

- **The diff is blind to the semantic tier.** `resolution`, `possibleTargets`, `selector`,
  `slot` and `offset` are excluded from every comparison. A compiler appearing between two
  revisions is not a code change, and §8's premise guarantees it will happen: historical
  commits do not compile. There is a test that says so directly — `defi/` heuristic against
  `defi/` enriched, same revision, produces zero changed nodes, zero changed edges and zero
  findings. Without it the exit-criterion diff would have been comparing a semantic v1
  against a syntactic v2 and reporting the tier as a changeset.
- **Phase 4's transitive fields are findings, not attributes.** The previous session's note
  said this needed deciding either way. `externallyReachable`, `entrypoints` and
  `reentrancy` flip on every caller above an edited leaf, so they are excluded from the
  attribute comparison — otherwise the re-review list, which §8 calls the product, fills
  with functions whose source did not change. They are read by `findings.ts` instead, and
  every finding carries `evidence: 'direct' | 'consequence'` according to whether the node
  it names changed itself. The fixture proves the case is real: `IERC20Minimal.transfer`
  becomes externally reachable because `Router.sweep` was added, and `transfer` itself is
  untouched.
- **Edge endpoints are projected into before-space.** Both sides are keyed by
  `(kind, subkind, from, to)` with the after graph's ids mapped back through the matching,
  so renaming a function does not report every edge it touches as one addition and one
  removal. Asserted directly: a pure rename produces zero added, removed or modified edges.

### Deviations from the spec

- **`axiomap diff` ships in Phase 5, not Phase 6.** *(§7's Phase 6 amended.)* The exit
  criterion names the command, and git-revision materialisation cannot live in `core` —
  §6 keeps it to `fs`, and a checkout means spawning `git`. It is one hand-rolled
  subcommand: no `commander`, no colour, no other commands. Phase 6 owns the surface and
  this joins it.
- **`defi-v2` is on an unmerged tag.** *(§14 amended.)* Reasoning above.
- **A tenth matching detail: tier 3 is "same container, same *name*".** §8 words it as
  "same container + same signature, different body" — but same container plus same
  signature plus same name *is* the same id, which is tier 1. The case §8 is reaching for
  is a changed signature, which is what tier 3 matches, and it requires uniqueness on both
  sides so an overload set is left alone.
- **`Unresolved` nodes are compared on `name` and `category` only.** They are project-wide
  by construction (Phase 2), so the `file` on `?low-level:call` is whichever call site was
  resolved first — and comparing it reported the node as *moved* every time an unrelated
  file changed. Its identity is what its id is built from.
- **The storage-layout finding reads declaration order, not `slot`.** The old revision in a
  diff usually has no artifacts, so slots are usually absent on one side. Noted on §16's
  existing storage-layout entry rather than as a new one.
- **`migrateReview` keeps an unmatched entry under its old id** rather than deleting it. A
  match the matcher could not make is not proof the code is gone, and silently discarding
  somebody's audit notes on a heuristic is not a thing to do. It reports as `orphaned`.
- **`review.json` has no version field.** §8's example is a flat map and this follows it
  exactly. It is safe because every stored `bodyHash` is a hash of a string beginning
  `b${HASH_VERSION}`, so a hashing change invalidates every review by itself — which is
  what a hashing change means. A version field would be a second source of truth for one
  fact.

### §16 changes

- **Added Tier 2 — fuzzy matching across containers.** The fourth tier is scoped to one
  contract, so a function that moved *and* was rewritten falls through to added + removed.
  No fixture, and cross-scope candidate generation is quadratic in the unmatched set.
- **Added Tier 1 — diffing two `graph.json` artifacts instead of re-graphing.**
  `graphFromFile` and `diffGraphs` are already the seam; the cost is unmeasured outside
  fixtures.
- **Answered the rename-confirmation entry's "measure on the `defi/` fixture pair first".**
  One fuzzy match, no false positives, threshold 0.55. The trigger has not fired.
- **Noted on the storage-layout entry** that Phase 5's finding depends on slots being
  absent, and so says nothing about packing.

### Pre-Phase-6 audit

Phase 5 was audited at the boundary the same way Phases 2, 3 and 4 were. It found **one
real defect**, and it was a performance defect rather than a correctness one — which is
itself the finding, because Phase 5 was the first phase to ship a pass that had never been
run at scale.

- **The storage-layout finding was O(contracts × nodes).** `storageOrder` filtered the whole
  node list once per contract, twice. On `large/` that is 2,719 contracts against 30,708
  nodes: **167 million iterations**, and 4.5 of the 5.7 seconds a self-diff took. Bucketing
  by scope in one pass brings `deriveFindings` from **4,540 ms to 56 ms** and the whole
  diff from **5,676 ms to 769 ms**. Every correctness fixture was green throughout — the
  largest has five contracts, so nothing could have shown it. The first guess at the cause
  was wrong (`JSON.stringify` in the attribute comparison, which turns out to cost 60 ms for
  a quarter of a million calls), which is the argument for profiling over reasoning.

`pnpm bench:parser` now measures the diff too, with a **tripwire rather than a budget** —
§9 sets no budget for `axiomap diff`, and the number is set well above the measured value
because what it guards is a pass turning quadratic, which shows up as 10x and not 10%.

| | parse | graph + analysis | total | diff |
|---|---|---|---|---|
| single-cold | 7,537 ms | 1,215 ms | 8,762 ms | |
| parallel-cold | 3,096 ms | 1,001 ms | 4,103 ms | |
| parallel-warm | 946 ms | 968 ms | **1,914 ms** | **769 ms** |

The diff row is a graph against itself: every node matches at tier 1, so it measures the
half of `axiomap diff` that scales with the whole project rather than with the changeset.
A real PR-shaped diff changes a fraction of a percent of nodes, which is why the matcher's
inferring tiers do not appear here — and why this is the number that matters.

**Four properties are now tests rather than assumptions.** All four already held when they
were written; Phase 2 and Phase 3 each found a real bug from this same class of probe, and
the value here is that they keep holding. Each guards a failure that would surface as
`axiomap diff` reporting phantom changes, which is the worst thing this engine can do.

- **The diff is the same over graphs read back from `graph.json`** as over freshly built
  ones. This is exactly the path §16's "diff two stored artifacts" entry would take.
- **The diff does not depend on worker count.** Two builds of one unchanged project at 1
  and 4 workers diff to nothing.
- **The diff mirrors when the revisions are swapped** — added and removed exchange, and
  renames, moves and the unchanged count are preserved.
- **Every fixture diffed against itself reports nothing**, including `pathological/`.

**Coverage of `diff/` went 97.7% → 99.1% of statements and 85.7% → 87.7% of branches, and
`match.ts` is at 100% of statements.** The two branches that were unreached were both
"do not guess" guards, which is where §6 says a bug is worst:

- **A body-hash bucket resolved by elimination**, when a function is moved *and* renamed in
  one commit so neither the same-name nor the same-scope pass can fire.
- **The greedy pass giving a contested node to its best candidate** and not also claiming
  the loser. Two plausible successors to one function; one wins, the other is an addition.

Two decisions were taken here rather than left for Phase 6 to take by accident:

- **`axiomap diff --json` carries a `schemaVersion`.** §3's reasoning for `graph.json` is
  identical — §15's eighth item points CI at this output, and Phase 6 is when people start
  scripting it. One field now; a breaking change to somebody's pipeline later.
- **One `axiomap.config.json` governs both revisions in a diff: the invoking working
  tree's.** *(§13 amended.)* `accessControlModifiers` feeds the Phase 4 passes and
  `accessControl` is a compared attribute, so reading each checkout's own config would make
  a rename *inside that file* produce an access-control regression on every function using
  the modifier. The question `axiomap diff` answers is what changed in the protocol.

### Notes for the next session

- **Phase 6 is the CLI.** `axiomap diff` exists and works; everything else in §12 does not.
  `axiomap review <node> --status`, `axiomap query stale-reviews` and `axiomap query
  unresolved` all have their engine already — `setReviewStatus`, `stalenessOf` and the
  synthetic `Unresolved` categories respectively — and need a command around them.
- **Nothing still reads `axiomap.config.json`.** Unchanged from Phase 4's note, and Phase 6
  is still where it belongs. It matters more now: §13's `accessControlModifiers` is what
  the `access-control-weakened` finding compares against, so a protocol whose guard is
  spelled `auth` gets no finding until the file is loaded.
- **`migrateReview` is not wired to anything.** It is the piece that turns a diff into an
  updated `review.json`, and Phase 6's `axiomap diff --update-review` (or whatever it ends
  up called) is where a user reaches it.
- **The fixture pair is frozen at both tags.** If `packages/cli/test/diff.test.ts` starts
  failing, the fixture cannot have changed — only the engine can have. Read the diff.
- **`defi-v1` and `defi-v2` exist only locally, and there is no remote yet.** Nothing to do
  now; the trap is later. Whenever a remote is added — §7 says not before Phase 6 — the
  first push needs `git push --tags`, or CI checks out a fixture that is half missing and
  the exit-criterion suite fails for a reason that is not a bug.
- **§13's config decision is written down but not implemented**, because nothing loads the
  file yet. When Phase 6 wires it up, the config comes from the invoking working tree and
  is passed to `buildProjectGraph` for *both* sides of a diff. `runDiff` has the seam and
  the comment.

---

## Phase 6 — CLI

**Date:** 2026-08-04
**Status:** complete. `pnpm check` and `pnpm check:network` both green.

### Exit criteria

| Criterion | Result |
|---|---|
| **A human can audit a small protocol using only the terminal** | pass — `packages/cli/test/audit-walkthrough.test.ts` walks §15's definition of done, in order, using nothing but §12 commands, against a copy of `defi/` **with its artifacts deleted**. Ten steps, each naming the §15 item it covers. Also run by hand end to end; the session is in "The demonstration" below |
| All commands (§12) | pass — `build`, `stats`, `diff`, `export`, `review`, `import-findings`, `query` with ten subcommands. `serve` is Phase 7's and says so |
| All export formats | **partial, deferred with a rationale** — `dot`, `mermaid` and `json` ship. `html` and `svg` are a *rendered* graph and need the layout engine Phase 7 brings; §7 and §16 were amended rather than the gap left silent. See below |
| Table output by default, `--json` for piping | pass — every command takes `--json`; `program.test.ts` asserts the output is parseable and that stderr stays empty, so `> file` and `| jq` both work |
| No UI | pass — no renderer, no HTML, no server |

`pnpm check` is green: 337 tests in `core` (277 from Phase 5, 60 new), 66 in `cli` (21 from
Phase 5, 45 new), and 14 repo-level.

### The demonstration

Run by hand on a copy of `defi/` with `out/` removed — a protocol that does not build:

```
$ axiomap build
mode        heuristic
            No build artifacts. 98% of call edges resolved confidently, at or above the
            70% threshold; edges are labelled with their confidence.
resolution  139 edges — 0% semantic, 99% heuristic, 0% ambiguous, 1% unresolved
compilers   none — no build artifacts were read

$ axiomap stats
real / test / mock    9 · 0 test · 0 mock
unguarded             14 state-mutating externals with no recognised guard
danger ops            assembly 0 · delegatecall 0 · low-level 1

$ axiomap query writers-of reserve0
1 writer
src/Pair.sol:Pair._update(uint256,uint256)  private  reachable: yes  src/Pair.sol:134

$ axiomap query path Router.swapExactTokensForTokens Pair._update
2 hops   … src/Router.sol:66 (heuristic, possible-target) → src/Pair.sol:129

$ axiomap review Pair._update --status reviewed --reviewer alex -m 'overflow bounds checked'
$ # …client patches _update…
$ axiomap query stale-reviews
1 review needs attention
stale  src/Pair.sol:Pair._update(uint256,uint256)  reviewed  alex

$ axiomap diff defi-v1 defi-v2 fixtures/defi
high   access-control-weakened  Factory.setFeeSetter … weakened from low to none
high   storage-layout-changed   [feeSetter, pairs, allPairs] → [feeSetter, creationFee, …]

$ axiomap export --format dot --view protocol | dot -Tsvg > protocol.svg
```

Every step answers one of §1's opening questions or one of §15's items, and none of it
needed a compiler, an editor or a browser.

### What was built

- **`core/src/query/`** — §5's "the API both CLI and webview consume", built for the
  terminal first and deliberately returning plain data. `refs.ts` (a human's half-
  remembered name → a node id), `traverse.ts` (callers/callees/reachable/path),
  `inspect.ts` (writers/readers/externals/unresolved/stats), `views.ts` (§11's five views
  as *selection*). Nothing in `packages/cli` computes anything about the graph; §7's
  Phase 7 inspector answers the same questions and must not get a second implementation
  that can disagree with this one.
- **`core/src/findings/`** — `slither --json` import, decision #4's positive half.
- **`core/src/project/config.ts` and `globs.ts`** — §13, which nothing had read.
- **`packages/cli`** — `commander`, `picocolors`, `ora`, one file per command, plus
  `context.ts` (project + config + graph) and `output.ts` (tables and colour).

### Three things worth the space

- **A stored artifact is used only while it is still true.** `axiomap query` reads
  `.axiomap/graph.json` rather than re-parsing, but only when no source file is newer than
  it; otherwise it rebuilds and says why. `--stale` overrides. This is Phase 3's rule about
  build-info artifacts one level up, and `axiomap review` is why it is worth the mtime
  scan: recording a review against a stale graph stores the hash of a body the reviewer
  never read, and that review then looks current forever — a false *negative* on the
  re-review list, which is the one direction §8's flagship feature must not fail in.
- **Traversal follows `possibleTargets`, and says when it did.** §10 gives an interface
  call one static edge plus every implementation. Following only the static edge would
  report `Pair.mint` as having no callers at all, which is the error
  `analysis/reachability.ts` already refuses to make — so every hop carries `virtual`, and
  "X calls Y" and "X's interface call could reach Y" stay different claims.
- **The three export formats carry §4's confidence in their line style.** Solid, thin,
  dashed, dotted — the same distinction §4 requires of the UI. A dot file that drew all
  four identically would be the tool "silently pretending to certainty it does not have",
  which §4 calls worse than useless in an audit.

### Deviations from the spec

- **`export --format html|svg` is deferred to Phase 7.** *(§7's Phase 6 amended; §16 entry
  added.)* Both are a rendered graph, and rendering is a layout engine — `cytoscape` and
  `elkjs` are Phase 7's, and §7's Phase 9 licence note already settles that the HTML export
  *is* the webview in one file, since it "redistributes" elkjs. A throwaway layout engine
  written here would be the UI work §6 forbids this phase and would be deleted one phase
  later. `axiomap export --format dot | dot -Tsvg` produces an SVG today, and the deferred
  formats say so rather than reporting an unknown format.
- **`.axiomap/findings.json` is a fourth file in a user's repo**, not in §5's three, and
  `ensureAxiomapDir` now writes it into `.axiomap/.gitignore`. §5's line is between
  artifacts this tool computed and audit state a human authored: an imported finding is a
  projection of the user's own Slither run and re-running the import reproduces it exactly,
  so it is derived and stays out of git. It is persisted at all because §11's overlay needs
  a source that does not require re-running Slither on every open.
- **Two extra `query` subcommands beyond §12's nine.** `findings` lists what
  `import-findings` wrote — a command that writes a file whose contents can only be read as
  raw JSON is half a feature. (The count of "ten" above is nine plus this one.)
- **`axiomap diff` gained `--update-review`.** Phase 5's notes flagged `migrateReview` as
  wired to nothing and named this command as where a user would reach it.
- **`DiffCommandOptions.target` survives alongside `path`.** Phase 5 shipped `target` and
  `packages/cli/test/diff.test.ts` — the Phase 5 exit criterion — is written against it.
  `path` wins when both are given.
- **`.gitignore`'s Axiomap rules are now unanchored (`**/.axiomap/...`).** Found by running
  the new CLI against `fixtures/defi`: a gitignore pattern containing a slash is anchored to
  its own directory, so §5's `.axiomap/cache/` covered a root-level `.axiomap/` and nothing
  under `fixtures/` — which is where every `axiomap build` in this repo actually writes. §5
  makes git hygiene a security property here, and this was the rule failing to be one.
- **`bin.ts` is a four-line shim over `program.ts`.** The whole surface has to be callable
  from a test, and a file with a top-level `await main()` runs the CLI on import.

### §13, implemented rather than described

`include`/`exclude` filter the file list before anything is parsed. `entrypoints`,
`accessControlModifiers` and `reentrancyGuards` reach the Phase 4 passes.
`trustBoundaries.external` marks call edges into a declared-external directory as
`crossTrustBoundary`, additively — the resolver already sets it for interface calls, and a
user naming a directory is more evidence rather than a correction. `renderCap` and
`layout` are validated and carried but not consumed; they are the renderer's, and
validating them now means a user's config does not start failing the day Phase 7 lands.

The glob matcher is hand-rolled, ~50 lines, for one reason: `@axiomap/core`'s production
dependency tree is two pure-WASM packages with no transitive dependencies of their own, and
§3 makes that a security property an auditor can check. It is not worth a glob library.

**§13's diff rule is now code.** One config governs both revisions and it is the invoking
working tree's: `openProject` loads it once and the same options object goes to both
`buildProjectGraph` calls. The checked-out revisions have their own `axiomap.config.json`
on disk and it is deliberately never read.

**An unknown key warns and is ignored**, rather than failing the file. A config that fails
closed on a typo fails on the day someone opens a v2 project with a v1 binary; the failure
worth preventing is silently auditing a protocol with the wrong guard list, and a warning
prevents that one.

### Exit codes are the CI contract

0 nothing found, 1 something found, 2 could not run. §15's eighth item — "run
`axiomap query unresolved --json` in CI and fail the build on new unresolved external
calls" — needs the first two to be distinguishable without parsing output, and every
subcommand behaving the same way is worth more than each being individually clever.

### No golden file changed

Verified rather than assumed, and it is the property the config loader was designed
around: no fixture has an `axiomap.config.json`, every §13 field is optional, and every
default is the behaviour of the phase that introduced it. `pnpm test:golden` is green
without regeneration.

### Performance

Phase 6 touched `ingest.ts` (the `include`/`exclude` filter) and `graph/build.ts` (the
`trustBoundaries` marking), so the harness was re-run rather than assumed unaffected. Both
additions are no-ops without a config file, and the numbers say so — same host, same
fixture, within run-to-run noise of Phase 5:

| | parse | graph + analysis | total | diff |
|---|---|---|---|---|
| single-cold | 7,629 ms | 994 ms | 8,716 ms | |
| parallel-cold | 3,005 ms | 964 ms | 3,957 ms | |
| parallel-warm | 971 ms | 955 ms | **1,883 ms** | **795 ms** |

§9's warm budget passes at 1,883 ms against 5,000 ms; the diff tripwire passes at 795 ms
against 2,500 ms.

The one Phase 6 cost not in this table is `loadGraph`'s mtime scan, which walks the source
list to decide whether the stored artifact is still true. It is the same walk the ingest
would have done anyway, and it replaces a full rebuild on every query.

### §16 changes

- **Added Tier 1 — `export --format html` and `--format svg`**, with the layout-engine
  reasoning, the `dot | dot -Tsvg` workaround, and Phase 7 as the trigger.

### Pre-Phase-7 hardening

Phase 6 was audited at the boundary the same way Phases 2–5 were, asking one question:
what would be cheap to fix now and expensive once Phase 7 is reading it. Two things
qualified, and both are **persisted formats**, which is the category where "later" means a
schema bump plus everyone's stored state.

- **An imported finding did not know what body it was found on.** `review.json` has gone
  stale by `bodyHash` since Phase 5 and `findings.json` stored node ids and nothing else —
  so §11's overlay would have drawn a High-severity reentrancy badge on a function
  rewritten after Slither last ran. Worse than the gap: `store.ts`'s own header *claimed*
  the file "goes stale in the same way and for the same reasons", which was simply false.
  Each mapped node now carries its `bodyHash`, `findingStaleness` reports
  `current | stale | orphaned` — deliberately the same three words `review/state.ts` uses,
  since an auditor should not learn two vocabularies for one idea — and `axiomap query
  findings` shows the column. A finding spanning a caller and a deleted callee reports
  `stale`, not `orphaned`: it is still about live code, and calling it gone would lose it.
- **`graph.json` did not record the settings that produced it.** The mtime check catches an
  edited config at the default path; it cannot catch `--config elsewhere.json`, a config
  outside the project, or `--no-enrich`. In each of those the stored artifact is a
  confident answer to a *different question*, and `axiomap query externals --unprotected -c
  strict.json` would have answered from a graph built with the default guard list.
  `generator.settings` now records the §13 fields that decide content — `renderCap` and
  `layout` deliberately excluded, since changing a layout preference should not invalidate
  an artifact — and `loadGraph` rebuilds on a mismatch. Checked even under `--stale`: that
  flag means "the sources moved on and I know it", not "answer a different question than
  the one I asked".

Verified end to end afterwards: `-c strict.json` reports 11 unguarded externals where the
default list reports 14, instead of silently reusing the artifact; and an imported finding
goes `current` → `stale` when its function is edited.

**`GRAPH_SCHEMA_VERSION` is 4.** The golden diff was read before it was accepted, per §6:
`schemaVersion` on all six, plus `"settings": { "enrich": false }` on the five built with
the tier declined — which is the field doing its job, since those goldens *are* built that
way and previously said nothing about it. Zero node, edge, hash, count, resolution or score
changes. Two tests were comparing a `enrich: false` build against an enrichment-ran-and-
found-nothing build and now set `generator.settings` aside; both really were configured
differently, and the artifact being able to say so is the point.

One smaller thing, cheap either way: **`ViewSelection`'s arrays are `readonly`**, with a
note saying why. They hold the graph's own node and edge objects by reference, so a webview
hanging a layout coordinate on one would be writing into what `graph.json` serializes, and
the next `axiomap diff` would report a phantom change.

**The coverage sweep found one real defect**, which is the argument for running it: every
prior phase boundary did, and it caught two bugs in Phase 2 and two in Phase 3. `views.ts`
was the weakest of the new code at 87% of statements, and it is the module Phase 7 consumes
most.

- **The inheritance view could not show an overridden member.** §11 asks that view for "C3
  order, shadowed and overridden members flagged", and it filtered for `inherits`,
  `overrides` and `implements` over a selection of Contract nodes — but Phase 2 settled
  that `inherits` is the only contract-level relation and the other two are
  function-level. `inducedEdges` requires both endpoints to survive the node filter, and a
  Function never did, so the `overrides`/`implements` half of that filter was dead code.
  On `defi/` all seven `implements` edges silently vanished; on `inheritance/`, seventeen
  member relations did. The functions on either end are now kept when both of their
  contracts are, and they carry `scope`, so a renderer nests each member under its contract
  without a `declares` edge cluttering a view that is about inheritance. Pinned by a test
  asserting the count and both endpoints, because the failure mode was silence.

Two smaller gaps closed at the same time, both "do not guess" guards of the kind Phase 2's
audit flagged as where a bug is worst: `requireNode` throwing on an ambiguous reference
rather than picking a candidate, and `reachableFrom`, which is part of the query API Phase 7
will use and which nothing had called.

**Deliberately not done**, because both are cheap later and neither touches a stored format:

- `query/traverse.ts` rebuilds its adjacency index per call. Adding a cache is a parameter
  with a default; Phase 7 should do it with a profile in hand rather than a guess.
- §9's render cap. §7 assigns it to Phase 7, its message is UI copy, and `ViewSelection`
  already carries the counts the check needs — it is a call-site check, not an interface
  change.

### Notes for the next session

- **Phase 7 is the webview, and §9 rule 1 is the thing to build first.** `core/src/query/`
  is the seam it names: the webview requests subgraphs by view + filter + focus, and
  `selectView` is already that call. Retrofitting it is what §9 calls miserable.
- **`views.ts` is selection only.** §9's aggregation layer — directory clustering,
  drill-down, the 1,500-element render cap — is Phase 7's and is deliberately absent. The
  one exception is the protocol map's contract-level rollup, which is there because without
  it the protocol map degenerates into the inheritance tree; its edges carry a synthetic
  `rollup:` id so nothing can mistake one for a resolved call site.
- **`renderCap` and `layout` are loaded and validated but unread**, waiting for a renderer.
- **`axiomap serve` is registered and refuses**, pointing at Phase 7. It is the natural
  place to hang the local HTTP endpoint §9 rule 1 asks for in browser mode.
- **The `html` export is the webview in one file** (§7's Phase 9 licence note), not a
  second renderer. Build it out of the Phase 7 bundle, and remember `elkjs`'s attribution
  in the footer.
- **`query/traverse.ts` builds its adjacency index per call.** Fine for one query; if
  Phase 7's inspector issues one per hover, cache it on the graph.

---

## Phase 7a — Aggregation layer & render cap

**Date:** 2026-08-04
**Status:** partial phase, deliberately. `pnpm check` green. **Phase 7 needs splitting; the
rest of it (renderer, five views, overlays, inspector, code preview, search, history,
`serve`, the `html`/`svg` exports) is not started.** See "Why this is half a phase" below.

### What was built

**`packages/core/src/query/aggregate.ts`** — §9 rules 2, 3 and 4, on the query API rather
than in the renderer. §9 rule 1 is the reason it is here: "the webview never receives the
full graph", and a webview that received the graph and clustered it itself would satisfy
the picture and not the rule. `selectAggregatedView(graph, {view, focus, expand,
renderCap})` is the one call §9 rule 1 describes.

- **Directory clustering with drill-down.** A cluster is a directory; expanding one reveals
  its subdirectories and its contracts, one level at a time, and edges to anything still
  collapsed lift to the enclosing cluster and fold. Ancestors are implied, so `expand:
  ['src/tokens/erc20']` opens the path to it.
- **The 1,500-element cap**, with `RenderCapError` carrying `elements`, `cap` and `view` as
  fields rather than only as prose, and a message that names the way out in the vocabulary
  of the view you are looking at — `--up/--down` for the call graph, "collapse a directory"
  for the protocol map, "focus a contract" for the other three.
- **`DEFAULT_RENDER_CAP`**, which is what §13's `renderCap` has been validated against and
  not read for since Phase 6.

Three decisions worth recording, because each of them is the kind that gets made twice:

- **The default view expands as far as it fits.** A literal reading of §9 rule 3 — always
  start fully collapsed — makes the default view of `defi/` a single box labelled `src`,
  which is worse than the hairball it is protecting against. So an explicit `expand` set is
  honoured first and always, and then clusters open breadth-first while the result stays
  under the cap. `defi/` draws all nine contracts; the 300-contract case stops at the
  directory level and says so in its note. That leaves the cap for what it is actually for:
  **an explicit request that cannot be drawn**, which is the only case that errors.
- **The result is a display model, not a subgraph.** A cluster is not a `GraphNode` — §10's
  kinds are a closed set of declarations and a directory is not one — and a lifted edge's
  endpoints are directories. Every element carries an id and a parent (cytoscape's compound
  nodes are exactly this shape) and, where one exists, the graph object it stands for **by
  reference**. `ViewSelection`'s Phase 6 warning applies unchanged: decorating one of those
  writes into what `graph.json` serializes.
- **Clustering defaults on for the protocol map only.** Three of the other four views are
  already scoped by a focus node, and boxing an inheritance tree by directory fights the
  tree it exists to show. They get the cap and nothing else.

An aggregated edge carries **both** candidate weights — `count` (call sites) and `pairs`
(distinct contributing edges) — because §16's open question about which reads better is
Phase 7's to answer with a layout on screen, and answering it should be a renderer changing
which field it reads. §16 was amended to say so. Resolution folds to the **worst**
contributor, the same rule `views.ts` uses for the protocol rollup and for the same reason:
an aggregate is only as certain as its least certain member.

### Tests

`packages/core/test/aggregate.test.ts`, 17 tests, 99.7% of statements in the new module —
the one uncovered line is a documented-unreachable guard.

The `defi/` cases are hand-derived from the fixture's five files, as Phases 4 and 6
established. The scale case is a **synthesised** 300-contract graph fed through
`graphFromFile`: §7's Phase 7 exit criterion says "usable on a 300-contract project", and
the only fixture that size is `large/`, which is generated rather than committed and so is
not there in CI. It asserts the thing decision #6 is about: 300 contracts and 1,800
cross-contract call edges is **2,100 elements**, which throws unclustered, and comes to
**1,410** once clustered — five of twelve directories opened, seven left as boxes, every
contract either drawn or inside a cluster that says how many it holds. 145 ms for the whole
auto-expansion, which is 20 layouts over that graph.

One invariant is asserted on every clustering test: **no call site is lost or double
counted.** Each edge in the selection ends up in exactly one of three places — drawn,
folded into an aggregate, or counted on the cluster that hid it — and the three sum to the
original call-site total. §9 rule 3 aggregates "weighted by call count", and a weight that
quietly loses a call site is a number an auditor would read as evidence.

Two guards, in the "do not guess" category Phase 2's audit flagged as where a bug is worst:
an `expand` naming a directory that is not in the view is refused with the list of ones that
are, rather than ignored; and a selection with an edge whose endpoint is not among its nodes
is refused rather than having the edge silently dropped. `selectView` cannot produce the
second, but a caller filtering a selection by hand can, and a vanishing edge is the failure
that looks like a resolver bug three phases later.

### Why this is half a phase

§6: "If a phase turns out to be larger than expected, stop and say so rather than pushing
through." Phase 7 as written is React + cytoscape + ELK, five views, eight overlays, the
inspector, shiki code preview, search, history, the aggregation layer, `axiomap serve`, and
(via §16) the `html` and `svg` exports. That is not one session's work, and merging it into
Phase 8 silently would be the outcome §6 is warning about.

The split point was chosen by §9 rule 1's own words — "retrofitting this is miserable, build
it this way from the first commit of Phase 7" — so the aggregation layer and the cap are
first, and no renderer exists yet to be built against the wrong shape.

**Not done, and not started:** the renderer and its bundle, the five views as *rendering*
presets, every overlay, the inspector, code preview, search, history, `axiomap serve` and
its local HTTP endpoint, and the `html`/`svg` exports. Phase 7's exit criteria —
"usable on a 300-contract project; interaction stays responsive" — are **not** met: the
first half now has a tested answer at the query layer, and the second half has nothing to
measure yet.

### Deliberately not done

- **No CLI surface for aggregation.** §12 does not define one, and the three text export
  formats pipe into tools that are not a viewport — a `dot` file with 3,000 nodes is
  graphviz's problem and not a hairball on a screen. The cap belongs to the thing with a
  viewport, so `aggregate` is separate from `selectView` rather than inside it.
- **`layOut` is called once per candidate during auto-expansion** rather than updated
  incrementally. It is a pure function of the expansion set, which is the property that
  makes it obviously correct; incremental update is the thing that drifts from what it
  mirrors. Measure with a renderer in front of it before optimising.
- **`query/traverse.ts` still rebuilds its adjacency index per call** — carried over from
  Phase 6's note, still waiting on a profile rather than a guess.

### Notes for the next session

- **Phase 7b is the renderer.** `selectAggregatedView` is the only door into the graph;
  keep it that way. Every element already carries `id` and `parent`, which is cytoscape's
  compound-node shape, so the adapter should be thin.
- **Overlays come after the renderer, not with it.** §11's channel budget is a contract:
  node fill is review state, border colour is access control, border *style* is resolution
  confidence, opacity is reachability, badges are danger ops and findings, size is
  complexity. An aggregated edge has a `resolution` (the worst contributor) and a `count`,
  which is what edge style and weight need.
- **A cluster needs its own visual vocabulary**, and it is not in §11's table: it carries
  `members` and `internalEdges` precisely so a collapsed box can say "48 contracts, 291
  calls inside" and tell the user where drilling in is worth it.
- **`axiomap serve` is still registered and still refuses.** It is where §9 rule 1's
  browser-mode HTTP endpoint goes, and the endpoint's payload is an `AggregatedView`.

---

## Phase 7b — The renderer, the five views, layout in a worker, `axiomap serve`

**Date:** 2026-08-05
**Status:** partial phase, deliberately — the second of three. `pnpm check` and
`pnpm check:network` both green. **Phase 7c is the remainder: overlays, the inspector,
shiki code preview, search, history, and the `html`/`svg` exports.**

### Exit criteria

Phase 7's own criteria are "usable on a 300-contract project; interaction stays
responsive", which belong to the whole phase. These are 7b's, taken from the four things
this session was scoped to.

| Criterion | Result |
|---|---|
| A renderer | pass — React 18 + cytoscape, `packages/webview`, built by Vite into `dist/web/` and served as static files. `test/app.test.tsx` mounts it; `test/bundle.test.ts` checks the built output |
| The five views as *rendering* presets | pass — `src/ui/presets.ts`, keyed by core's `ViewName` so a sixth view cannot be added to the engine without one. All five were driven end to end over HTTP against `inheritance/` (38 contracts): protocol 116 elements, inheritance 154, state-access 129, contract 34, call 9 |
| Layout in a worker (§9 rule 6) | pass — elkjs's own worker; the graph renders unlaid-out first and animates into position when the layout lands. Asserted three ways: the entry chunk contains no ELK and a separate asset does, the staleness rule has unit tests, and `test/browser-smoke.test.ts` checks a real browser reports `layout N ms (worker)`. **This criterion was reported as passing once while the layout engine was throwing on every view** — see below |
| `axiomap serve` | pass — `packages/cli/src/serve/`, 11 tests in `packages/cli/test/serve.test.ts`, run against a copy of `defi/` **with its artifacts deleted** |
| The webview reaches the graph only through `selectAggregatedView` | pass — one data route, `/api/view`, and it is one call to that function. `serve.test.ts` asserts there is no route that returns the graph; the package cannot import a core *function* at all (§5), so this is structural rather than a convention |
| No overlays, no inspector, no `html`/`svg` export | pass — none written. §16's export entry records the second deferral with its reason |

`pnpm check` is green: 373 tests in `core` (365 from Phase 7a, 8 new), 79 in `cli` (68
from Phase 7a, 11 new), 39 in `webview` (0 before), and 18 repo-level (14 + 4 new).

### What was built

- **`core/src/query/protocol.ts`** — the host's half of §9 rule 1's wire format:
  `ProjectMeta`, `ProtocolError`, and `decodeViewRequest`. The webview owns the encode
  (`packages/webview/src/protocol.ts`), because §5 lets it import core's types and not its
  functions. Two implementations of one format drift silently — a UI spelling the hop
  limit `depth` against a host reading `down` draws a graph that is *wrong* rather than
  raising an error that is loud — so `test/serve-protocol.test.ts` at the repo root, which
  belongs to neither package, asserts that decoding what the UI encodes returns the
  request it started from.
- **`packages/webview`** — `bridge.ts` (the `HostBridge` interface both hosts implement,
  plus browser mode's `HttpBridge`), and `src/ui/`: the five presets, the
  `AggregatedView` → cytoscape translation, the stylesheet, the ELK worker and its client,
  the navigation reducer, the toolbar and the canvas.
- **`packages/cli/src/serve/`** — the local HTTP endpoint (`/api/meta`, `/api/view`, and
  the bundle as static files) and the resolver that finds the built bundle.

### Everything the UI knows, it asked for

§9 rule 1 is the reason this phase exists in this order, and it ended up enforced by the
package boundary rather than by discipline: `@axiomap/webview` may import core's *types*
only (§5), so there is no expression it could write that produces an `AxiomapGraph`. The
one door is `HostBridge.view`, the host answers it with `selectAggregatedView`, and
`/api/meta` carries the `graph.json` header — §4's mode, its copy, the resolution score —
with the nodes and edges removed. That header is built from an explicit field list rather
than a rest-destructure, so a field added to `GraphFile` later is not published by
accident.

Navigation is drill-down and only drill-down: a directory opens, a contract opens into its
members, a function opens into the call graph rooted on it. That is not a placeholder for
the search palette — §9 rule 4 requires the call graph to have a focus node, and every
other way of choosing one (a search palette, an inspector, a list of every function) is
either later in §11 or is the full graph wearing a different hat.

### The layout finding, which was worth the measurement

§9 rule 6's whole argument is that layout is slow enough to need a worker, and it turns out
to be slower than expected. On a deliberately dense synthetic 300-contract map — 125 drawn
contracts, 875 cross-directory call edges, 1,012 elements, the shape Phase 7a measured —
ELK layered took **37 seconds**.

Four fifths of that was one option this session had added for tie-break stability:

| ELK options | dense map | realistic density |
|---|---|---|
| `considerModelOrder: NODES_AND_EDGES` (as first written) | 37,108 ms | |
| default (option removed) | 8,206 ms | 761 ms |
| `thoroughness: 4` | 5,504 ms | 537 ms |
| `thoroughness: 1` | 3,763 ms | 416 ms |
| `mrtree` / `stress` instead of layered | 116 / 136 ms | |

`considerModelOrder` was removed and `thoroughness` set to 4 — measured, not chosen, and
the numbers are in the comment beside them. The remaining ~6 s on the adversarial case is
a §16 entry rather than a fix: the two settings that mattered are already taken, what is
left is layered layout's own cost on a graph that may not exist outside a generator, and
rule 6 bounds the damage — the elements are on screen and interactive throughout, and the
layout animates in when it lands. The alternatives are 50x faster and a worse *reading* of
a call graph, which is why neither was taken blind.

`packages/webview/test/scale.test.ts` keeps the number honest, as a **tripwire rather than
a budget** (§9 sets none for layout): it fails above 20 s, which is a 3x headroom on a
worst case and would still catch the 37 s regression it was written for.

### Deviations from the spec

- **`cytoscape-elk` is not used; `elkjs` is driven directly.** *(§3's rendering row
  amended.)* The adapter constructs its own `ELK` and runs it on the main thread, which is
  precisely what §9 rule 6 forbids — "layout in a web worker … never block on layout".
  Doing it by hand is about forty lines: post the ELK graph to a worker, apply the
  positions with cytoscape's `preset` layout. Rule 6 is then true rather than
  approximated, and there is a bundle-level test that says so.
- **The CLI depends on `@axiomap/webview` for its built files, and imports none of its
  code.** §5's permitted graph is `cli → core`, and this does not change it: `serve` needs
  an `index.html` and its assets to hand a browser, which is a file-serving relationship.
  The ESLint rule still forbids every import of that package from the CLI and
  `dependency-direction.test.ts` still proves the rule bites; `test/serve-protocol.test.ts`
  adds the other half, asserting that no import statement anywhere in `packages/cli/src`
  names the package whatever the linter is currently configured to catch. The dependency
  entry exists so pnpm links it and Turborepo builds it first.
- **`packages/webview` has two tsconfigs.** `tsconfig.json` emits the node-side surface
  (the bridge, the encoding) into `dist/`; `tsconfig.ui.json` typechecks the bundled half
  with `moduleResolution: Bundler`, JSX and the DOM, and emits nothing. The UI resolves
  modules the way Vite will resolve them — a CSS import, a `.tsx` entry and
  `elkjs/lib/elk.bundled.js` are all things `NodeNext` reads differently from the bundler
  that will actually build them.
- **React is pinned to 18**, which is what §3 names. `pnpm add react` installs 19; the spec
  says 18 and nothing here needs 19.
- **The root `package.json` gained two workspace devDependencies.** `test/` holds
  invariants that span packages, and the new one has to import both sides of the protocol
  to compare them.
- **`serve` does not go through `program.ts`'s `emit`.** It is §12's one long-running
  command: it prints its banner, then the action waits for the server to close.
- **The graph is built once, at startup.** §12 defines `serve` as "build + open the UI in a
  browser"; re-graphing per request would put a multi-second parse behind a click, and
  watching for edits is Phase 8's artifact watch. The banner says so.
- **`--host` exists and defaults to loopback.** Decision #2 is about outbound connections
  and a local server is not one, but the spirit is the same: this tool is pointed at
  confidential client code and its graph should not reach a coffee-shop LAN because a
  default was convenient. Binding anything else prints what was just published.

### Then it was pointed at a browser, and four things were wrong

The session first reported that no browser could be run here — headless Chrome and Firefox
both hung — and that the renderer was therefore verified everywhere except on screen. That
turned out to be wrong in the cheapest possible way: the hangs came from `--no-sandbox` and
`--user-data-dir`, not from headless mode. Without those flags it runs.

Everything below was found in the next twenty minutes, by looking. Every one of them
passed the entire test suite first.

- **The layout engine was dead.** `new ELK()` threw `o is not a constructor` inside the
  worker, on every view, from the first commit. The cause is that `elk.bundled.js` spawns
  *its own* worker and, from inside one, falls back to a path this bundling leaves
  undefined. Nesting a worker around elkjs was the mistake; it owns that boundary itself,
  and `layout/client.ts` now wraps `elk-api` with the staleness rule and no worker file of
  our own. §9 rule 6 still holds — `elk-worker.min.js` is emitted as its own asset and the
  bundle test still checks the entry chunk is free of ELK.
- **And nothing said so.** The rejection landed in the `catch` that swallows a superseded
  request, so a dead layout engine was indistinguishable from a slightly ugly graph — in a
  tool whose entire argument is honesty about what it knows. The status bar now
  distinguishes `layout 154 ms (worker)` from `layout failed: …`.
- **Directories were not places.** `hierarchyHandling: INCLUDE_CHILDREN` flattens the
  compound hierarchy, so two contracts in one directory could land at opposite ends of the
  canvas — and since a cluster's box is fitted around its children, that directory's box
  then wrapped half the map with everything unrelated inside it. §9 rule 3's drill-down was
  pointing at nothing. It is `SEPARATE_CHILDREN` now, which is also **23x faster** on the
  dense 300-contract map (6.2 s → 272 ms).
- **Two fit bugs.** A cluster's box is resized *after* its children move, so the fit that
  runs with the layout measures stale boxes and crops the result — it cost the right-hand
  edge of the protocol map. And unbounded fit zooms *in* until the graph fills the
  viewport, turning nine contracts into nine billboards, which is the opposite of §11's
  "information density over whitespace". Fit runs again on `layoutstop`, clamped at 1.75.

Two smaller ones, same origin: an expanded cluster drew its own path as a second label line
that collided with its sibling's, and the server answered `/favicon.ico` with a 404 that
sat in the console of a tool asking to be trusted.

The measurements recorded earlier in this entry were taken *before* the hierarchy fix and
are corrected in the preset's comment. The order they were found in is the lesson: an hour
went into tuning `thoroughness` for a 2x while a 23x sat one line below it, undiagnosed,
because the layout being applied at all was never checked.

### What keeps it checked

`test/browser-smoke.test.ts`, at the repo root because it needs the CLI and the bundle
together. It drives Chrome over the DevTools protocol using Node's built-in `WebSocket` —
no new dependency — loads the served page, and asserts that the status bar reports a
worker layout, that it does not report a failure, and that the page logged no error. A
second case taps a contract node and checks the view drills down to it.

It skips when no Chrome is on `PATH`, the way `core`'s worker tests skip without a build,
so CI without a browser stays green and a developer with one gets the check. **The suite
that shipped a dead renderer was 39 tests green**; this is the one that would have failed.

### Still not verified

Density at scale. Everything screenshotted here is a 9-contract fixture; nobody has looked
at a 300-contract map in a viewport, and §9's cap allows 50% more elements than the
synthetic case `scale.test.ts` measures. That belongs to Phase 7c, with a real protocol.

### §16 changes

- **Added Tier 2 — layout time on a dense protocol map**, with the measured table, what
  was already fixed, and what the remaining options would cost in legibility.
- **Noted the second deferral of `export --format html|svg`.** Its trigger has now fired —
  there is a bundle to inline — and it is Phase 7c's, because an export that ships before
  the overlays shows a client less than the tool shows its operator.
- **Corrected the layout-time entry** after the hierarchy fix: the dense 300-contract map
  is ~430 ms, not the 6.3 s first recorded, and the entry now names the two settings that
  decide it.
- **Answered the open question on aggregate edge weighting with a default, not an answer.**
  The renderer reads `count`, since §9 rule 3 says "weighted by call count" in as many
  words and the weight is logarithmic, so the two candidates would look alike at every size
  the cap allows. Comparing them properly wants a real protocol on screen.

### Notes for the next session

- **Phase 7c is overlays, the inspector, code preview, search and history.** Screenshot
  every one of them while building it: this session's four worst defects were all invisible
  to a green suite and obvious in one image.
- **Members are not nested inside their contract in the inheritance view.** Phase 6 put
  `scope` on those nodes precisely so a renderer could parent them; 7b draws them as
  free-floating boxes joined by `implements` edges, which is correct and less legible than
  it should be. §11's channel budget is the contract: node fill
  is review state, border colour is access control, opacity is reachability, badges are
  danger ops and findings, size is complexity. 7b deliberately claims none of them;
  `style.test.ts` asserts that no node rule but the neutral base touches fill or opacity,
  so an overlay arriving later finds its channel free.
- **The inspector must not get a second implementation of the query API.** Phase 6's note
  still stands, and now has a second half: everything it wants to show — callers, callees,
  attributes — has to arrive through `HostBridge`, because the package cannot reach a
  graph.
- **`ProjectMeta` is the place to add whatever the UI needs that is not a subgraph**, and
  it is an explicit field list on the server for that reason. Review state and imported
  findings are both files the host reads, not graph content, and both are 7c's.
- **Phase 8 implements `HostBridge` over `postMessage`** and renders the same `App`. The
  bundle already uses relative asset paths, and every colour already comes from a
  `--vscode-*` variable with a browser fallback — setting the variables is the whole of the
  theme work, and `style.test.ts` pins that there is no hard-coded hex outside the fallback
  table.
- **`serve` re-reads nothing.** If Phase 8's artifact watch wants a live graph, the seam is
  `ServerOptions.graph`: it is held once and read per request.

---

## Phase 7c — The eight overlays and the inspector

**Date:** 2026-08-05
**Status:** partial phase, deliberately — the third of four. `pnpm check` and
`pnpm check:network` both green. **Phase 7d is the remainder: shiki code preview, the
`/` search palette, breadcrumb + back/forward history, and the `html`/`svg` exports.**

### Exit criteria

Phase 7's own criteria belong to the whole phase. These are 7c's, taken from what this
session was scoped to.

| Criterion | Result |
|---|---|
| §11's eight overlays, all of them | pass — `packages/webview/src/ui/overlays.ts`, all eight toggleable and combinable. Every one was screenshotted in Chrome in the view where it applies, and each was seen to change what is on screen |
| They hold to §11's channel budget | pass — the allocation is data in `overlays.ts` and a test asserts no class is produced by two overlays; `style.test.ts` pins each channel's rule list. §11's table is amended for the one overlay it left without a channel, below |
| The inspector | pass — `Inspector.tsx`: §10's attributes in full, members, incoming and outgoing relations with their call sites, all clickable, plus this node's review entry and imported findings |
| The inspector reaches the graph only through `HostBridge` | pass — `HostBridge.inspect` → `/api/node` → `inspectNode`. There is no second implementation and cannot be: §5 leaves this package unable to hold an `AxiomapGraph`. `test/inspect-node.test.ts` asserts the answer covers relations the drawn view does not contain |
| No code preview, no search palette, no history, no `html`/`svg` export | pass — none written; they are 7d's |
| Screenshot every overlay in a real browser | pass — 14 screenshots across the protocol map, contract detail, the call graph and the state-access map. Four defects came out of them, below |

`pnpm check` is green: 381 tests in `core` (373 from 7b, 8 new), 68 in `webview` (39 +
29), 82 in `cli` (79 + 3), and 23 repo-level (18 + 5, two of them in a browser).

### What was built

- **`core/src/query/overlays.ts`** — the projection of the two audit-state files onto
  node ids. Six of §11's overlays read attributes the graph already carries; review
  state (`.axiomap/review.json`, §8) and imported findings (`.axiomap/findings.json`,
  decision #4) are files the host reads, and 7b's notes had already put them here.
  Staleness travels beside status rather than folded into it, because §8's flagship
  feature is precisely the difference between the two.
- **`core/src/query/inspect.ts`** — `inspectNode`. `declares` comes back as
  `members`/`scope` rather than as edges, and virtual dispatch arms are marked and
  down-graded to `ambiguous` whatever the static edge claims.
- **`packages/webview/src/ui/overlays.ts`** — the channel allocation as data, the
  per-node decoration, and the legend. **`badges.ts`** draws the badge channel as one
  SVG strip per node, since cytoscape gives a node one label and one background image.
- **`Inspector.tsx`, `OverlayBar.tsx`** and their CSS.
- **Two more routes on `axiomap serve`** — `/api/node` and `/api/overlays` — and the
  `serve` command now reads the two audit-state files and says on the banner what it
  found.

### §11's table had a channel for seven of the eight

The budget allocates node fill, border colour, border style, opacity, badges and size
— and names seven overlays across them. The **reentrancy surface** has no row, and
§11's own rule is that an overlay which cannot be given a free channel does not ship.

It went on badges, and §11 is amended to say so. Badges are the one channel that is
explicitly *stackable* and already had two tenants, each owning a glyph rather than a
visual property; a third glyph is what that channel is for, and it is the only
allocation that evicts nothing. `R`, red unguarded and green guarded.

The other shared row, **border colour — "access control & attack surface"**, is §11's
own doing and needed a precedence rather than a coin toss: where access control has a
verdict about a function, it takes the border, because "externally callable with no
recognised guard" is strictly more specific than "externally callable". Attack surface
keeps opacity outright and colours the entrypoints access control says nothing about.
That is decided once in `decorate`, not by which cytoscape rule happens to come last.

### Then it was pointed at a browser, again

7b's lesson was taken literally: every overlay was screenshotted as it was built, on a
scratch copy of `defi/` with four reviews recorded (one deliberately made stale by an
edit), four imported findings (one stale for the same reason), and its artifacts intact.
Four things came out of it that the suite was green through.

- **Six of the eight overlays decorated nothing on the protocol map, and said nothing
  about it.** The map draws contracts; access control, danger ops, reentrancy,
  complexity, review and findings are all about functions. Turning one on produced a
  legend, no change on screen, and a picture indistinguishable from a clean result —
  the exact silence §4 refuses everywhere else in this tool. `overlayCoverage` now
  counts what each active overlay actually marked, and an overlay that marked nothing
  says so, in the terms of what it would have marked. The rollup that would make them
  mean something at contract level is a §16 entry.
- **The contract-detail view was illegible at fit zoom.** Twenty members lay out in one
  band thousands of pixels wide, so `fit` put the whole view at about quarter zoom:
  three-pixel labels, and every overlay a coloured smudge — in the view where the
  overlays matter most. `fit` is now clamped at a minimum zoom of 0.6 and anchored at
  the graph's top-left corner, which is the symmetric half of 7b's `MAX_FIT_ZOOM` and
  the same argument: §11's density target is about what is legible at default zoom, so
  a legible part of a graph beats an illegible whole of one. The cause — a member-heavy
  view has too few edges for layered layout to stack — is a §16 entry.
- **ELK was measuring nodes without their padding.** §11's size channel is the
  complexity heatmap and node size is label plus padding, but `width()`/`height()` are
  the label box alone. The layout was therefore spacing nodes for a size they are not
  drawn at, and the biggest, most complex functions would have been the ones overlapping
  their neighbours. Caught by measuring in the browser rather than by looking.
- **`axiomap import-findings` printed `[object Object]`** for every row's nodes column.
  A finding's `nodes` are `{ id, bodyHash }` — §8's staleness mechanism — and the table
  joined the objects. Phase 6 code, found while building this phase's fixture.

One measurement mistake is worth recording alongside them, because it nearly became a
fifth "defect": the complexity overlay looked dead when probed with `node.height()`,
which excludes padding by design. It was working. The lesson from 7b holds in both
directions — look at the screen, and check what the number you are reading means.

### Badges are one image, not eight glyphs

Cytoscape gives a node one label and one set of background images, so §11's "corner
glyphs, stackable" is a single SVG strip per node, anchored outside the top-right
corner so it never covers the label. The alternative — a third label line — would have
been one colour for every glyph, and colour is what distinguishes a `delegatecall` from
a stale informational finding. The strip is `encodeURIComponent`-encoded because a raw
`#` from a themed colour would truncate the data URI at the fragment and the badge
would silently not draw; there is a test for exactly that.

Chip size was set by looking: 13 graph units was a smudge at the 0.6 zoom a contract is
actually read at, so it is 16.

### Deviations from the spec

- **§11's badge row gained the reentrancy surface** *(§11 amended)*, for the reason
  above.
- **`/api/overlays` sends the two audit-state files whole**, which is a payload leaving
  the host that §9 rule 1 does not describe. It is not the graph: no source, no bodies,
  no edges, no attributes — a map from node id to a status a human recorded, and two
  empty objects on a project where nobody has reviewed anything. Asking per drawn node
  instead would put a round trip behind every repaint to answer a question whose entire
  input is a hand-written file.
- **A malformed `review.json` or `findings.json` is a warning and an absent overlay**,
  not a dead server. The graph is what the user asked for, and refusing to serve it over
  a file the tool can rewrite would lose them the tool.
- **An empty view now gets a notice.** §9 rule 2 gives "too much to draw" a notice and
  says nothing about "nothing to draw", but a blank canvas is the one state a user
  cannot tell from a broken one — `state-access` focused on an interface function is a
  real way to reach it.
- **A click both navigates and selects.** 7b's drill-down is unchanged; the inspector
  opens on whatever was clicked. Clicking a state variable, event or error — which did
  nothing in 7b, correctly, since none of them has a view — now opens the inspector,
  which is the first thing in this project that can say something about them.

### §16 changes

- **Added Tier 2 — overlay rollup onto contracts and collapsed clusters**, with the
  reason the webview cannot compute it and the note that the legend states the gap
  rather than hiding it.
- **Added Tier 2 — a view too wide to read at fit zoom**, recording the zoom clamp as a
  symptom fix and naming the two real ones.

### Boundary hardening, before 7d

Two things that were cheap here and would have been expensive in Phase 8, in the same
class as Phase 2's and Phase 3's boundary work.

**Nobody had ever run this UI with the `--vscode-*` variables set.** Nothing in the repo
sets one — `styles.css` and `style.ts` only read them, and `style.test.ts` exercises the
resolution rule against a stub — so every screenshot ever taken of this webview, including
all fourteen earlier in this entry, was of the browser fallback palette. That mattered
more after 7c than before it, because 7c is where the palette stopped being five borders
and became tuned constants: fills at 0.22–0.30 opacity, badge chips filled with `panel`,
dimming at 0.35. All of them chosen against one dark background, and all of them due to be
discovered in the phase whose exit criterion is Dark+, Light+ and one high-contrast theme.

Injecting a real Light+ palette found two:

- **The stale-finding badge nearly vanished.** Its tone was `dim` → `descriptionForeground`,
  which on a light editor background is a grey glyph on a near-white chip. Staleness is now
  `faded` — the finding keeps its impact colour and the chip is drawn at 55% opacity — which
  is also the better claim: what changed is whether it is still evidence, not what it said.
  `dim` now resolves to the editor foreground, so the overflow `+` chip is legible too.
- **Every badge was half a badge.** The strip straddled the node's top border, and its chip
  fill is the same `panel` colour as the node, so the overlapping half disappeared into it.
  Moving it clear made the badges vanish entirely — a node's bounding box does not include
  a background image drawn outside it, and the renderer culls what is outside. `bounds-expansion`
  is the fix, and the intermediate state (a notch erased from the border and no chips) is
  the kind of thing only a screenshot says.

`test/browser-smoke.test.ts` gained the case that would have caught the whole class: with
`--vscode-editor-background` and `--vscode-charts-blue` set before the app boots, the page
background and **cytoscape's own resolved border colour** are the host's. That is the chain
Phase 8 depends on — host variable → `getComputedStyle` → `readPalette` → cytoscape's colour
parser — and until now no test crossed more than one link of it.

**The screenshot harness is committed**, as `scripts/screenshots.mjs` / `pnpm screenshots`.
Two phases running, the worst defects here were invisible to a green suite and obvious in
one image, and twice the harness that found them was rebuilt in a scratch directory and
thrown away. It takes `--theme browser|light|hc-dark`, walks the eight overlays, and writes
to a gitignored `docs/screenshots/`. `browser-smoke.test.ts` remains the asserted version;
this is the exploratory one, and Phase 8 is the phase that needs it most.

### Notes for the next session

- **Phase 7d is code preview, search, history and the `html`/`svg` exports**, and then
  the Phase 7 boundary audit — which belongs to whichever session closes the phase, and
  should cover 7a, 7b and 7c together the way Phase 2's and Phase 3's audits did.
- **Screenshot everything, again.** Four of this session's findings and four of 7b's
  were invisible to a green suite and obvious in one image. `test/browser-smoke.test.ts`
  now has four cases; the scratch harness that took the screenshots is not committed,
  and it is about forty lines of CDP on top of that file's `Page` class.
- **The inspector is where NatSpec would land.** §16's entry names the Phase 7 inspector
  as its trigger, and this is now the panel it meant; the field is still not collected
  by the parser.
- **`ProjectMeta` gained nothing this phase**, and the two new endpoints are why: audit
  state is per node and belongs beside the nodes, not in the header.

---

## Phase 7d — Code preview, search, history, the `html`/`svg` exports, and the phase boundary

**Date:** 2026-08-05
**Status:** **Phase 7 complete.** `pnpm check` and `pnpm check:network` both green. This
session was the fourth of four and owns the phase boundary, so it also carries the audit
across 7a–7d and Phase 7's own exit criteria.

### Phase 7's exit criteria

§7 gives the whole phase two, and neither had been tested in a viewport before this session
— 7b's entry is explicit that density at scale had "only been measured".

| Criterion | Result |
|---|---|
| **Usable on a 300-contract project** | pass — a generated **298-contract, 22k SLOC** project, served and driven in Chrome. All 298 contracts drawn, 718 of 1,500 elements, every directory a labelled box, ~0.63 zoom, labels legible. 888 ms to ingest and graph, 981 ms to lay out |
| **Interaction stays responsive** | pass — zoom and pan **2 ms**, drill into a directory **580 ms** end to end, overlay toggle **844 ms**, search across the project **450 ms**. Layout is in the worker throughout (§9 rule 6), so the viewport is live while it runs |

Pushed nine times further as a stress case: a **2,719-contract, 200k SLOC** project ingests
and serves in **4.7 s** (§9 rule 5's warm budget is 5 s) and draws 869 of 1,500 elements
with a 747 ms layout. It stays honest — "235 of 2,719 nodes drawn, 11 directories collapsed
— expand one to drill in" — but the map opens lopsided, one directory wide open and eleven
boxed. That is a §16 entry, below, not a fix: the remedy is an information-design decision.

### 7d's own criteria

| Criterion | Result |
|---|---|
| §11's inline shiki code preview | pass — `CodePreview.tsx` over `core/source/slice.ts`, with the Solidity grammar and a theme built from the host's palette. Screenshotted in all three themes |
| §11's `/` fuzzy search palette | pass — `SearchPalette.tsx` over `query/search.ts`. Matched and capped host-side; a caller cannot raise the cap |
| §11's breadcrumb + back/forward history | pass — `history.ts` wraps the navigation reducer; `Breadcrumb.tsx` draws the trail. Alt+←/→, and every crumb is a jump |
| §12's `export --format html` | pass — 3.0 MB self-contained file, the webview in one document, elkjs attribution in the footer |
| §12's `export --format svg` | pass — the same `ViewSelection`, laid out by the same ELK |
| The Phase 7 boundary audit (§6) | pass — below. Three findings, all fixed |
| Screenshot everything in a real browser | pass — 14 shots × 3 themes via `pnpm screenshots`, plus the export and the SVG driven in Chrome directly. **Six defects came out of them** |

`pnpm check` is green: **403** tests in `core` (381 from 7c, 22 new), **99** in `webview`
(68 + 31), **96** in `cli` (82 + 14), and **29** repo-level (23 + 6, six of them in a browser).

### The source endpoint, which is the one that needed deciding

Every payload that had crossed §9 rule 1's bridge was graph-derived. A code preview is the
first that ships **the client's actual source** to a browser, so it got its own module and
its own rules rather than an entry in `query/` — which is deliberately `fs`-free, and which
the webview consumes as types.

It is `core/source/slice.ts`, not the CLI's, because Phase 8's host implements the same
`HostBridge` and a slice living in `packages/cli` would be reimplemented there — the second
implementation 7b's notes forbid for the inspector.

**The request names a node, never a path.** That is the whole security design, and it is
structural rather than careful: the caller supplies an id, `sliceNode` takes the file from
the graph, and there is no parameter through which a file could be named. The obvious
convenient shape — "lines 40–80 of `src/Vault.sol`" — turns a graph viewer into a file
server for whatever the process can read, on a tool pointed at confidential client code.
`test/serve-protocol.test.ts` asserts the *absence* of a file parameter on both sides.

Two more properties it has to have, both tested: offsets are **bytes** (§10's warning, and
`pathological/`'s `Crlf.sol` is the fixture that catches a character-offset implementation),
and it reports **drift** when the file no longer matches the graph — `serve` builds once
(§12) and `.axiomap/graph.json` can be older still, so a preview confidently showing the
wrong function is the ordinary consequence of editing while the tool is open.

### Then it was pointed at a browser, again, and six things were wrong

7b's and 7c's lesson held for a third time. Every one of these passed the full suite first.

- **Shiki rendered monochrome code.** `settings` and `tokenColors` are the *same field* and
  shiki prefers the former — so supplying a rule list under one and an empty array under the
  other to satisfy the type meant every token came back with the default colour. Nothing
  threw. It reads as a styling choice.
- **The search palette matched almost everything.** `mint` returned 23 rows on the
  nine-contract fixture — `sqrt`, `Sync`, `quote`, `FEE_DENOMINATOR` — because the fuzzy tier
  ran a subsequence over the whole node id, and any path deep enough contains any four
  letters in some order. It runs over the qualified name now, with a bound on how spread out
  a match may be. Seven rows, all relevant.
- **The syntax colours were illegible on a light host.** The fallbacks are Dark+'s token
  colours, correct against browser mode's own dark background and pale-yellow-on-white
  against a host that sets a light editor background without setting `--vscode-symbolIcon-*`.
  Palette entries may now name a **second variable**, so those fall through to a
  `--vscode-charts-*` the same theme chose for the same background.
- **Every function click in the HTML export missed.** The exporter embedded
  `{view:'call', focus}`; `navigation.ts` sends `{view:'call', focus, up, down}`. A 49-view
  file in which none of the views was the one being asked for. The export's hops are its
  `meta.callDefaults` now, which is what the UI initialises from.
- **Collapsed directories in the export could not be opened** — their expansions were never
  embedded.
- **The SVG header clipped the note mid-word**, and sizing the image to hold the sentence
  made a 300 px call graph a 1,000 px picture that is mostly whitespace. It wraps.

A seventh came from the 298-contract run and is in the audit below.

### What the exports turned out to be

**`--format html` is the webview in one file**, which is what §7's Phase 9 settles when it
says the file "redistributes" elkjs. Three things followed from there being no process on
the other end, and none of them was obvious from §16's entry:

- **A third `HostBridge`.** `StaticBridge` answers from an inlined payload. The UI does not
  learn which bridge it got — which is the claim the deliverable makes: a client opening it
  gets the tool, not a picture of it. It having worked unchanged is also the strongest
  evidence so far that the Phase 8 boundary is in the right place.
- **"The graph embedded" (§12) had to be read against §9 rule 1.** What is inlined is the
  *answers a host would have given* — views, inspections, source ranges, the two audit-state
  files — because an `AxiomapGraph` in a file sent to a third party is the one place
  breaking rule 1 would be permanent. A question the payload does not answer is a stated
  refusal naming how many views the file holds.
- **A single-chunk build config.** The served bundle splits ELK into its own asset (§9 rule
  6) and loads shiki's grammar lazily; a single file can fetch neither. `vite.export.config.ts`
  builds the same UI with one chunk, and elkjs's worker is inlined and started from a
  `Blob` — which is the sense in which the file redistributes it.

**`--format svg` is a serializer, not a second layout engine.** The thing §16 refused was a
second answer to *where things go*; this calls the same elkjs. What is written twice is the
drawing, because cytoscape needs a DOM and a CLI has none. Its colours are literal, which is
not a §11 violation: §11's rule is about a webview that inherits a host's theme, and an SVG
opened in an image viewer has nothing to inherit from.

### Pre-Phase-8 audit

Phase 7 was audited at the boundary the same way Phases 2, 3, 5 and 6 were, asking what is
cheap now and expensive once Phase 8 is reading it. Phase 8 implements `HostBridge` over
`postMessage` and renders the same `App`, so the boundary is that interface and the theme
chain behind it. Three findings.

- **A comment claimed a test that did not exist.** `webview/src/static.ts` said the
  repo-root suite pinned its `sameViewRequest` against core's copy. It did not — and core's
  copy was exported and never called, so there were two implementations of one comparison
  with one of them dead. Precisely the failure Phase 6's audit found in `store.ts`, whose
  header described staleness handling the file did not have. The pair is pinned now, over a
  table that includes the hop-limit mismatch the export shipped with.
- **Three branches in `source/slice.ts` had no test**, found by coverage the way Phase 2's
  audit found its two bugs: the guard refusing a node whose file resolves outside the
  project, the unreadable-file path, and the SourceUnit whole-file case. The first is the one
  that matters — unreachable by any request, reachable by a graph built elsewhere, and this
  process can read a client's whole checkout. Asserted now against a hand-edited graph, which
  is the case it exists for.
- **The palette was read once and could not survive a theme change.** VS Code rewrites
  `--vscode-*` on the document without reloading the webview, and Phase 8's exit criterion is
  legibility in Dark+, Light+ and a high-contrast theme — which anyone checks by switching
  between them. `GraphCanvas` re-read the palette on every element update while `App`
  memoised it forever, so a switch would repaint the graph and leave the badges and the
  syntax highlighting on the old theme. There is one palette now, it is state, and a
  `MutationObserver` refreshes it. Verified in Chrome: changing two variables live moves both
  a node border and a keyword colour, no reload.

And one defect the 298-contract run surfaced, which is a §9 rule 3 failure rather than a
boundary issue: **a directory opened by 7a's auto-expansion could not be closed.** The click
toggled membership of the `expand` set, and the box was open without being in it — so the
first click did nothing and only the second closed it. It toggles what is *drawn* now, and
takes expansion over from the engine when it does. `browser-smoke.test.ts` has the case;
the reducer's own tests never caught it because they had never been given a cluster that was
open without having been opened.

### Deviations from the spec

- **`@axiomap/webview` gained `shiki`, and `@axiomap/cli` gained `elkjs`.** Both are §3's
  own choices arriving where §7 puts them. The CLI imports `elk.bundled.js` rather than
  `elk-api.js`: the latter refuses to construct without a worker, and a CLI writing a file
  has no viewport to keep responsive.
- **`sameViewRequest` is written twice**, in `core/query/static.ts` and
  `webview/src/static.ts`, for the same §5 reason `encodeViewRequest`/`decodeViewRequest`
  are — the boundary is types-only and §6 forbids adding exceptions to the lint rule. Pinned
  at the repo root, as the other pair is.
- **`packages/webview` has a third build.** `tsconfig.json` emits the node surface,
  `tsconfig.ui.json` typechecks the bundled half, and `vite.export.config.ts` builds the
  single-chunk bundle the export inlines.
- **`export --format html` refuses stdout.** The other four are text to pipe; this one is
  three megabytes and dumping it into a terminal is never what was meant.
- **The palette entry table now allows more than one variable per entry.** The last string
  is the literal fallback and everything before it is tried in order. Only the syntax
  entries use it, for the reason above.
- **`NavState` gained `autoExpand`.** The UI takes expansion over from the engine the first
  time a cluster is clicked; leaving auto-expansion on would reopen what was just closed.

### §16 changes

- **`export --format html|svg` marked shipped**, with the three things that turned out to be
  decisions rather than plumbing.
- **NatSpec re-deferred, explicitly.** §16 named the Phase 7 inspector as its trigger and
  that panel exists — so this was a decision, not an oversight. It is a *parse-layer* change:
  `parse/` collects no comments at all, so it needs the doc comment in the neutral AST, a new
  schema field, `GRAPH_SCHEMA_VERSION` 4 → 5, and a regeneration of all four goldens. Landing
  that in the last hour of the phase whose criteria are about a viewport is what §6's phase
  discipline says not to do, and §6 is emphatic that golden diffs are read and justified
  rather than swept through. One risk is already handled — `diff/classify.ts` compares an
  explicit allowlist, so the "NatSpec typo reads as a modification" failure stays prevented —
  and two questions are still open. Owner: Phase 8 or a 7e, as its own change with its own
  golden commit.
- **Added Tier 2 — auto-expansion spends the render cap on one directory**, with the
  2,719-contract measurement, the 298-contract numbers that show the exit criterion holds,
  and why the fix is an information-design decision rather than a line of code.
- **The open question on aggregate edge weighting is still open**, now with a reason to
  expect the comparison to be uninformative: what limits a 298-contract map's legibility is
  the *number* of edges crossing it, not how any one is weighted.

### Notes for the next session

- **Phase 8 is the VS Code extension**, and the seam it needs is done: `HostBridge` has six
  methods, all request/response, and a third implementation of it (`StaticBridge`) already
  exists and works. Implementing it over `postMessage` is correlation ids and nothing else.
- **The `source` bridge method has one VS Code-specific question.** It reads from disk, and
  the editor may hold unsaved changes — so a preview can disagree with what the user is
  looking at in a way `drifted` will not catch. The extension knows the buffer; the slice
  should probably come from it.
- **`pnpm screenshots` now covers 7d's surfaces too** — the code preview, the palette and
  the breadcrumb — and it is the harness that found six of this session's defects. Phase 8 is
  the phase that needs it most: its exit criterion is three themes.
- **`fixtures/large/generate.mjs --sloc 22000` makes the 298-contract project** used for the
  exit criterion. It is not committed (§14) and takes a second to regenerate.

---

## Phase 7e — Consolidation before Phase 8: the export payload, the reader, the licence gate

**Date:** 2026-08-05
**Status:** complete. `pnpm check`, `pnpm check:network` and the new `pnpm check:licences`
all green. Not a feature phase — three things measured at the 7d boundary that get
structurally more expensive after Phase 8 and Phase 9, taken while they are still cheap.

Every number below was reproduced before anything was changed, on a generated
298-contract / 22k SLOC project (`node fixtures/large/generate.mjs --sloc 22000 --out
mid300`, not committed).

### The three items

| Item | Result |
|---|---|
| **1. The html export's payload** | pass — `payloadVersion` 2. A stated quota per view kind, and one node table. Re-verified in a real browser at 298 and 2,719 contracts |
| **2. `StaticBridge` coverage** | pass — **4.85% → 100%** statements, branches, functions and lines, over 27 tests |
| **3. A licence CI job** | pass — `scripts/check-licences.mjs`, `pnpm check:licences`, its own job in `ci.yml`, and a test that watches it fail |

`pnpm check` is green: **403** tests in `core` (unchanged), **126** in `webview` (99 + 27),
**101** in `cli` (96 + 5), and **45** repo-level (29 + 16).

### 1. The export embedded 190 views and none of them was a call graph

Both defects reproduced exactly, and both are things `payloadVersion: 1` being unpublished
made free to fix now and a v2 reader to fix later.

**Zero call views fit.** 12.6 MB, 190 embedded views — 1 protocol map, 189 contract views,
**0 call graphs** — and 1,061 omitted. The walk was breadth-first over a single queue, so
the contract views reached `VIEW_SHARE`'s ceiling before the first function was reached.
§9 rule 4 makes the call graph the focus-node view and §11 makes it the one an auditor
works in, so a deliverable that can never hold one is §15's ninth item not working.

Raising the ceiling does not fix that; it buys more contract views. So the fix is a stated
policy, `VIEW_QUOTA` in `packages/cli/src/export/html.ts`:

- **map 0.15, contract 0.35, call 0.5** of the view budget. `call` is largest because it is
  the only kind whose absence turns a click into a refusal rather than into a
  less-detailed answer; `map` is smallest because a project has tens of directories rather
  than thousands of functions.
- **Round-robin between the kinds**, so `call` starts being embedded as soon as the first
  contract view has produced one rather than after every contract view has been considered.
- **Unspent quota is pooled and offered back**, which is what makes the rule free on a
  project small enough to embed whole — `defi/`'s queues run dry before any kind closes.
- **A closed kind's remaining queue is counted, not walked.** Computing a thousand views to
  reject them costs seconds and tells the reader nothing the number does not.

It is written in the module rather than left to emerge from a traversal order because "how
much of what" is exactly the kind of thing that otherwise gets decided twice.

**2.1x node duplication.** 2,073 distinct nodes carried as 4,421 node objects: every
`AggregatedView` held whole `GraphNode`s, and every `NodeInspection` held the same node
again. Payload v2 has one `nodeTable`; views and inspections hold ids.

It is deliberately not called `nodes`. A top-level `nodes` beside an `edges` would be a
`graph.json` under another name, and §9 rule 1 is the rule the export is the permanent
place to break. The two properties that keep it a table: nothing in it that no embedded
view draws, and no adjacency anywhere in it. `export-rendered.test.ts` asserts both, and
the assertion that the payload has no `nodes` property survived unchanged.

**Measured after, on the same project:**

| | v1 (7d) | v2 (7e) |
|---|---|---|
| Views | 190 — 1 protocol, 189 contract, **0 call** | **765** — 1 protocol, 88 contract, **676 call** |
| Views omitted | 1,061 | 428 |
| Node objects / distinct nodes | 4,421 / 2,073 = **2.13x** | 1,570 / 1,570 = **1.00x** |
| Payload JSON | 10.37 MB | 8.51 MB |
| File | 12.6 MB | 10.7 MB |

Four times the views, in a smaller file.

**At the 2,719-contract / 200k SLOC size** (`--sloc 200000`), where it now stops: 699 views
— 1 protocol, 82 contract, 616 call — 582 omitted, 11.1 MB, 33 s end to end (dominated by
ingesting 200k SLOC, not by the export). It opens from `file://` in Chrome and draws 869 of
1,500 elements with a 1,953 ms worker layout. There is no size at which the zero-call-views
pathology returns, because the quota is a floor rather than an ordering.

**Re-verified in a browser, and that is now a test.** 7d drove protocol → contract →
function → inspector → code preview by hand over CDP against a `file://` URL and found that
every function click missed. That walk is `test/browser-smoke.test.ts`'s "the export in a
browser" describe now: it exports `defi/`, opens the file with no server and no origin,
and asserts each step, plus that the payload's views hold *ids* while cytoscape holds nodes
with §10 attributes — which is `hydrateView` running in a browser against a file the CLI
wrote.

### The boundary, and a third written-twice pair

§5 lets `@axiomap/webview` import core's types and not its functions, so v2 adds a pair:
`dehydrateView`/`dehydrateInspection` in `core/query/static.ts`, `hydrateView`/
`hydrateInspection` in `webview/src/static.ts`. It drifts more quietly than the two pairs
already there — a hydrator that dropped `parent` would draw a node *outside* the directory
box it belongs to, which reads as a layout quirk rather than an error.

`test/serve-protocol.test.ts` pins it, over a view holding every element shape, by
identity rather than field by field: the fields that matter are the ones nobody thought to
list. It also pins that the writer's `PAYLOAD_VERSION` and the reader's
`READS_PAYLOAD_VERSION` are the same number. That file's header now says there are three
such pairs and why each earns a test.

### 2. `StaticBridge` was 4.85% covered

It is the reader half of the client deliverable — the third `HostBridge`, and the one a
*client* is actually using — and every path in it had been written, screenshotted once and
never asserted. What that left untested is precisely the half an auditor never hits: the
refusals.

`packages/webview/test/static.test.ts`, 27 tests, following `palette.test.tsx` and
`preview.test.tsx`. **4.85% → 100%** on statements, branches, functions and lines. The
cases worth naming:

- **The refusal now states the mix, not just a total.** "3 views (1 protocol, 1 contract, 1
  call) — not this one" answers the question the refused reader is actually asking, and it
  is derived from the embedded requests rather than stored, so it cannot disagree with them.
- **Two reasons a preview can be missing** are two different sentences: a node with no
  source, and an export too large to carry it. A reader given the first for the second
  reason goes looking for a bug in the node.
- **The payload-version check**, which is what stops a v1 file half-rendering — a real case
  now rather than a hypothetical, since a v1 payload has no table and would draw every view
  empty.
- **Search offers nothing it could not then show** — it runs over the embedded inspections,
  so the palette cannot name a node the panel would refuse — and a malformed file makes
  `view` and `inspect` report it rather than making the search box throw.

Phase 8 adds a fourth `HostBridge` over `postMessage`. The shared contract is pinned on
three implementations now rather than two.

### 3. A licence gate, because nothing noticed elkjs

§7's Phase 9: "the sibling of the network-dependency check from §3 — same pattern, same
enforcement … fail CI on any new dependency under a strong-copyleft or unlicensed term."

`scripts/check-licences.mjs` is that sibling literally: it walks the same `pnpm list
--prod` trees, reads one field per `package.json`, and exits non-zero naming the offender
and what requires it. Three answers — allowed, refused, **unreviewed** — and the third
fails, because a term nobody recognises is a decision nobody has made and defaulting to
"probably fine" is what makes a gate decorative.

It evaluates the SPDX expression rather than matching the string, because `elkjs` is
`EPL-2.0 OR GPL-3.0-or-later` and one acceptable arm is the whole reason it is consumable
here. `A OR B` needs one arm, `A AND B` needs both, `A WITH exception` is decided by `A`.
Recursive descent over three operators, about forty lines: a dependency inside the
dependency checker would be the wrong shape.

Current result: 77 production dependencies, all shippable, with four named as needing
attribution where redistributed — which is the `THIRD-PARTY-NOTICES.md` Phase 9 owes, seen
early.

`test/licences.test.ts` drives it with a GPL dependency, an unlicensed one and an
unrecognised one, the way `dependency-direction.test.ts` writes a forbidden import. A gate
nobody has seen fail is a gate nobody knows works — which is the exact failure being fixed.

### §7's licence note, amended

The note said the `.vsix` and the HTML export "both redistribute" elkjs. Phase 7d then gave
`@axiomap/cli` a direct `elkjs` dependency for `--format svg`, so the question is whether
that is a third vector.

**It is not.** npm resolves `elkjs` from its own registry entry under its own licence, and
a dependency declaration conveys nothing. What it does change is *where the notices file
has to go*: the note named only the `.vsix`, and a user who runs `npm i -g @axiomap/cli`
now has elkjs on disk as a consequence of installing an MIT package. §7 now says to ship
`THIRD-PARTY-NOTICES.md` in the npm tarball as well.

Two things recorded so they are not re-argued: the SVG an export writes is output rather
than a derivative work (it is coordinates), and the HTML export remains the case that
matters because it inlines elkjs's worker source verbatim.

### The traverse note, closed with numbers

`query/traverse.ts` rebuilding its adjacency index per call has been an open note since
Phase 6, carried again in 7a and 7b, each time "waiting on a profile rather than a guess".
Here is the profile, on 298 contracts with `.axiomap/graph.json` already built:

| Query | Wall clock | Traverses? |
|---|---|---|
| `query externals` | 0.58 s | yes |
| `query unresolved` | 0.61 s | yes |
| `stats` | 0.59 s | **no** |
| `query callers-of <fn>` | 0.60 s | yes |

They are indistinguishable from each other, and `stats` — which builds no index at all — is
not the fastest. All four are process startup plus reading a 4.8 MB `graph.json`; the index
does not appear above that floor. A cache would be a parameter, a default and an
invalidation rule bought with nothing measurable. **Closed**, in the file itself rather than
in a note, so the fifth session does not ask again.

(Earlier, without the stored artifact, the same four queries are 0.76–1.09 s — the extra
time is ingest, not traversal, and the ordering between them is unchanged.)

### Deliberately not done

- **§16's auto-expansion-balance and overlay-rollup entries stay deferred.** Both are
  information-design decisions that want a real protocol on screen, and 7d recorded why.
- **NatSpec stays deferred**, and §16 now says 7e declined it rather than leaving the owner
  line reading as though it might have been taken. Item 1 turned out to be a format change
  *and* a policy decision *and* a browser re-verification; a `GRAPH_SCHEMA_VERSION` 4 → 5
  bump with four regenerated goldens beside it would have put an unread golden diff in a
  commit whose reviewer is looking at something else, which is the failure §6 names. Owner:
  Phase 8.

### Deviations from the spec

- **`payloadVersion` 1 → 2**, an unpublished format changed while that is free. The reader
  refuses v1 rather than half-reading it.
- **`StaticPayload.inspections` holds `StaticInspection`**, which is `NodeInspection`
  without its node. The bridge reassembles before the UI sees anything, so nothing
  downstream of it learned that the format has a table in it.
- **`export --format html`'s console line is unchanged in shape** but its numbers are not:
  it prints the view count it embedded, and the omitted count is now a much smaller
  fraction of the reachable set.
- **`scripts/check-licences.mjs` exports its parts** and runs its command only when invoked
  directly, so `test/licences.test.ts` can drive the classifier with packages that are not
  installed here. `check-no-network-deps.mjs` has no such split and no such test; it is the
  older of the two and worth the same treatment when something next touches it.

### §16 changes

- **`export --format html|svg`** gained the payload v2 entry: the quota policy with the
  before/after numbers, and the node table with the reason it is not called `nodes`.
- **NatSpec** records that 7e declined it, with the reason, and names Phase 8 as the owner
  rather than "Phase 8 or a 7e".

### Notes for the next session

- **Phase 8 is the VS Code extension.** The `HostBridge` contract is now pinned on three
  implementations, and the fourth is correlation ids over `postMessage`. The hydration pair
  is not its problem: `postMessage` carries a live host's answers, not a payload.
- **The licence gate is in place before the extension's dependencies arrive**, which was
  the point of building it now. A dependency it refuses is a conversation, not a bug: the
  allowlist edit is the review and belongs in the diff.
- **`fixtures/large/generate.mjs --sloc 22000 --out mid300` and `--sloc 200000 --out
  big2700`** regenerate the two projects every number above was measured on. Neither is
  committed (§14).
- **The export's quota numbers are a policy, not a measurement.** If a real protocol's
  deliverable turns out to want more contract breadth than call depth, `VIEW_QUOTA` is one
  line and the reason it holds those values is written beside it.

## Phase 8a — The extension host: the panel, both navigation directions, CodeLens

**Date:** 2026-08-06
**Status:** partial phase, deliberately — the first of two. `pnpm check`,
`pnpm check:network` and `pnpm check:licences` all green. **Phase 8b is the remainder: the
`.vsix`, and the three-theme legibility criterion.**

Phase 8's own exit criteria are "installable `.vsix`; click-to-navigate feels instant; the
graph is legible in Dark+, Light+, and one high-contrast theme". All three need a packaged
extension in a running editor, and this session has no editor — so they belong to 8b
together, and the split is along that line rather than at an arbitrary point. What 8a owns
is everything that is true before packaging: the host, the protocol, the two navigation
directions, the lens, the watch, and the webview entry, verified in a real browser against
a faked extension host.

### 8a's own criteria

| Criterion | Result |
|---|---|
| A fourth `HostBridge`, over `postMessage` (§9 rule 1) | pass — `webview/src/vscode.ts` and `vscode/src/host.ts`. Correlation ids, and the *same* request encoding browser mode puts in a query string, so the host decodes with `decodeViewRequest` |
| The webview embedded in a VS Code panel | pass — `panel.ts` + `html.ts`, driven end to end in Chrome against a faked host: mounts, answers, and lays out in a worker |
| §11's node → editor, and edge → **call site** | pass — `reveal` notifications; `navigation.ts` converts §10's byte offsets to editor positions. The browser test asserts the reveal leaves the webview with the id that was clicked |
| §11's inverse navigation, editor → graph | pass — `nodeAtOffset` in core, `onDidChangeTextEditorSelection` in the extension, `select` into the webview. Asserted in the browser: the inspector opens and **the view does not change** |
| §11's CodeLens line | pass — `query/lenses.ts` for the counts, `codelens.ts` for the sentence, 6 tests on the wording and 5 on the counts |
| Commands and keybindings | pass — four commands, two keybindings, an editor context-menu entry, and a repo-level test that the manifest and the registrations name the same set |
| Artifact watch | pass — `.axiomap/graph.json` reloads the graph; `review.json`/`findings.json` re-read the two overlay files only |
| All colour from VS Code CSS custom properties | pass — the palette was already `--vscode-*` (Phase 7c); the document this phase adds contains no hex at all, and a test asserts it |
| No `.vsix`, no three-theme check | 8b's, above |

`pnpm check` is green: **419** tests in `core` (403 from 7e, 16 new), **135** in `webview`
(126 + 9), **101** in `cli` (unchanged), **27** in `vscode` (0 before), and **53**
repo-level (45 + 8, three of them in a browser).

### One interface, four hosts, and the seam held

Phase 7d's note said implementing `HostBridge` over `postMessage` was "correlation ids and
nothing else". That turned out to be true of the *bridge*, and the interesting part was
what it is not enough for.

`HostBridge` is six questions and six answers, which is all a browser tab and a
self-contained file can be. An editor is a live host with a cursor in it, and §11 asks for
three things that are not questions about the graph: reveal, inverse navigation, and (from
§7) the artifact watch. They are a **separate, optional `EditorLink`** (`webview/src/editor.ts`),
so `App` behaves exactly as before when it does not have one — browser mode and the export
are unaffected by a feature only an editor can offer, and neither had to learn that a fourth
host exists.

Two of those notifications are deliberately different events, and it is the one design
decision in this phase worth stating:

- **`select`** is a *cursor* landing on a declaration. It highlights and opens the
  inspector. It does not navigate, and it does not reveal back — a cursor move that dragged
  the view somewhere else on every keystroke would make the panel unusable while typing, and
  one that revealed back would be a feedback loop between two things the user is steering by
  hand.
- **`focus`** is a *command* — a CodeLens click, "reveal in graph". That is §11's "focus
  here" arriving from outside the webview, and it navigates.

Written as one event, the difference would have been decided by whichever caller was
written first.

### What moved into core, and why that was the point

Three things the CLI owned turned out to be *policy* rather than plumbing the moment a
second host needed them. §5 forbids `vscode → cli`, so the alternative was a second copy of
each:

- **`project/session.ts`** — open a project, read §13's config, and load a graph: from
  `.axiomap/graph.json` while no source is newer than it, and by building otherwise. Two
  answers to "is this artifact still true" is the editor and the terminal disagreeing about
  whether the graph on screen describes the code on disk. The CLI keeps what is genuinely
  its own: the flag names and the spinner, now attached through a hook.
- **`project/overlay-sources.ts`** — §11's two file-backed overlays, including the rule that
  a malformed one is a warning and an absent overlay rather than a dead host.
- **`query/protocol.ts`'s `projectMeta` and `describeProtocolError`** — the explicit field
  list that decides what a UI may see, and the shape an error takes on the wire. The whole
  value of writing that field list out by hand is that there is one of it; the HTTP host
  keeps the *status* mapping, which is HTTP's alone.

§5 is amended for the first of these. The other two are files inside directories §5 already
names.

### 7d's open question, answered: the buffer

7d left one VS Code-specific question on the `source` method — the preview reads from disk,
and the editor may hold unsaved changes, "so a preview can disagree with what the user is
looking at in a way `drifted` will not catch". It cannot catch it: the graph and the disk
agree, and it is the *screen* that has moved on.

`sliceNode` now takes an optional `read`, and the panel supplies the open document when
there is a dirty one. The path still comes from the graph — there is still no parameter
through which a caller can name a file, which is the security design 7d wrote down — and
drift is still reported, now against the buffer. Three tests, including one that asserts the
callback is asked about the node's own file and falls back to disk.

### Then it was pointed at a browser, because that lesson has held three times

7b, 7c and 7d each found defects that a green suite was blind to and one image made obvious.
There is no VS Code here to run an extension in, and there will not be one in CI — but the
half that has actually been wrong before is the bundle in a browser, and that can be run.

`test/browser-smoke.test.ts` gained a "the graph in a VS Code webview" describe that serves
**the real document** — `webviewHtml`, CSP included — with a shim providing
`acquireVsCodeApi`, and answers what the page posts with `answer()`, the same function the
real panel calls. It covers the three things a unit test cannot: the CSP does not block the
bundle, the ELK worker starts (§9 rule 6), and the bridge's ids match across a real
`postMessage`.

Nothing was wrong this time, which is worth recording as an outcome rather than as an
absence: the two things most likely to have been — a CSP that refuses its own bundle, and
a worker that cannot start — are the two the harness was built to catch.

**The worker is the one thing that genuinely differs from browser mode.** A webview
document's origin is not the origin its resources are served from, so a worker started from
an asset URL is refused as cross-origin. The extension reads `elk-worker.min.js` off its own
disk and hands it to the page as a string, which the entry turns into a same-origin `Blob` —
the same route the HTML export takes, arrived at independently. That is also the sense in
which §7's Phase 9 says the `.vsix` "redistributes" elkjs.

### Deviations from the spec

- **Phase 8 is split into 8a and 8b**, along the line that separates what needs a packaged
  extension in a running editor from what does not. §6 says a phase that needs splitting is
  useful information; all three of Phase 8's exit criteria are on the far side of that line,
  so splitting anywhere else would have produced a session whose criteria were half-checkable.
- **`packages/vscode` is a fourth tested package.** `vitest.config.ts` aliases the `vscode`
  module to `test/vscode-stub.ts`, which carries **shapes and no behaviour** — a stub that
  reimplemented `Range` semantics would be a second implementation of the editor, and a test
  passing against it would say nothing. The modules that decide anything (`host.ts`,
  `session.ts`, `html.ts`, the pure half of `navigation.ts` and `codelens.ts`) are written
  not to need it.
- **The CodeLens provider is selected by path, not by language id.** `solidity` is
  contributed by whichever Solidity extension the user happens to have installed, and a
  provider bound to a language id shows nothing at all for somebody with none — a failure
  that reads as this extension being broken rather than as a missing dependency.
- **The extension does not build a graph to answer a lens.** Opening a `.sol` file in a
  200k-SLOC repo would otherwise start a multi-second ingest nobody asked for. Lenses appear
  once a command has loaded the graph, and the provider is refreshed then. `activationEvents`
  is empty for the same reason: Axiomap is a tool you reach for.
- **`.sol` files are not watched.** Core's freshness rule already rebuilds when the sources
  are newer than the artifact, at the moment a graph is next asked for; rebuilding on every
  save is §16's incremental-reparse entry, still deferred.
- **The webview package has a third build** (`vite.vscode.config.ts` → `dist/vscode/`),
  single-chunk for the same reason the export's is: every *second* thing a webview fetches
  is a cross-origin request to get right, and the whole bundle is on local disk anyway.
- **`packages/vscode` gained an `exports` map** with `./host`, `./html` and `./assets`
  subpaths, so the repo-level tests can reach the parts that do not import `vscode`. The
  root `.` entry is still the extension's activation entry, which is what the editor loads.
- **`@types/vscode` is the package's only new dependency**, and it is a devDependency; the
  licence gate's production walk is unchanged at 77 packages, none refused.

### §16 changes

- **Added Tier 2 — webview state across an editor restart.** `retainContextWhenHidden`
  covers tab switching; a window reload loses the laid-out graph and the history. What makes
  it more than serialization is that the graph may have moved underneath the saved state, so
  restoring a focus node that no longer exists is the confident-wrong answer §6 rules out.
- **NatSpec: a rule instead of a fourth owner line.** §16 named Phase 8 as its owner and 8a
  declined it, which is the third deferral — so the entry now says it is not a rider on
  another phase's commit: whoever takes it takes it as its own change, with its own
  golden-file commit, and answers the two open questions first. 8b may take it; if it does
  not, it becomes a numbered item of its own.

### Notes for the next session

- **Phase 8b is the `.vsix` and the three themes**, and the packaging question is the real
  work rather than `vsce package`. Three things are known to be in the way, and none of them
  is solved yet:
  - **CommonJS versus ESM.** Every package here is `"type": "module"`; VS Code's extension
    host has historically required CommonJS for an extension's entry point. Bundling to CJS
    with esbuild is the ordinary answer.
  - **The grammar `.wasm`.** `parse/treesitter.ts` resolves it with
    `new URL('../../vendor/tree-sitter-solidity.wasm', import.meta.url)`, which is correct
    from `dist/parse/` and from `src/parse/` and wrong from anywhere a bundler would put it.
    Phase 1's notes flagged this as Phase 8's problem in as many words. `web-tree-sitter`
    ships a second `.wasm` of its own inside `node_modules`.
  - **Worker threads.** `parse/workers.ts` falls back to inline parsing when it cannot find
    a built worker entry, so a bad answer here is *slow*, not broken — which is the failure
    mode to prefer, and worth checking rather than assuming.
  `pnpm deploy --filter @axiomap/vscode` is the pnpm-shaped alternative to bundling and
  keeps every path relative to a real `node_modules`; it was not tried.
- **`pnpm screenshots` is the harness for the theme criterion**, and it drives browser mode.
  The new browser describe in `browser-smoke.test.ts` is the one that drives the *VS Code*
  bundle, and `Page.theme()` sets host variables before the app boots — pointing that at a
  real Dark+/Light+/high-contrast variable dump is the cheap version of the exit criterion,
  and installing the `.vsix` is the honest one. Do both.
- **The editor half is still unverified by anything.** That a `reveal` moves a cursor, that a
  lens draws above a function, that the watch fires: all of it is unit-tested against shapes
  and none of it has run in an extension host. That is 8b's first hour, not its last.
- **`GraphPanel.open` is keyed by workspace folder**, and `sessions` likewise. A multi-root
  workspace is two protocols; nothing in 8a has been run against one.
