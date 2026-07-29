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
**Status:** complete except the parser choice, which is deliberately left open — see below

### Exit criteria

| Criterion | Result |
|---|---|
| Symbol table for all fixtures with hand-verified contract/function counts | pass — `packages/core/test/symbols.test.ts`, run against both backends. Counts for `minimal/` and `defi/` were derived by reading the sources and are commented with their derivation; `inheritance/` vendors OpenZeppelin so its hand-written contracts are asserted exactly and the vendored part structurally |
| Benchmark documented | pass — `docs/decisions/0001-parser.md`, regenerable via `pnpm bench:parser`, with measurements persisted to `0001-parser.json` |
| Parser choice committed | **not done, by instruction.** The session prompt asked for both implementations, the numbers reported, and confirmation before deleting the loser. Both backends are in the tree and both are tested |

`pnpm check` is green: 8 turbo tasks, 127 tests — 113 in `core`, 14 repo-level. Four of
the core tests exercise the real worker threads and skip themselves when `dist/` is
absent; `pnpm check` builds first, so they run.

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

**`pnpm check:network` currently fails for that last reason.** It is not a false positive —
§3's invariant is about what is in the tree, and yarn is in the tree. It resolves either
way once the choice is made: deleting tree-sitter clears it outright, and keeping
tree-sitter means switching to `web-tree-sitter` plus the `.wasm` the grammar package
already ships, which has neither the native build nor the yarn dependency. That option is
now in §16.

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

### Appended to §16

- **`web-tree-sitter` + a vendored WASM grammar** (Tier 1). Avoids both the native build
  and the `yarn` runtime dependency. Trigger: tree-sitter wins the bake-off.

### Notes for the next session

- **Phase 2 cannot start until the parser choice is made.** It extends `SolidityParser`
  with expression-level detail, and doing that against two backends is the exact waste the
  bake-off exists to end. Delete the loser first: its file, its dependency, its branch of
  `createParser`, and its half of the `describe.each` in the tests.
- `docs/decisions/0001-parser.md` still says `**Status:** proposed`. The bench script
  refuses to overwrite the file once that changes, so record the decision there before
  re-running it.
- §14 wants `defi/` committed twice as two git tags with a hand-authored changeset between
  them. Not done — the changeset needs to be designed against the diff engine it exists to
  test, which is Phase 5. The fixture content is in place and ready to be tagged.
- `pathological/src/SyntaxError.sol` and `DoesNotCompile.sol` are load-bearing, not
  decoration. The first is the recovery benchmark; the second is decision #1 in one file.
  Neither should be "fixed".
