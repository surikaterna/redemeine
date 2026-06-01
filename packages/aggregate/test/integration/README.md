# Integration Tests

These tests depend on `@redemeine/mirage` and test aggregate + mirage together.

They are separated from unit tests because mirage depends on aggregate,
creating a circular dev-dependency concern.

To run only unit tests (no mirage dependency):
```bash
bun test ./test/*.test.ts
```

To run integration tests:
```bash
bun test ./test/integration/
```
