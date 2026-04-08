# redemeine-xvr performance note

- Canonical inspection emission introduced in this bead is implemented as **best-effort** and non-blocking from a domain-behavior perspective (publisher failures are swallowed by the adapter seam).
- Emission paths are synchronous for local publisher invocation but avoid changing aggregate/saga/projection functional outcomes.
- Project benchmark baseline policy remains the source of truth at `docs/architecture/testing-dx-v1-contracts.md` (section: **Benchmark baseline policy (v1)**), where benchmark gates are informational and non-blocking.
