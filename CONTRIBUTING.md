# Contributing to Axiomap

Thanks for considering it. A few things are non-obvious about how this repo works, and
skipping them is the fastest way to get a confusing review.

## Before you start

- Read `docs/PROGRESS.md`. It's the phase-by-phase build log — what shipped, what was
  deliberately deferred and why, and what the next session is expected to pick up. It is
  more current than any comment in the code.
- Check the backlog notes scattered through `docs/PROGRESS.md`'s "§16 changes" sections
  before proposing new scope. If something looks obviously missing, there is a good
  chance it was already considered and deferred with a reason — the fix is usually to
  read the reason, not to reopen the decision blind.
- For anything nontrivial, open an issue before a PR. A few designs here (confidence
  labels as a first-class result, the render cap, the zero-network invariant) are settled
  and won't be relitigated; better to find that out before writing code than after.

## Working conventions

```bash
pnpm install
pnpm build                 # turbo build, all packages
pnpm test                  # vitest, all packages
pnpm test --filter core    # single package
pnpm lint                  # eslint + dependency-direction rules
pnpm check                 # build + test + lint — what CI runs

pnpm test:golden           # graph.json golden-file diffs
pnpm test:golden -- -u     # update goldens — see below before running this
pnpm test:coverage         # which branches no test reaches
pnpm check:network         # @axiomap/core must have zero network-capable dependencies
pnpm check:licences        # every production dependency's licence is reviewed and allowed
```

- **TypeScript strict, no `any`.** Use `unknown` and narrow.
- **`@axiomap/core` is pure**: no I/O beyond `fs`, no network, no UI imports. This is
  enforced by an ESLint `no-restricted-imports` rule (`core` must never import from
  `webview`, `cli`, or `vscode`) — don't add an exception to it; if a change seems to need
  one, the change is probably in the wrong package.
- **Analysis passes are pure functions over the graph.** No mutation of shared state; one
  pass per file, named for what it computes.
- **Errors carry actionable context.** `Cannot resolve import "@oz/token" from
  src/Vault.sol (checked: remappings.txt, foundry.toml, node_modules)`, not `Import not
  found`.

## Golden-file tests are the safety net

`graph.json` per fixture is committed and diffed on every run (`packages/core/test/golden/`).
This is the most important test suite in the repo.

**Read the diff and justify it before updating a golden file.** An unexplained golden
change is a regression until proven otherwise. Never regenerate a golden just to make a
red build green — if you don't understand why it changed, that's the bug to chase, not
the test to update. When a golden change *is* correct, say why in the commit message and
keep it in its own commit, separate from the code change that caused it.

## Resolution confidence is a feature, not a bug to fix away

`resolution: 'ambiguous' | 'unresolved'` on an edge is a correct, intentional answer — the
resolver found real uncertainty in the source and said so rather than guessing. Never
"fix" the resolver by inventing a resolution to make a graph look more complete than the
code actually supports; if a fixture looks wrong, check whether the uncertainty is real
before assuming it's a bug.

## Commits and PRs

- [Conventional commits](https://www.conventionalcommits.org/): `feat(core): resolve
  library calls via using-for`.
- Scope is the package name: `core`, `cli`, `webview`, `vscode`, or `repo`.
- One logical change per commit. Golden-file updates get their own commit with the reason
  in the message.
- No AI-attribution trailers or generated-by lines in commits or PR descriptions.

## Test fixtures

Five fixtures live in `fixtures/`, and most changes should be checked against all of
them: `minimal/` (canary — every node and edge kind appears once), `inheritance/`
(vendors OpenZeppelin, MIT), `defi/` (a from-scratch constant-product AMM, tagged
`defi-v1`/`defi-v2` for the diff engine — **fetch tags**, a shallow clone is missing half
of it), `pathological/` (adversarial: syntax errors, CRLF, non-ASCII, a delegatecall proxy
with a deliberate storage collision), and `large/` (a generated performance fixture, not
committed — `node fixtures/large/generate.mjs`).

**Never vendor a third-party protocol's source directly** — check its licence first, and
prefer writing a small original fixture that reproduces the same graph shape. `defi/` was
written from scratch specifically to avoid pulling GPL-3.0/BUSL-1.1 code into an MIT repo.

## Reporting a bug

Please use the bug report template and fill in all three required fields — resolution
score, project type (Foundry / Hardhat / bare), and whether build artifacts were present.
Without them, "the graph is wrong" usually isn't actionable: those three facts are what
determine which of the three degradation modes (full / heuristic / structural) produced
the graph you're looking at.

## Security

Please don't file security issues as public GitHub issues — see `SECURITY.md`.
