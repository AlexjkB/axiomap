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
