# Releasing packages

Use Node **24.20.0**, root integrity-pinned **pnpm 11.9.0**, and release-host
**npm 11.21.0**. The Packages workflow installs and checks these pins.

## Changeset → version PR → opt-in publication

**Manual dispatch now defaults to qualification only (`publish=false`).** Unlike
the earlier workflow, operators and automation that intend registry writes must
explicitly set the boolean input `publish=true`. False still builds, checks,
packs and uploads the selected main-source artifacts; the publish job is skipped.
Qualification has only read permissions and no OIDC token permission.

1. Add an ordinary Changeset (`pnpm exec changeset`). On main pushes, Changesets
   action **v1.5.3** with CLI **2.31** opens the generated version PR; it never
   publishes. Review versions, dependency pins, changelogs, prerelease state and
   lockfile, pass normal checks, then merge. Token-created PRs may require a
   maintainer close/reopen to trigger checks.
2. Confirm each package's npm trusted publisher: GitHub Actions,
   **surikaterna/redemeine**, workflow **release.yml**, optional environment **blank**,
   direct publication allowed. A new name may require separately owner-managed
   first-publication setup. Never bootstrap placeholders or add token fallback.
3. Manually dispatch **Packages** on **main**, entering the exact space-separated
   `name@version` source versions to qualify and channel `pre` (default) or
   `latest`. Leave `publish=false` to obtain checked files without registry writes;
   set `publish=true` only for an explicitly authorized publishing batch.
   Approval is validated before building/packing. `latest` requires
   stable versions and Changesets prerelease mode exited; this pipeline does not
   change prerelease state. New public workspaces need no membership list, but
   must be explicitly selected. Private workspaces and any `policy.json` holds
   cannot be selected. CLI publication is approved under `redemeine-ov0e.4`, but
   its first write is reserved for the user in the sequence below. Approval is
   not proof of publication.
4. Qualification runs build, lint, typecheck, application and release tests,
   then `pnpm pack` with lifecycle/config hooks disabled. Root LICENSE is copied
   only when missing and that owned copy is removed afterward. The small plan
   records source commit, tool pins, channel, dependency order and tarball hashes.
   Only with `publish=true`, the publish job downloads **checked-packages by that run's artifact ID** and
   checks the qualification job's plan SHA256, source, approval and tarball bytes.
   It never builds or repacks. Only this job has OIDC permission; no environment
   activation, npm secret, or `whoami` request is needed.
5. In publishing mode, all exact versions are preflighted before any writes. Only explicit 404 means
   absent. Existing identical SHA512 bytes are skipped; missing integrity or a
   conflict stops the whole batch. Publication uses checked `.tgz` paths with
   `--ignore-scripts --access public --provenance` and the explicit channel.
   npm exit zero is accepted success, immediately printed as **Published**.
   There is no public readback, polling, consumer gate or automatic tag promotion.

## Failure and rerun

With `publish=true`, publication is not atomic. A failed/ambiguous npm command stops immediately and
prints published, already-matching/skipped, current **UNKNOWN**, and pending
versions. Review the failure, then use **Re-run failed jobs** on the same run to
download the original artifact and retry: matching existing bytes skip, pending
versions publish once. Do not rerun qualification/rebuild as a substitute for
the original bytes. Missing/expired artifacts or different bytes require fresh
review and possibly a new version. A skipped version does **not** move a tag.
Later tag changes require separate owner authorization and standard npm tooling,
not an automated promotion path here.

## Local checks and limits

```sh
pnpm install --frozen-lockfile
pnpm -r build && pnpm run lint && pnpm run typecheck && pnpm test
pnpm run test:release:simple
APPROVED_VERSIONS='@redemeine/example@1.0.0' RELEASE_TAG=pre \
  pnpm run release:check-simple /absolute/new/output-directory
```

Use actual reviewed source names/versions; the output directory must not exist.
The check command performs read-only npm metadata requests, never publication.
All dependency fields in the actual packed manifests must use registry semver
(ordinary npm aliases supported); private production/optional/peer edges fail,
while private development inputs are allowed. Selected owned dependencies must
satisfy the chosen ranges; omitted owned dependencies need already-public valid
metadata. Missing entrypoints, unsafe archives, mismatched identities/licenses,
and literal private JS/DTS imports fail. This is static checking plus shallow
direct-owned-dependency metadata validation—not a runtime sandbox, proof about
arbitrary computed loaders, or recursive validation of historical registry trees.
Independent package packed-boundary and CLI smoke tests remain ordinary tests.

## Approved CLI/interop batch: preparation is not publication

`redemeine-ov0e.4` records user approval including CLI. At preparation time CLI and
interop are unpublished; owner permissions and trusted-publisher settings are
not established by a registry 404. The prospective `pre` batch is:

| Dependency-safe order | Expected version from Changesets |
| --- | --- |
| `@redemeine/kernel` | `0.2.0-pre.2` |
| `@redemeine/aggregate` | `0.2.0-pre.2` |
| `@redemeine/demeine-interop` | `0.1.0-pre.1` |
| `@redemeine/cli` | `0.2.0-pre.1` |
| `@redemeine/mirage` | `1.0.0-pre.2` (intentional breaking export removal) |

Aggregate, interop and CLI depend on kernel; Mirage depends on kernel and aggregate.
Aggregate is not a CLI runtime dependency. Projection `0.2.0-pre.1` is already
public and is not republished. Additional Changesets-generated saga/testing bumps
are version-PR review items, not batch approval; private saga-runtime never publishes.

For preparation, run `pnpm exec changeset status --output <new-evidence>/release-plan.json`
and **`pnpm run version:packages` over all pending changesets in a disposable snapshot**.
Keep feature versions, lockfile and pre.json unchanged. Capture the full generated
versions, changelogs, lock and prerelease-state delta, then run the checks above
with exactly the five derived versions. Resolve external ranges in fresh packed
consumers as well as testing the workspace lock. Local candidate hashes are
provisional; historical `.1` four-package plans and `.3` developer CLI tarballs
are not final release artifacts.

For this release, source PR creation/review/merge and subsequent generated
version-PR integration are authorized. They still require independent source and
full version-diff audits, normal required checks/review and normal merges; no
admin/force/check bypass. Do not publish feature/snapshot candidates or forge
workflow/OIDC context. Once reviewed source and version commits reach main, use
these **two ordered dispatches**, refreshing versions from that reviewed source:

| Run | `publish` | Exact `approved_versions` (`tag=pre`) |
| --- | --- | --- |
| Existing-package publication, first | `true` | `@redemeine/kernel@0.2.0-pre.2 @redemeine/aggregate@0.2.0-pre.2 @redemeine/mirage@1.0.0-pre.2` |
| Manual-file qualification, only after the three are public | `false` | `@redemeine/kernel@0.2.0-pre.2 @redemeine/aggregate@0.2.0-pre.2 @redemeine/demeine-interop@0.1.0-pre.1 @redemeine/cli@0.2.0-pre.1 @redemeine/mirage@1.0.0-pre.2` |

**Never dispatch the five-package batch with `publish=true`.** Agents must stop
before any CLI or interop registry write, even if workflow permissions would allow
it. Do not rely on cancellation or a permission failure to stop publication.

Record the first run's ID/URL, main head SHA, published/skipped/unknown/pending
outcomes and exact registry versions/integrities. Stop on a failed or ambiguous
write and investigate before an authorized same-artifact retry.

For the second run, verify the same reviewed versioned main SHA and exact versions.
If main advanced, audit the intervening release-relevant diff before proceeding;
do not silently change source identity. Require qualification success and a
**skipped publish job**. Record run ID/URL, artifact ID/download URL, head SHA,
plan SHA256 and creation/expiry (currently seven-day retention). CLI/interop must
remain unmodified in the registry. Auditor independently downloads by artifact ID,
validates the full plan/files/manifests/checksums and packed CLI/interop behavior,
and compares the existing three packages' SHA512 with the first run and registry.
The two runs pack independently: byte equality is checked, never assumed. A
mismatch stops handoff for review; never overwrite a published version or replace
its bytes by repacking. Only the second run's exact new-name files go to the user.

## First-name owner bootstrap: future same-artifact handoff

Only **`@redemeine/demeine-interop` and `@redemeine/cli`** are first-name/manual-owner
candidates. Kernel, aggregate and Mirage are existing-name workflow updates.
The existing three use the trusted workflow first. CLI/interop first-name writes
are reserved for the user; agents prepare their qualification-only artifact and
stop. Owner permissions and exact registry absence/integrity must be checked
before any later manual write.

Use only the second, qualification-only **main-run `checked-packages` artifact ID**, source SHA,
plan SHA256 and exact files; verify both SHA256 and SHA512 against its inventory.
Kernel's required version must already be public (preferably aggregate too for
fixture closure). The following are **future templates, not commands for local
candidate files**. Refresh versions from the final plan. An owner with legitimate
npm login and 2FA may run them only after these gates are satisfied. The agent
handoff includes the real download directory, source/version PR URLs and merge
SHAs, both run records, artifact ID/expiry, dependency-public evidence and both
SHA256/SHA512 values. Agents do not execute either command; `.4` remains open as
`manual_publish_pending` until the user's later publication:

```sh
npm publish "$AUDITED_RELEASE_DIR/redemeine-demeine-interop-0.1.0-pre.1.tgz" --ignore-scripts --access public --tag pre --registry=https://registry.npmjs.org/
npm publish "$AUDITED_RELEASE_DIR/redemeine-cli-0.2.0-pre.1.tgz" --ignore-scripts --access public --tag pre --registry=https://registry.npmjs.org/
```

`AUDITED_RELEASE_DIR` means the final main-run files, never `.cache` developer or
candidate output. Local owner bootstrap does not claim CI provenance: do not add
`--provenance` without supported CI context. Workflow publication retains it.
Never publish placeholders, use `latest` for these prereleases, or change existing
latest tags as part of this batch.

After the names exist, the owner configures the trusted publisher for
`surikaterna/redemeine`, `release.yml`, environment **blank**, with direct npm
publish allowed; configure near use and confirm success rather than assuming
permissions. Any failed-job retry here is limited to the authorized existing-three
publishing run and its preserved files; do not enable publication on the five-package
qualification-only run. Matching SHA512 versions skip; missing/conflicting integrity
stops. Do not repack or rerun
qualification to replace immutable versions. Artifact expiry or changed bytes
requires fresh review/version decisions. Track published/skipped/unknown/pending
separately. This owner exception adds no token fallback to automation.
