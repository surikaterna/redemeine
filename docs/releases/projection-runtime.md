# Projection runtime release candidate delivery

Beads: **redemeine-hpq1.3**, packaging dependency **redemeine-hpq1.2**, parent **redemeine-hpq1**.

One ordinary main RC image is proposed at `ghcr.io/surikaterna/redemeine-projection-runtime`.
The workflow is source-only preparation: no tag, release, image publication or deployment
has been performed by this task. Main image build/content/smoke proof remains pending;
this scaffold is not verification of a deliverable image.

## Authorized delivery after packaging verification

First finish the main Docker packaging gates and independent audit, then commit/merge
the reviewed candidate (including this workflow and metadata helper) to `main` through
the normal review process. Do not tag the unrelated base commit `6d2fbc37` or publish
an uncommitted worktree. The selected source must contain the helper and main Dockerfile.

Publishing a GitHub release for `projection-runtime-v0.1.0-rc.1` triggers the additive
image job. The component prefix is removed to produce image tag `0.1.0-rc.1`.
The existing `publish.yml` also runs for **every published release**, including this
component release: its full pnpm tests/build and npm publication are unchanged.
This ordinary npm behavior is accepted; there is no special npm guard or isolation.

Alternatively, a trusted operator can later use **Projection runtime image** manual
dispatch with `source_ref` (default `main`; prefer the exact reviewed commit) and
required `image_version`, for example `0.1.0-rc.1`. Dispatch publishes an image;
it is not a dry run and does not create a GitHub release or invoke `publish.yml`.
No dispatch is authorized or executed as part of source implementation.

Both modes check out the selected source and validate metadata before registry login.
The repository name is lowercased to form the GHCR path; trusted forks use their own
namespace. The checked-out full Git SHA, not the workflow event SHA, supplies revision
and `VCS_REF`. The job uses read-only contents and package-write `GITHUB_TOKEN`, no PAT,
release-body writes, attachments or credential changes. There is no PR publishing path.

The root context builds `packages/projection-service/Dockerfile` once for `linux/amd64`.
It receives `IMAGE_VERSION=0.1.0-rc.1` and the full `VCS_REF`; OCI source/revision/version
labels record these identities. The private service package stays version `0.1.0`:
an image RC label is not an npm package version change. No public SDK or changeset changes.

Only the explicit version and `sha-<first 12 commit characters>` tags are emitted;
there is no `latest` or floating RC alias. GHCR tags are mutable: this workflow does
not enforce immutability or prevent overwrites on repeated dispatch/publication.
Allocate the next RC version for changed candidates. The job summary records the
full source SHA and resulting `image@sha256:...`; retain that digest and job evidence
in release notes and deploy **by digest**, not by a potentially moved tag.

## Application and operations contract

See [main image architecture](../architecture/projection-runtime-image.md) for build,
typed bundle example, complete environment variables, storage and ownership constraints.
The image requires `PROJECTION_DEFINITIONS_MODULE` pointing to one read-only, regular,
self-contained `.mjs` application bundle (1..4 MiB), exporting `registrations` (1..64).
There is no bundled test application or default definition. An application can mount
that file read-only or build a small derived image from the recorded digest:

```dockerfile
FROM ghcr.io/surikaterna/redemeine-projection-runtime@sha256:<recorded-digest>
COPY definitions.mjs /app/definitions/definitions.mjs
ENV PROJECTION_DEFINITIONS_MODULE=/app/definitions/definitions.mjs
```

Keep the copied bundle root-owned and readable by UID 10001, with trusted root-owned
ancestors. Prebundle application dependencies; no runtime npm install or SDK embedding
framework is supplied. This is trusted code, not a sandbox. Use synchronous pure
suffix-contribution reducers and event-stable commutative routing; Promise/thenable
callbacks refuse before state commit/coverage/ACK. Generations are persisted broker
epochs, not authored in the module. Changed runtime/module/config identity refuses
established state rather than migrating or resetting it automatically.

Supply real credentials only through an operator-managed runtime env file/secret,
never image build arguments. `RABBITMQ_MANAGEMENT_URL` is a base URL such as
`https://rabbit-management.example` (placeholder, no user info or `/api` suffix);
the client appends API paths. Configure management credentials, vhost permissions
and TLS policy appropriate to the deployment; this document does not certify them.

Use the same correctly owned 0700 persistent local writer-domain mount, one owner,
and stop-before-start. Separate private volumes do not fence competing hosts.
An ACTIVE unclean run still requires manual quiescence/reconciliation; no reset shortcut.
Internal readiness is not liveness or historical completeness. This worker consumes
the admitted live suffix, not a complete history. Historical eight verified gates and
one user-accepted unqualified unclean-restart probe do not requalify the changed image;
no new full-stack campaign, ARM qualification, HA or GA claim is made here.
