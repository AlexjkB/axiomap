# Releasing

This is a runbook, not automation that runs itself — nothing in this repo publishes
anything without a human triggering it. Phase 9 (see `docs/PROGRESS.md`) prepared the
pieces below; it deliberately did not run any of them.

## One-time setup, before the first release

1. **Register the `axiomap` publisher/organization name** on:
   - [npmjs.com](https://www.npmjs.com) (an npm organization or user named `axiomap`, or
     adjust the `@axiomap/*` scope in every `package.json` if that name is taken).
   - [VS Code Marketplace](https://marketplace.visualstudio.com/manage) — publisher id
     `axiomap`, matching `packages/vscode/package.json`'s `publisher` field.
   - [Open VSX](https://open-vsx.org) — same publisher id, separately registered.

   `docs/PROGRESS.md`'s Phase 8b entry flags this: if `axiomap` is taken on either
   marketplace, the publisher id has to change *before* the first publish, since it's
   permanent afterwards.

2. **Fix the placeholder repository URL.** Every publishable `package.json`
   (`packages/{core,webview,cli}/package.json`) and `.github/ISSUE_TEMPLATE/config.yml`
   currently point at `github.com/AlexjkB/axiomap` as a placeholder — confirm that's the
   real repository location (or update it) before publishing, since `repository.url` is
   what npm uses for provenance attestation and the "Repository" link on the package page.

3. **Add secrets to the GitHub repository** (Settings → Secrets and variables → Actions):
   - `VSCE_PAT` — a VS Code Marketplace personal access token, for `vsce publish`.
   - `OVSX_PAT` — an Open VSX personal access token, for `ovsx publish`.
   - npm publishing uses **OIDC + `id-token: write`**, configured in
     `.github/workflows/release.yml` — no npm token secret needed if npm's trusted
     publisher is set up for this repo (npm → package settings → Trusted Publishers).
     Until that's configured, add `NPM_TOKEN` as a fallback and adjust the workflow.

4. **Turn the repository public**, and only then enable branch protection on `main`
   requiring the `check`, `network-invariant`, `licences`, and `vsix` jobs from
   `.github/workflows/ci.yml` — this needs an actual GitHub repository with admin access
   and can't be done from files in the working tree. Enable Dependabot alerts and CodeQL
   default setup at the same time (the `dependabot.yml` and `codeql.yml` workflow files
   are already in `.github/`; enabling them is a repo-settings toggle plus whatever the
   Actions tab needs on first run).

## Every release after that

```bash
pnpm changeset add          # inside a change that should ship — describe it, pick a bump
pnpm changeset status       # CI runs this; fails a PR that changed a package with no changeset
```

When ready to cut a release: run `pnpm version-packages` (`changeset version`) — this
consumes every pending `.changeset/*.md` file, bumps the affected package versions,
updates each package's `CHANGELOG.md`, and deletes the consumed changesets. Commit that as
its own PR, review the version bumps, merge to `main`.

Then either:

- **Let the Changesets GitHub Action do it** — `.github/workflows/release.yml` opens a
  "Version Packages" PR automatically when changesets are pending on `main`, and publishes
  to npm with provenance the moment that PR is merged.
- **Or run it by hand**:
  ```bash
  pnpm build
  pnpm verify:npm-pack        # packs core/webview/cli into a scratch dir, runs `axiomap build` from it
  pnpm changeset publish      # npm publish --provenance for each bumped, non-ignored package
  ```

## The VS Code extension and Open VSX

`@axiomap/vscode` is deliberately **excluded from Changesets** (`.changeset/config.json`'s
`ignore`) — it isn't published to npm, so its version is a separate concern, tracked by
`VERSION` in `scripts/package-vsix.mjs` rather than its workspace `package.json` (which
stays at a nominal version forever; see that script's comments for why).

```bash
pnpm notices:check           # THIRD-PARTY-NOTICES.md must be current before packaging
pnpm build
pnpm package:vsix            # writes dist/axiomap-<version>.vsix
pnpm verify:vsix             # unpacks it with no workspace above it, parses a real contract
npx vsce publish --packagePath dist/axiomap-<version>.vsix -p "$VSCE_PAT"
npx ovsx publish dist/axiomap-<version>.vsix -p "$OVSX_PAT"
```

Bump `VERSION` in `scripts/package-vsix.mjs` by hand before packaging a new release — it
is the one version number in this repo Changesets does not touch.

## What CI already checks, so a release doesn't have to re-discover it

- `pnpm check` — build, test, lint across all four packages.
- `pnpm check:network` — `@axiomap/core`'s production dependency tree has no
  network-capable import.
- `pnpm check:licences` — every production dependency's licence is reviewed and allowed;
  a new copyleft or unreviewed dependency fails the build rather than shipping silently.
- `pnpm notices:check` — `THIRD-PARTY-NOTICES.md` matches what the licence walk would
  generate today.
- `pnpm verify:vsix` — the packaged `.vsix`, unpacked outside this repo, actually parses a
  contract (catches the class of bug where a path resolves in the workspace and nowhere
  else).
- `pnpm verify:npm-pack` — the same idea for the npm tarballs: pack `core`, `webview` and
  `cli`, install them into a directory with no workspace above it, and run `axiomap build`
  against a real fixture from there.

None of these need repeating by hand before a release; they need to still be green.
