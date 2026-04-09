# Code Principles

These principles are mandatory for repository code changes.

## Principles

- **Correctness and type-safety first**: Prefer explicit, sound TypeScript types over speed of implementation.
- **Strong defaults, explicit exceptions**: Follow the default rules below; exceptions must be intentional and documented in PR notes.
- **Cohesive file responsibility**: Each file should own one clear responsibility and avoid mixed concerns.
- **Named export by default**: Do not use default exports in production source unless listed exceptions apply.
- **Type-heavy builder guidance**: Use narrow domain types, discriminated unions, and typed boundaries for builders/adapters.
- **File-size heuristic**: Keep production `.ts` source files at or below **350 lines**. Split when growth impacts clarity.
- **Barrel policy**: Use barrels only when they preserve clear boundaries and do not hide dependency direction.
- **Comments policy**: Prefer self-explanatory code; comments should explain intent, invariants, or non-obvious tradeoffs.
- **Testing is risk-based**: Add or update tests proportional to risk and blast radius.
- **CI enforcement**: Automated checks in lint are authoritative and must pass before merge.

## PR Checklist (required)

- [ ] Correctness/type-safety validated; no avoidable unsafe typing.
- [ ] Defaults followed; any exception is justified in PR notes.
- [ ] Files remain cohesive and responsibilities are clear.
- [ ] No default exports in production source (except approved exceptions).
- [ ] No explicit `any` in production source.
- [ ] No production source file exceeds 350 lines.
- [ ] Barrels (if used) preserve boundaries and dependency direction.
- [ ] Comments added only for intent/invariants/tradeoffs.
- [ ] Tests added/updated based on risk.
- [ ] `npm run lint` and `npm test` pass.
