---
"@redemeine/mirage": major
---

Make native Mirage version an event count: initial persisted baseline plus
successfully replayed tail plus successfully applied live events. Add setup-only
`initialVersion` (nonnegative safe integer, default zero, always BEFORE replay).
Depot propagates snapshot counts and supplies the PRE-APPEND persisted count to
`saveEvents.expectedVersion`, rather than a post-command value. Event-applied
hooks now observe the just-applied event's version; zero-event commands do not
increment it. Domain `version` properties remain unreserved.

Event counts cannot exceed `Number.MAX_SAFE_INTEGER`. The ceiling is a valid
baseline for empty replay/zero-event commands. Overflow throws `RangeError`
before applying or buffering the offending live event, preserving any successful
prefix. Hydration rejects before that event's hydration plugins or application;
no rounded-version instance is returned and prior plugin effects are not undone.

Breaking migration gate (redemeine-ov0e.7): retain authoritative store event counts,
but rebuild historical command-count/reset-to-zero checkpoints from full event
history or provide an operator-verified baseline. No arithmetic conversion or
automatic data migration is provided. Audit and qualify adapters for pre-append
comparison, inclusive 1-based snapshot-tail reads, and zero-based backend revision
translation before consumer cutover. State-only snapshots default to baseline 0.

Dispatch/save must remain serialized. This does not fix the existing concurrent
buffer-clearing race (redemeine-98zi). Partial application retains counted events;
command intents may not merge on failure. After-command hooks remain pre-apply;
after-commit failures do not roll back storage or restore cleared pending events.
This change is independent of standalone interop and introduces no shared runtime.
