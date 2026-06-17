---
title: "Wave 3 Blueprint: Branch Protection + Release Integrity Controls"
bead: "redemeine-1uh.5"
status: "proposed"
last_updated: "2026-04-08"
owner_role: "Architect"
---

# Wave 3 Blueprint: Branch Protection + Release Integrity Controls (redemeine-1uh.5)

## 1) Scope and intent

This blueprint defines enforcement controls for:

1. **Secure merges** into protected branches (`main` and `master` if both exist).
2. **Release integrity** through provenance attestation, SBOM publication, and verification touchpoints.
3. **Operational safety** via phased rollout and explicit rollback when enforcement blocks delivery.

Design-only artifact. No workflow/ruleset implementation is performed in this bead.

## 2) Preconditions / dependencies

Wave 3 enforcement is gated on completed Wave 1 and Wave 2 design contracts:

- `redemeine-1uh.1`: universal required PR gate (`ci-required-gate` stable check)
- `redemeine-1uh.4`: workflow permissions minimization + SHA pinning policy
- `redemeine-1uh.2`: dependency + vulnerability automation check design
- `redemeine-1uh.3`: `SECURITY.md` + `CODEOWNERS` governance design

## 3) Branch protection baseline (target settings)

Apply repository rulesets/branch protection to **`main`** (and mirror to `master` if still used):

### 3.1 Pull request and review controls

- Require pull request before merging: **enabled**
- Required approving reviews: **2**
- Require review from Code Owners: **enabled**
- Dismiss stale approvals on new commits: **enabled**
- Require approval of most recent reviewable push: **enabled**
- Allow self-approval: **disabled**
- Last-pusher approval bypass: **disabled**

### 3.2 Status check controls

- Require status checks to pass before merge: **enabled**
- Require branches to be up to date before merging: **enabled**
- Required checks (stable names):
  - `ci-required-gate` (from Wave 1)
  - `actions-policy-gate` (Wave 1 policy enforcement)
  - `dependency-security-gate` (Wave 2 dependency/vuln gate)
- Check-source restriction: require checks from GitHub Actions in this repository (prevent spoofed contexts).

### 3.3 Merge strategy and history controls

- Require linear history: **enabled**
- Force pushes: **disabled**
- Branch deletion protection: **enabled**
- Direct pushes to protected branches: **disabled** except designated release-admin bypass role (break-glass only, audited)
- Merge queue: **recommended enabled** when throughput/flake profile is acceptable.

### 3.4 Signed commit/tag expectations

- Require signed commits on protected branches: **enabled** once contributor key coverage is validated.
- Protected release tags (`v*`): creation limited to release workflow/bot identity and release-admins.

## 4) Required reviews and CODEOWNERS integration

High-risk path ownership (from `redemeine-1uh.3`) must be enforced by code-owner review:

- `.github/workflows/**` -> Platform/Security owners
- release scripts + packaging manifests -> Release + Security owners
- dependency manifests/lockfiles -> Runtime + Security owners

Approval policy for sensitive changes:

- Any PR touching `.github/workflows/**` or release pipeline paths requires:
  - at least **1 security/code-owner approval** and
  - total **2 approvals** minimum.

## 5) Release integrity controls (attestation + SBOM)

## 5.1 Workflow touchpoints

Release pipeline (`release.yml` or equivalent) must include these ordered touchpoints:

1. **Build artifacts deterministically** (tag-triggered).
2. **Generate SBOM** per releasable artifact (SPDX or CycloneDX).
3. **Create provenance attestation** for each published artifact digest.
4. **Sign published artifacts** (or signed attestations bound to digest).
5. **Verify attestation + SBOM presence** before publish/promote step.
6. **Publish release + attach evidence** (SBOM + attestation metadata/URIs).

## 5.2 Minimum technical requirements

- GitHub workflow permissions for release jobs:
  - `contents: write` (release assets)
  - `id-token: write` (OIDC provenance/attestation)
  - everything else: least privilege / explicit
- SBOM generation:
  - Produce machine-readable SBOM files per artifact (`*.spdx.json` or `*.cdx.json`)
  - Store as release assets and archive in CI artifacts
- Provenance attestation:
  - Use SLSA-compatible/GitHub artifact attestation mechanism bound to artifact digest
  - Record attestation reference (URL/ID) in release notes body or manifest
- Verification gate:
  - Promotion/deploy jobs must fail closed if attestation verification fails or SBOM is missing.

## 5.3 Evidence retention

Retain release integrity evidence in two places:

1. **GitHub Release assets**:
   - built artifacts
   - SBOM documents
   - integrity manifest (artifact digest -> SBOM + attestation references)
2. **Workflow run artifacts/logs**:
   - attestation generation output
   - verification output

Retention policy:

- Release assets: kept for lifetime of supported release
- CI artifacts/logs: minimum **180 days** (or organizational minimum if higher)

## 6) Phased rollout plan

### Phase A - Monitor mode (1 sprint)

- Configure all required checks to run and report.
- Keep branch protection in "observe" for newly introduced checks where possible.
- Track flakes, false positives, and runtime overhead.

Exit criteria:

- Required checks pass rate >= 95% on non-draft PRs.
- No unresolved critical false-positive classes.

### Phase B - Enforce merge protection

- Enable required checks and mandatory review settings on `main`.
- Enforce CODEOWNERS review requirements for protected paths.
- Enable linear history + no direct pushes.

Exit criteria:

- Two weeks stable merge throughput without emergency bypass.

### Phase C - Enforce release integrity gates

- Block release publication if SBOM/attestation generation or verification fails.
- Require integrity manifest for every release tag.

Exit criteria:

- Two consecutive successful releases with complete integrity evidence.

## 7) Rollback / break-glass procedure

Use only when enforcement causes delivery outage or critical incident response blockage.

1. Incident commander declares break-glass and opens incident ticket.
2. Temporarily relax only the minimal failing control, in this order of preference:
   - Remove newly-added required check from protection (keep PR/review controls intact)
   - If release-only failure, bypass release integrity gate for one hotfix release with explicit approvers
   - Do **not** disable all branch protection unless repository availability is at risk
3. Timebox relaxation to **<= 24h** and capture:
   - who changed rule
   - exact setting changed
   - reason / impact
   - planned re-enable time
4. Create follow-up remediation bead(s) linked with `discovered-from:redemeine-1uh.5`.
5. Re-enable controls and attach post-incident verification evidence.

## 8) Auditor verification checklist (pass/fail)

Audit passes when all conditions are true:

1. Branch protection/ruleset on `main` includes PR requirement, 2 approvals, CODEOWNERS review, stale dismissal, linear history, and no force pushes.
2. Required checks list exactly includes stable check contexts:
   - `ci-required-gate`
   - `actions-policy-gate`
   - `dependency-security-gate`
3. Release pipeline has explicit SBOM generation and provenance attestation steps with `id-token: write` only where needed.
4. Release promotion/publish is fail-closed on missing/invalid attestation or missing SBOM.
5. Rollback playbook is documented and references incident logging + timeboxed re-enable.

## 9) Risks and assumptions

- Assumes stable check names from prior waves are implemented exactly as specified.
- Enforcing signed commits may require contributor onboarding period (keys/sigstore identities).
- Merge queue adoption may be deferred if CI flake rate remains above acceptable threshold.


