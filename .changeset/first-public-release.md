---
"@axiomap/core": minor
"@axiomap/webview": minor
"@axiomap/cli": minor
---

First public release. `@axiomap/cli` builds a graph of a Solidity protocol without
requiring a successful compile, with `axiomap serve` for the browser UI and `axiomap
export --format html` for a self-contained client deliverable. `@axiomap/core` and
`@axiomap/webview` are published because `@axiomap/cli` depends on them; most users only
need `npm i -g @axiomap/cli`.
