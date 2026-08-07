# Axiomap

**Graph-based navigation and comprehension for Solidity protocols.** CLI + VS Code
extension over one shared engine. MIT licensed.

**It works on code that does not compile.** Half the repositories worth auditing are
missing a dependency, pinned to a solc version nobody has installed, or mid-refactor.
Axiomap parses tolerantly, builds the graph anyway, and tells you exactly how certain
every edge is — instead of asking for a green build it cannot get.

**The graph is an interface, not a diagram.** Every node is a jump target. Every edge
knows the byte offset of its call site. Click a node to land on its declaration; click an
edge to land inside the caller, at the exact call.

## Quick start

```bash
npm i -g @axiomap/cli
cd your-protocol
axiomap build       # → .axiomap/graph.json, prints the resolution score
axiomap serve       # same graph, in a browser
```

Or install **Axiomap** from the VS Code Marketplace / Open VSX for the in-editor panel,
click-to-navigate, and CodeLens.

`axiomap build` never requires a successful compile. If your project *does* build with
Foundry or Hardhat, point Axiomap at the build artifacts and edges upgrade from inferred
to certain — same graph, no re-run needed:

```
1,847 edges — 71% semantic, 22% heuristic, 4% ambiguous, 3% unresolved
```

## What it answers

- What can an external actor reach, and through which path?
- Which functions write to this storage variable, and are any unprotected?
- What happens between this external call and the state write that follows it?
- Which of these 40 contracts are live and which are test scaffolding?
- This is v2 of a protocol I reviewed last quarter — **what actually changed?**

## How it's honest about uncertainty

Every edge carries a resolution confidence — `semantic` (compiler-certain), `heuristic`
(a single confident syntactic match), `ambiguous` (multiple candidates, all shown), or
`unresolved` (the callee's name is known, its target is not). These are drawn distinctly
and are filterable. **"Show me every unresolved external call" is one of the most useful
queries you can run** — a tool that quietly pretends to certainty it doesn't have is worse
than one that admits what it doesn't know.

## Five views, one graph

Protocol map, contract detail, call graph, state access map, inheritance tree — each a
filter and a layout over the same underlying model, never a separate pipeline. Overlays
(attack surface, access control, reentrancy shape, danger ops, resolution confidence,
complexity, review state, imported Slither findings) combine on top of any of them.

## The audit workflow nothing else does

`.axiomap/review.json` records who reviewed which function and against which body hash,
and is meant to be committed and shared across an audit team. Edit the function later and
its review goes stale automatically — combined with `axiomap diff`, this produces the
whole upgrade-audit answer:

```bash
axiomap diff v1 v2 --json    # exactly which reviewed functions changed and need another look
```

## CLI

```
axiomap build [path]              build the graph, print the resolution score
axiomap serve [path]              build + open the UI in a browser
axiomap diff <refA> <refB>        git revisions or two paths
axiomap export --format dot|mermaid|json|html|svg
axiomap stats
axiomap import-findings <slither.json>
axiomap review <node> --status reviewed|flagged|follow-up
axiomap query callers-of|callees-of|reachable-from|path|writers-of|readers-of|externals|unresolved|stale-reviews <args>
```

Every command takes `--json` for piping into CI:

```bash
axiomap query unresolved --json | jq 'length'   # fail the build on new unresolved external calls
```

Full flags: `axiomap <command> --help`.

## Configuration

`axiomap.config.json`, all fields optional:

```jsonc
{
  "include": ["src/**/*.sol"],
  "exclude": ["test/**", "script/**", "lib/forge-std/**"],
  "entrypoints": ["src/Vault.sol:Vault"],
  "accessControlModifiers": ["onlyOwner", "onlyRole", "auth", "requiresAuth"],
  "reentrancyGuards": ["nonReentrant"],
  "renderCap": 1500
}
```

It's meant to be committed: a diff reads both revisions against the same config, so the
question stays "what changed in the protocol," not "what changed in the tool's settings."

## Privacy

**Axiomap makes no network requests, ever** — no Etherscan, no Sourcify, no telemetry, no
model calls. CI walks `@axiomap/core`'s entire production dependency tree and fails the
build on anything that imports `http`, `https`, `net`, `dns`, or `undici`. This is a
property you can verify yourself before pointing the tool at client code; see
[`SECURITY.md`](SECURITY.md).

## What it doesn't do (yet)

No Slither dependency (`axiomap import-findings` reads Slither's own JSON output — you
run Slither, Axiomap overlays it), no LLM integration, no proxy/storage collision
detection, no taint analysis. All four are named gaps with a seam already in the
architecture, not silent omissions — see
[`docs/architecture/extension-seams.md`](docs/architecture/extension-seams.md) and
`AXIOMAP.md §16`.

## Project structure

A pnpm + Turborepo monorepo: `@axiomap/core` (parsing, resolution, graph — no UI, no
network, `fs` only), `@axiomap/webview` (the React + Cytoscape UI, built once and hosted
in both the browser and VS Code), `@axiomap/cli`, and `@axiomap/vscode`. `docs/PROGRESS.md`
is the phase-by-phase build log and `docs/decisions/` holds the ADRs (parser choice,
benchmarks); both are the closest thing to a design doc in this repo.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) — it covers the phase discipline, the golden-file
test workflow, and what a PR needs before review.

## Security

See [`SECURITY.md`](SECURITY.md) for the threat model and how to report a vulnerability.

## Licence

MIT. Third-party notices (including elkjs, EPL-2.0, redistributed in the `.vsix` and the
HTML export) are in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
