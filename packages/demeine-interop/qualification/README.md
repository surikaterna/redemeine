# Non-publishing qualification (redemeine-ov0e.1)

Run from the supplied feature worktree. No script here publishes or creates a
commit. `prepare.mjs` replaces only `.cache/demeine-interop/candidate`, copies
implementation sources/changesets, and runs the real Changesets prerelease
version algorithm there. Changelog rendering alone is disabled in that disposable
snapshot (pre-audit changesets have no committed GitHub metadata). It then installs
independent workspace links so packing cannot accidentally use source versions.
It never runs versioning on the implementation tree or edits its pre.json.

```sh
NPM_EXECUTABLE="$(mise where npm:npm@11.21.0)/node_modules/.bin/npm"
mise exec node@24.20.0 -- node packages/demeine-interop/qualification/with-release-tools.mjs "$NPM_EXECUTABLE" node packages/demeine-interop/qualification/prepare.mjs
mise exec node@24.20.0 -- node packages/demeine-interop/qualification/with-release-tools.mjs "$NPM_EXECUTABLE" node packages/demeine-interop/qualification/artifacts.mjs
mise exec node@24.20.0 -- node packages/demeine-interop/qualification/with-release-tools.mjs "$NPM_EXECUTABLE" node packages/demeine-interop/qualification/packed-consumer.mjs
```

The bootstrap prepends the explicitly selected npm executable directory and the
current Node directory to PATH. Before each command it verifies Node24.20.0,
pnpm11.9.0, direct npm11.21.0, and npm spawned by both nested Node and pnpm-exec.
It logs the executable realpath and versions, failing closed on any mismatch.
Mise tool arguments alone can select Node's bundled npm11.19.0; do not rely on their
ordering or bypass the release prerequisites.

`artifacts.mjs` builds candidate kernel/aggregate/interop/Mirage and runs the existing
`scripts/release/simple.mjs check` with explicit `APPROVED_VERSIONS` and
`RELEASE_TAG=pre`. CLI is still held and absent from that plan. A **separate developer
pack** builds the unchanged source CLI 0.2.0-pre.0. No hold removal is needed.

Evidence under `.cache/demeine-interop/`:

- `version-delta.json`: source to actual candidate versions for every package.
- `artifacts/plan.json`: checked, dependency-ordered non-held candidate manifests,
  hashes and integrity. Its source SHA is the base HEAD; pre-audit implementation
  is explicitly uncommitted, so this is not a publish-authorized commit artifact.
- `inventory.json`: absolute tarball paths, SHA256/SHA512, base SHA and uncommitted flag.
- `consumer/`: isolated npm-installed tarballs, strict TypeScript 5.9.3 NodeNext
  `.mts` and `.cts` consumers, compiled ESM and CJS executions on Node24.20.0 and
  Node26.10.0 with `--no-experimental-require-module`. No source-loader/CJS-to-ESM
  fallback can conceal an incorrect require export.
- `cli-tool/node_modules/@redemeine/cli`: dependency-resolved developer package
  root for `REDEMEINE_CLI_DIR`. Launch its manifest bin (`dist/bin.js`) with Node;
  consumers must validate name and exact version 0.2.0-pre.0. Do not add this held
  CLI as a production dependency or assume registry publication.

The current Changesets delta is interop 0.1.0-pre.0 → **0.1.0-pre.1**;
kernel/aggregate 0.2.0-pre.1 → **0.2.0-pre.2**; Mirage → **1.0.0-pre.2**.
Automatic dependency bumps also affect CLI, saga, saga-runtime and testing in the
snapshot, but do not expand this approved artifact selection. Source manifests
remain on their initial versions. Runtime consumer registry manifests should pin
the derived versions, with temporary local tarball installation only for qualification.
Never fabricate registry lock entries for unpublished candidates.

Existing CLI qualification is separate:

```sh
mise exec node@24.20.0 -- node packages/demeine-interop/qualification/with-release-tools.mjs "$NPM_EXECUTABLE" pnpm --filter @redemeine/projection build
mise exec node@24.20.0 -- node packages/demeine-interop/qualification/with-release-tools.mjs "$NPM_EXECUTABLE" node packages/demeine-interop/qualification/cli-packed.mjs
```

The helper first uses real `pnpm pack` to materialize source-version manifests into
`developer-smoke/`, then runs the unchanged `pnpm --filter @redemeine/cli test:packed`
there. Running that existing gate directly on source uses `npm pack`, which leaves
`workspace:*` unchanged and fails its isolated npm-exec test; this is not fixed by
inventing lock entries or changing CLI source. Its normal fixture retains evidence
under `/tmp/opencode/standalone-cli-*`.

Independent Auditor verification is required before any ready-to-publish claim.
Diplomat owns eventual audited commits/push; publication, merge and first-publication
authorization are explicitly outside this task. Record final hashes in the Bead,
not a guessed future registry resolution.
