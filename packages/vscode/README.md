# Axiomap

Graph-based navigation and comprehension for Solidity protocols, in the editor.

**It works on code that does not compile.** Axiomap parses tolerantly and tells you how
certain it is, rather than requiring a build it cannot get — which is the state half the
repositories worth reading are in.

## What it does

- **The graph is an interface, not a diagram.** Click a node to jump to the declaration;
  click an edge to land on the **call site**, inside the caller, at the right byte.
- **Five views** over one graph: protocol map, contract detail, call graph, state access
  map, inheritance tree.
- **Honest confidence.** Every edge is `semantic`, `heuristic`, `ambiguous` or
  `unresolved`, drawn distinctly and filterable. "Show me every unresolved external call"
  is a query, not a gap.
- **Overlays** for attack surface, access control, reentrancy shape, danger ops, review
  state and imported Slither findings.
- **CodeLens** above every contract and function: callers, external calls, writes, whether
  anything guards it, and whether your review of it is stale.
- **Review state** in `.axiomap/review.json`, designed to be committed and shared across an
  audit team.

## Commands

| Command | Default keybinding |
|---|---|
| Axiomap: Open Graph | `Ctrl+Alt+G` / `Cmd+Alt+G` |
| Axiomap: Reveal Current Position in Graph | `Ctrl+Alt+R` / `Cmd+Alt+R` |
| Axiomap: Rebuild Graph | — |

## Settings

Two, and both are editor behaviour: `axiomap.codeLens.enabled` and `axiomap.followCursor`.

Everything about **the project** — which files are included, what counts as an access
control modifier, the render cap — lives in `axiomap.config.json` beside the code, where it
is committed and everyone on the engagement sees the same graph. No setting here overrides
that file.

## Privacy

Axiomap makes **no network requests, ever** — no source fetching, no telemetry, no model
calls. This is enforced by a CI job that walks the production dependency tree and fails on
anything that could open a socket. It is a tool meant to be pointed at confidential client
code.

## Licence

MIT. Third-party notices, including elkjs (EPL-2.0), are in `THIRD-PARTY-NOTICES.md` inside
this package.
