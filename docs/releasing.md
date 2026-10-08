# Releasing packages

Use Node **24.20.0**, root integrity-pinned **pnpm 11.9.0**, and release-host
**npm 11.21.0**. The Packages workflow installs and checks these pins.

## Changeset → version PR → manual publication

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
   `name@version` source versions to publish and channel `pre` (default) or
   `latest`. Approval is validated before building/packing. `latest` requires
   stable versions and Changesets prerelease mode exited; this pipeline does not
   change prerelease state. New public workspaces need no membership list, but
    must be explicitly selected. Private workspaces and any `policy.json` holds
    cannot be selected. CLI publication is now approved under `redemeine-ov0e.4`;
    the current policy has no holds. Approval is not proof of publication.
4. Qualification runs build, lint, typecheck, application and release tests,
   then `pnpm pack` with lifecycle/config hooks disabled. Root LICENSE is copied
   only when missing and that owned copy is removed afterward. The small plan
   records source commit, tool pins, channel, dependency order and tarball hashes.
   The publish job downloads **checked-packages by that run's artifact ID** and
   checks the qualification job's plan SHA256, source, approval and tarball bytes.
   It never builds or repacks. Only this job has OIDC permission; no environment
   activation, npm secret, or `whoami` request is needed.
5. All exact versions are preflighted before any writes. Only explicit 404 means
   absent. Existing identical SHA512 bytes are skipped; missing integrity or a
   conflict stops the whole batch. Publication uses checked `.tgz` paths with
   `--ignore-scripts --access public --provenance` and the explicit channel.
   npm exit zero is accepted success, immediately printed as **Published**.
   There is no public readback, polling, consumer gate or automatic tag promotion.

## Failure and rerun

Publication is not atomic. A failed/ambiguous npm command stops immediately and
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

Source PR creation/review/merge and subsequent generated version-PR review/merge
remain gates requiring their own authorization. Once reviewed source and version
commits reach main, the normal main dispatch qualifies and publishes the selected
batch. **Dispatch is a real publishing operation**, not a way to obtain dry-run
files. Do not publish feature/snapshot candidates or forge workflow/OIDC context.

## First-name owner bootstrap: future same-artifact handoff

Only **`@redemeine/demeine-interop` and `@redemeine/cli`** are first-name/manual-owner
candidates. Kernel, aggregate and Mirage are existing-name workflow updates.
Prefer the normal trusted workflow where permissions allow. If a first-name
publication needs owner bootstrap, stop the failed/ambiguous job and inspect the
exact registry version and integrity before another write.

Use only that reviewed **main-run `checked-packages` artifact ID**, source SHA,
plan SHA256 and exact files; verify both SHA256 and SHA512 against its inventory.
Kernel's required version must already be public (preferably aggregate too for
fixture closure). The following are **future templates, not commands for local
candidate files**. Refresh versions from the final plan. An owner with legitimate
npm login and 2FA may run them only after these gates are satisfied:

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
permissions. Resume the same failed publish job using preserved files. Matching
SHA512 versions skip; missing/conflicting integrity stops. Do not repack or rerun
qualification to replace immutable versions. Artifact expiry or changed bytes
requires fresh review/version decisions. Track published/skipped/unknown/pending
separately. This owner exception adds no token fallback to automation.
