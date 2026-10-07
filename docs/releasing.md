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
   must be explicitly selected. Private workspaces and `policy.json` holds
   (currently CLI) cannot be selected.
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
