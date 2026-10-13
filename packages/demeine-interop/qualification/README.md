# Historical non-publishing qualification (redemeine-ov0e.1)

The procedure below describes the original four-package/local developer-CLI
fixture. **It is not the current five-package release preparation.** User approval
in `redemeine-ov0e.4` removes the CLI hold, but does not make historical artifacts
publishable. Preserve frozen `.1`/`.3` evidence; do not rerun these helpers over it.
Current preparation uses a NEW disposable snapshot, the real `pnpm run
version:packages` (including changelogs/lock/pre-state), and the existing generic
five-package release checker. Follow `docs/releasing.md`; only a later reviewed
main-run `checked-packages` artifact can become final publication input.

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
`RELEASE_TAG=pre`. CLI was held and absent from that historical plan. A **separate
developer pack** built source CLI 0.2.0-pre.0. These helpers intentionally retain
their local-fixture scope; do not treat their versions/selection as today's release plan.

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
  this historical fixture validates name and exact version 0.2.0-pre.0. It is not
  the approved candidate CLI0.2.0-pre.1 or proof of registry publication.

The historical Changesets delta was interop 0.1.0-pre.0 → **0.1.0-pre.1**;
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
Publication was outside the historical task; it is now user-approved, including
CLI, subject to the main/review/npm gates described in `docs/releasing.md`.
Diplomat owns audited source delivery; current prep does not authorize PR creation,
merge, feature publication or substitution of these old files for main-run bytes.
Record candidate versus final hashes distinctly in the Bead, never a guessed
future registry resolution.
# Standalone qualification (`redemeine-ov0e.6`)

For the standalone major API, use `standalone-packed.mjs`, not the historical
supplied-base/CLI helpers below. In a disposable snapshot run actual Changesets
status and `pnpm run version:packages`, build interop and aggregate, then run the existing
`release:check-simple` with both derived versions selected. Do not
version the feature worktree or overwrite previously qualified tarballs.

From the worktree, under the release Node/pnpm/npm pins:

```sh
node packages/demeine-interop/qualification/standalone-packed.mjs \
  /absolute/path/to/artifacts \
  /absolute/path/to/actual/host/node_modules/@surikat/factory/lib/types.d.ts \
  /absolute/path/to/fresh/qualification-output
```

The output directory must not exist. This installs the exact candidate alongside
the registry Aggregate baseline by default. For integrated naming qualification,
the checked plan must additionally contain the actual Changesets-derived Aggregate
tarball. Its hash, version agreement with interop's packed dev dependency and
installed integrity are verified, and it replaces the old registry baseline only
in this disposable consumer. The selected combination is recorded in `installed.json`.
No registry lock or source package version is rewritten by this runner.
The single-artifact mode is retained for historical baselines; it is not evidence
for the new multiword-default naming contract exercised by the current consumer.

The runner also creates
an independent minimal consumer containing only the candidate and TS5.9.3/TS7.0.2.
That consumer checks both `.mts`/`.cts` with NodeNext and browser-oriented Bundler
resolution, `strict: true`, `skipLibCheck: false`, `types: []` and `typeRoots: []`.
Loaded-file realpaths must remain inside its physical install; no ancestor,
Demeine, Factory, test ambient dependency, or manually supplied Node types can
mask a missing published dependency. Run `minimal-types.mjs TARBALL FRESH_OUTPUT`
separately to reproduce this declaration-closure gate.

An optional fourth `standalone-packed.mjs` argument selects the full host fixture's
Node type version (default `24.13.2`); `26.6.2` also exercises the actual current
consumer's host typings. The separate minimal fixture never installs Node types
directly: its declaration dependencies must come from the candidate itself.

Minimal checks also cover state-specific service inference and message fields.
Separate negative programs must produce exactly the expected wrong-state errors
for constructor injection and stored-handler calls, without diagnostic suppression.
The full fixture runs `state-services.mts`/`.cts` plus the queued-rejection matrix
(native, foreign-realm, thenable, and throwing getter/method inputs) under
strict rejection policy on Node24 and Node26. Promise adoption is observed early;
validation, command mutation and sink processing must remain FIFO work.

No helper installs Bluebird or its typings directly. The minimal production graph
must contain neither package; the browser bundle must not include it. Real legacy
fixtures can still resolve it transitively. The runner compiles standalone consumers
separately from the unchanged strict legacy compatibility program, compares any
legacy failure with a real Demeine-only baseline, and records the raw diagnostics.
Missing legacy declaration prerequisites remain a **blocked** gate (runner exits
nonzero after completing independent runtime/browser gates), never a green strict
compatibility claim or an excuse to add forbidden typings or relax `skipLibCheck`.

### Approved prerelease exception (`redemeine-p169`)

For the reviewed standalone **1.0.0-pre.2** candidate only, the operator approved
an explicit exception for published **Demeine 1.3.0**'s missing Bluebird typings.
It is bound to tarball SHA-256
`719181c2c7fe508eaf79de5253fe110a3cf62a6e26650ff58154ca41e1234cac`,
already checked against the actual packed bytes. Any runtime, dependency or other
artifact change requires renewed review before updating this approval fingerprint;
the same package version or a new internally consistent plan is not approval.
Append `--allow-legacy-bluebird-baseline` to the command above to apply it.
Without that flag the runner still exits nonzero. Test the policy with
`node --test packages/demeine-interop/qualification/legacy-types-policy.test.mjs`.

Both strict legacy compiler programs still run with `skipLibCheck: false`.
Each must produce exactly one TS7016 at
`demeine/lib/repository/Partition.interfaces.d.ts(1,21)` for module `bluebird`,
identical to its Demeine-only baseline. Additional or different diagnostics,
compiler termination, unexpected stderr, or other package versions refuse.
All native declaration, runtime, real Repository/Tapeworm, rejection and browser
gates remain mandatory. No Bluebird/type dependency is injected into the fixture.

Reports retain the nonzero compiler statuses and raw diagnostics. A successful
exception run is `passed_with_approved_exception`, **not** a strict legacy pass;
`qualification-status.json` records `legacyStrictPassed: false`. This does not
repair strict consumers of the published legacy library or certify every host.
Aggregate results use native promises: Bluebird extension methods and its
scheduling are not promised. The exception requires no upstream Demeine changes,
does not close `redemeine-p169`, and grants no merge or publication authority.

The full integration fixture then installs the candidate alongside
public dependencies, compiles strict import/require declarations with TS5.9.3 and
TS7.0.2, runs native ESM/CJS on Node24/26, runs all package tests against installed
exports, and bundles/runs a browser lifecycle using the real `events` dependency.
It checks production imports via syntax nodes (not comments), records the actual
Factory declaration hash, and compares installed source maps/README with source.
Legacy Demeine and its host `regenerator-runtime` are integration-fixture
dependencies, not standalone runtime requirements. Logs record exact commands;
this is qualification only, never registry publication or consumer lock delivery.

## Historical supplied-base qualification
