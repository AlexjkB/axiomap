# Security Policy

Axiomap is a static-analysis tool built to be pointed at protocol code before it is
public — often under an NDA, sometimes days before a mainnet deployment. The threat model
below and the zero-network invariant it names are not boilerplate; they are the reason an
auditor can run this tool on client code at all.

## Threat model

- **Axiomap never makes a network request.** No Etherscan or Sourcify source-fetching, no
  telemetry, no crash reporting, no LLM or other API calls, no update checks. This is
  Decision #2 in `AXIOMAP.md` and is enforced in CI: a job walks `@axiomap/core`'s entire
  production dependency tree and fails the build on anything that imports `http`,
  `https`, `net`, `dns`, or `undici`. You do not have to take this on trust — read
  `scripts/check-no-network-deps.mjs` and the `network-invariant` job in
  `.github/workflows/ci.yml`, or run `pnpm check:network` yourself against a checkout.
- **Everything Axiomap writes stays local.** `.axiomap/graph.json` and `.axiomap/cache/`
  are a complete structural map of whatever was last analysed; they are `fs`-only,
  written beside the project, and gitignored by a `.gitignore` Axiomap writes into
  `.axiomap/` on first run. `.axiomap/review.json` is the one file meant to be committed
  and shared — it holds review status and body hashes, never source text.
- **The webview never serves an arbitrary file.** The code-preview bridge takes a graph
  node id, never a path — there is no parameter through which a caller could name a file
  outside the project. See `packages/core/src/source/slice.ts` and
  `test/serve-protocol.test.ts`, which asserts the absence of a file parameter on both
  sides of the bridge.
- **No LLM integration, ever** (Decision #5). No API keys, no model configuration, no
  additional network surface, and no nondeterminism in a tool whose value is being
  exactly right about a graph.
- **Untrusted input is Solidity source, not a trusted compiler AST.** The tolerant parser
  is built to degrade on malformed input (see `fixtures/pathological/`) rather than
  crash or hang; if you find an input that panics the parser or the CLI, that is a bug
  worth reporting under this policy.

What Axiomap does **not** protect against: it does not sandbox the code it reads (it
never executes Solidity or the project's own build scripts — `hardhat.config.{js,ts}` is
parsed statically and never run, with a test that proves it), and it is not a
vulnerability scanner. It highlights *surfaces* — reachability, access control shape,
danger operations — it does not detect exploits, and a clean Axiomap overlay is not a
clean bill of health.

## Supported versions

Axiomap is pre-1.0. Security fixes land on `main` and the latest published release only;
there is no long-term-support branch yet.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for a security report.

Use GitHub's private vulnerability reporting for this repository (the "Report a
vulnerability" button under the Security tab), which reaches maintainers directly without
creating a public issue. If that is not available to you, email the address on the
maintainer's GitHub profile with `AXIOMAP SECURITY` in the subject line.

Please include:

- What you found and why it matters (e.g., "the network-invariant check can be bypassed
  by X," "the source-slice bridge can be made to read outside the project via Y").
- A minimal reproduction — ideally a small `.sol` fixture and the exact command.
- The Axiomap version (`axiomap --version`) or commit hash.

We aim to acknowledge a report within a few days and to have a fix or a mitigation plan
before any public disclosure. Please give us a reasonable window to ship a fix before
disclosing publicly.
