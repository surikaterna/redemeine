---
"@redemeine/aggregate": minor
"@redemeine/demeine-interop": patch
"@redemeine/mirage": patch
---

Add opt-in command-to-event header propagation to Aggregate plugins, including header-only capability detection in bridge and Mirage hosts. Inherit detached prepared command headers only when the event has no own headers property; explicit empty or undefined headers remain unchanged.
