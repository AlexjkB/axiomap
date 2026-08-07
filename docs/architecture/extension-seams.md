# Extension seams for the Tier 1 backlog

`docs/PROGRESS.md`'s §16 references (proxy/storage analysis, taint analysis, live Slither
invocation, and invoking a compiler directly) are Tier 1: "MVP architecture already
accommodates it. Build when the trigger fires." This page is the concrete pointer for
each — where the accommodation actually lives in the code, so a contributor picking one
of these up starts by reading the seam rather than by guessing where it should go.

None of the four is implemented here. That is the point: each is a real capability gap,
named rather than silently missing, with the place it plugs in already built and tested
by something else that uses the same seam today.

## Proxy & storage layout analysis

**Not built.** Detecting delegatecall proxy/implementation pairs, flagging storage-slot
collisions between them, and visualizing slot packing is a distinct analysis domain —
correctly modeling slot arithmetic (packing, dynamic array/mapping slot derivation,
struct member offsets) is a project of its own, not an afternoon's addition to an
existing pass.

**What already exists to build it on:**

- `Function.flags.hasDelegatecall` — set at parse time on every function, independent of
  whether the call resolves (`packages/core/src/graph/schema.ts`). This is how you'd find
  candidate proxies without needing the call graph to be certain.
- `StateVariable.slot` / `StateVariable.offset` — populated by the semantic tier from the
  compiler's `storageLayout` output when the project provides `--extra-output
  storageLayout` (Foundry) or by default (Hardhat). Absent rather than null when no
  layout was available (`packages/core/src/graph/schema.ts`). This is exactly the data a
  slot-collision check would diff between an implementation and a proxy.
- `fixtures/pathological/` already contains a delegatecall proxy with a **deliberate**
  storage collision, written for this. It is not currently asserted by any analysis pass
  — it exists so a future one has a fixture on day one instead of needing to write one
  first.

**Depends on:** the semantic tier (build artifacts). Slot data does not exist on
uncompiled code, and that limitation should stay visible in the UI rather than be padded
over.

## Taint & data-dependency analysis

**Not built, and the single most expensive item in the backlog** — tracking whether
user-controlled input reaches a sensitive sink (`delegatecall` target, `call` value, an
arbitrary `transfer` recipient) means lowering Solidity into an SSA-form IR, which is
close to rebuilding Slither's SlithIR. This is a genuine, acknowledged capability gap
versus Slither (see the README) and is not attempted here.

**What already exists to build it on:** the graph model is IR-agnostic by construction.
`GraphNode` and edge records (`packages/core/src/graph/schema.ts`) take additional
optional attributes without a schema-version bump forcing every consumer to change —
that's the same mechanism `natspec` used to land in Phase 8c and `checksSender` used in
Phase 4. A taint pass would be one more analysis module in `packages/core/src/analysis/`
(one file per pass, pure function over the graph, per the existing convention) producing
attributes the existing overlay machinery (below) can already render.

## Live Slither invocation

**Not built.** `axiomap import-findings <slither.json>` ships today — the user runs
Slither themselves and Axiomap overlays the result. Deferred: invoking Slither directly,
managing its Python environment, and auto-refreshing findings on a watch.

**What already exists to build against:**

- The import format and overlay renderer are the real seam and are already the MVP path:
  `packages/core/src/findings/slither.ts` reads Slither's own JSON, joins findings to
  graph nodes **by byte offset** (the same join Phase 3's semantic enrichment uses, for
  the same reason — no name/signature canonicalisation needed on either side), and
  reports anything it cannot map rather than dropping it silently.
- `OverlayName = 'findings'` in `packages/webview/src/ui/overlays.ts` already renders
  imported findings as badges, sharing the badge channel with danger-ops and the
  reentrancy surface.
- A "live" mode would add a second producer feeding the same `importSlitherFindings(graph,
  raw)` entry point that the CLI's `import-findings` command already calls — invoking
  Slither and handing its JSON `stdout` to the same function that reads a file today,
  rather than a new pipeline. The reason it's deferred rather than built is distribution (a Python
  dependency inside a VS Code extension) and a hard precondition (Slither requires a
  successful compile — unavailable in precisely the case Axiomap exists to serve), not a
  missing seam.

## Invoking a compiler, rather than reading what one already wrote

**Not built.** Phase 3 enriches from build-info the user's own toolchain (Foundry or
Hardhat) already produced. Deferred: running `solc` directly for a project that has no
artifacts — locating the right compiler version per file, driving standard-JSON input,
and caching the result.

**What already exists to build against:**

- `loadSemanticOverlay` in `packages/core/src/enrich/index.ts` is the whole seam: it
  returns a `SemanticOverlay`, and where the underlying ASTs came from is private to
  `enrich/`. `graph/semantic.ts` consumes the overlay through this interface without
  importing anything from `enrich/` — the whole point being that `enrich/` can be deleted
  and the rest of the pipeline still compiles (there is a standing test for exactly this,
  `test/enrich-stub.test.ts`, kept forever per §7).
- A direct-solc backend would be a second implementation behind `loadSemanticOverlay`,
  selected when no build-info is found — a second `SemanticOverlay` producer, not a
  second consumer.
- **Why this one is genuinely blocked, not just unstarted:** the obvious library,
  `solc-typed-ast`, downloads compiler binaries over the network, which fails the
  zero-network CI gate this repo enforces on `@axiomap/core`'s production dependency
  tree. Doing it without that library means solc version management from scratch, which
  is most of what Foundry and Hardhat already do well. The trigger is users routinely
  having a compilable project and no artifacts, and finding `forge build --build-info` an
  unreasonable thing to be asked for.

## The one non-Tier-1 seam worth naming here: overlays in general

Not a backlog item — the eight overlays already shipped (§11) all read one shared,
pluggable styling layer (`packages/webview/src/ui/overlays.ts`), a pure function of a
view, the overlay data and the active set. Any future overlay — the deferred test
coverage overlay, for instance — is one more entry in that module and one more badge or
channel allocation, not a new rendering path. Read the module's own header comment before
adding one: the channel-budget rule ("an overlay with no free channel does not ship") is
enforced by convention here, not by a type, so it's worth checking by eye which channels
are still free.
