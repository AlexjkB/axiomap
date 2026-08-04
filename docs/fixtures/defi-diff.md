# The `defi/` diff fixture

§14 requires `fixtures/defi/` **committed twice, as two git tags, with a
hand-authored changeset between them**. This is that changeset, and where to
find it.

```
defi-v1   the fixture as every other suite sees it — this is what main carries
defi-v2   the same fixture, one revision later
```

`defi-v2` is a child of `defi-v1` and is **not on `main`**. Only the tag keeps it
reachable, which is the point: the goldens, the Phase 1 symbol counts and the
Phase 3 build-info artifacts are all pinned to v1, and moving the working tree to
v2 would have made a diff-engine fixture cost a rewrite of four earlier phases'
expectations. Two tags with a changeset between them is what §14 asks for, and
nothing in it says `main` has to advance to the second one.

```bash
git diff defi-v1 defi-v2               # the changeset
node packages/cli/dist/bin.js diff defi-v1 defi-v2 fixtures/defi
```

`packages/cli/test/diff.test.ts` asserts the whole of it. The changeset was
written first, by hand, and the matcher was built against it afterwards.

## What changed, and which part of §8 it exercises

`out/build-info/` is dropped at v2. Every source file changed, so the v1 artifact
covers none of them — and diffing a revision that has artifacts against one that
does not is the *normal* case (§8: historical checkouts do not compile), so the
fixture should be that shape rather than the tidy one.

### The two the exit criterion names

| Change | Tier | Why it is the interesting case |
|---|---|---|
| `Router.quote` → `Router.quoteAmount` | body hash | Pure rename. The body is untouched, so the only honest report is `renamed`, and the id-based diff would have said added + removed. |
| `AmmMath.sortTokens` → `TokenOrder.sortTokens` | body hash | Moved to a new library in a new file, body byte-identical. Callers in `Factory` and `Router` change with it. |

### The rest

| Change | What it tests |
|---|---|
| `Router.getAmountOut` → `Router.amountOutFor`, body also changed | The fuzzy tier. `Router.sweep` is added in the same commit with the *same three parameter types*, and must not be matched instead. |
| `AmmMath.min` removed, inlined into `Pair.mint` | A real removal, next to a move in the same library — the matcher has to tell them apart. |
| `Pair._update(uint256,uint256)` → `Pair._update()` | The signature tier: same container, same name, different id. |
| `Pair._update` now reads balances itself | §8's "new external call added to a previously self-contained function". |
| `Factory.creationFee` inserted **before** `pairs` | §8's "state variable added, removed or reordered". Reported from declaration order, because v1 has slots and v2 does not. |
| `Factory.createPair` and `IFactory.createPair` become `payable` | §8's "function became payable", on both an implementation and the interface it overrides. |
| `Factory.setFeeSetter` loses its `msg.sender` check | §8's "access control removed from a state-mutating function". Reported as `low` → `none`. |
| `Factory.collectFees` added, sends value through `to.call{value:}` | §8's "new low-level call". |
| `Factory.setCreationFee`, `Factory.collectFees`, `Router.sweep` added | §8's "new external entrypoint". Only `sweep` is unguarded, and only `sweep` says so. |
| `Router.sweep` calls `IERC20Minimal.transfer` | §8's "previously unreachable function became externally reachable" — and `transfer` itself is untouched, so the finding is labelled a *consequence*. |

## What it should report

11 findings, 20 changed nodes, 78 unchanged. If that count moves, read the diff
before touching anything: the fixture is frozen at both tags, so the only thing
that can have changed is the engine.
