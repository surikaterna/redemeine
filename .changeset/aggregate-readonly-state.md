---
'@redemeine/aggregate': major
'@redemeine/mirage': major
'@redemeine/saga-runtime': major
'@redemeine/projection': patch
---

BREAKING: expose coherent readonly aggregate state views for initial templates,
commands, selectors, preparation and immutable application results, while keeping
the original model for writable Immer drafts. Event-plugin mounting now uses
Immer structural sharing and default auto-freeze instead of a writable shallow
copy. Callers relinquish mutation rights to shared template data from creation;
they must not assign readonly results to mutable model variables or mutate aliases.

Mirage and Projection recover the original model marker for snapshot and reducer
inference (with an initialState fallback for structural sources). Mirage public
state views preserve callable Date readers without exposing setters. The Saga
execution bridge now honestly exposes/stores readonly aggregate results; persistence
callbacks must accept readonly views rather than assuming mutable model ownership.

Keep replacement event-map generics scoped in inferred downstream declarations,
fixing a pre-existing free `NewE` reference in Saga Runtime's generated public API.
