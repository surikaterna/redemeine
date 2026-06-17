# Universal Required PR Gate Blueprint (Wave 1)

- **Bead ID:** `redemeine-1uh.1`
- **Scope owner:** Architect (planning/design only)
- **Status:** Blueprint for Engineer/Auditor implementation in subsequent execution step

## Goal

Define a single, deterministic, always-present pull-request gate that can be marked **required** in branch protection without introducing merge deadlocks from skipped/path-filtered checks.

## Current-state findings (input to design)

- Existing workflows are fragmented and purpose-specific:
  - `.github/workflows/documentation-audit.yml` (PR, path-filtered, write permissions, auto-commits)
  - `.github/workflows/testing-benchmark.yml` (PR, path-filtered, non-blocking)
  - `.github/workflows/deploy-docs.yml` (push to `main`)
  - `.github/workflows/publish.yml` (release)
- No single universal PR gate with stable required-check semantics currently exists.
- Existing `paths:` PR workflows can be skipped, which is unsafe to mark as required.

## Target workflow files

### 1) Add (new required gate)

- **`.github/workflows/ci-required-pr-gate.yml`**

Purpose: host the universal required PR workflow for branch protection.

### 2) Keep informational workflows non-required

- `.github/workflows/testing-benchmark.yml` remains informational/non-required.
- `.github/workflows/documentation-audit.yml` remains non-required until permissions/minimization hardening in `redemeine-1uh.4` and policy decision in `redemeine-1uh.2/.5`.

> Branch protection must require only the stable check from `ci-required-pr-gate.yml` in this wave.

## Required check naming strategy (stable)

Use a single aggregator job with immutable naming:

- **Workflow name:** `CI Required PR Gate`
- **Required job id:** `required-gate`
- **Required job display name:** `ci-required-gate`

Branch protection should require:

- `ci-required-gate`

Rules:

1. Do not encode runtime dimensions in required check name (no Node/Bun version suffixes, no matrix values).
2. If internal job topology changes later, preserve `required-gate` job id and `ci-required-gate` display name.
3. Any experimental/perf/docs checks must use separate names and remain optional.

## Trigger rules

`ci-required-pr-gate.yml` triggers:

```yaml
on:
  pull_request:
    branches: [main, master]
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
```

Design constraints:

- **No `paths` or `paths-ignore` filters** on the required workflow.
- Draft PR behavior is implementation choice; recommended to still run for deterministic visibility.
- Include `merge_group` for merge queue compatibility (if/when enabled).

## Job topology and policy

Recommended jobs inside `ci-required-pr-gate.yml`:

1. `verify` (internal quality execution)
   - install (`bun install --frozen-lockfile`)
   - lint (`bun run lint`)
   - typecheck (`bun run typecheck`)
   - test (`bun run test`)
   - build (`bun run build`)
2. `required-gate` (aggregator; **required check**)
   - `needs: [verify]`
   - fails if any needed gate fails/cancels
   - succeeds only when all mandatory steps pass

Permissions baseline (wave 1):

```yaml
permissions:
  contents: read
```

No write permissions for the required gate workflow.

## No-deadlock skipped-check policy

Policy objective: required check must always resolve to success/failure (never permanently missing/skipped).

Rules:

1. Required workflow cannot use PR path filters.
2. Required check must be produced by a dedicated aggregator job that always schedules.
3. If conditional execution is ever introduced internally, fallback paths must still conclude `required-gate` explicitly.
4. Path-filtered workflows are never configured as required checks.
5. If workflow is temporarily disabled/renamed, branch protection must be updated in same change window to avoid hard merge lock.

## Auditor pass/fail definition (for implementation bead review)

### Pass when all are true

1. `.github/workflows/ci-required-pr-gate.yml` exists and is valid YAML.
2. It triggers on PRs to `main/master` without `paths` filters.
3. It includes mandatory commands for install/lint/typecheck/test/build (directly or via equivalent wrapper script).
4. It contains a stable required aggregator job with:
   - id `required-gate`
   - name `ci-required-gate`
   - deterministic success/failure based on prerequisite jobs.
5. Existing informational workflows remain non-required in documented policy.
6. Branch-protection recommendation references `ci-required-gate` as sole required status for this wave.

### Fail if any are true

1. Required workflow uses path filters causing possible skipped required checks.
2. Required check name is unstable (matrix-dependent/dynamic).
3. Required workflow grants write permissions without explicit justification.
4. Mandatory quality stage (install/lint/typecheck/test/build) is omitted without approved replacement.
5. Branch protection is documented to require a path-filtered or optional workflow.

## Implementation handoff notes for Engineer

- Introduce the new workflow without deleting existing workflows in this wave.
- Keep required check naming exactly as specified.
- Ensure CI failure signal is simple: red `ci-required-gate` blocks merge.
- Defer further hardening (action SHA pinning, docs automation permission redesign, vuln/dependency policy) to sibling beads:
  - `redemeine-1uh.4`
  - `redemeine-1uh.2`
  - `redemeine-1uh.5`

## Out-of-scope for this bead

- Full CI hardening migration or workflow rewrites
- Dependabot/Renovate and vulnerability threshold policy
- CODEOWNERS/SECURITY.md governance rollout
- Release attestation/SBOM enforcement details

