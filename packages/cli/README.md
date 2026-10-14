# @redemeine/cli

Standalone ESM executable `redemeine` and side-effect-free typed API
`@redemeine/cli/reflector` for Node.js 22 or newer. Publication is approved under
`redemeine-ov0e.4`, but the package is unpublished at that preparation stage.
The registry commands below apply only **after publication is verified**.

```sh
npm install -D @redemeine/cli typescript vitest @types/node
npm install @redemeine/aggregate @redemeine/kernel zod@^4
npx --package=@redemeine/cli redemeine help
```

Before publication, build and pack this workspace package, install its local
tarball together with the scoped runtime tarballs, then use the installed bin.
The repository's `pnpm --filter @redemeine/cli test:packed` exercises that route.
First build the packages with `pnpm --filter @redemeine/kernel --filter @redemeine/aggregate --filter @redemeine/projection --filter @redemeine/cli build`.
The packed test prints its retained `<os-temp>/opencode/standalone-cli-vk7d-*` directory,
including tarballs, inventories and the isolated runnable consumer. It uses local
scoped tarballs and pinned external dependencies, never a registry CLI executable.

```sh
redemeine init orders --no-install
redemeine add-entity line --to orders --no-install
redemeine extract-schemas --entry src/domains/orders/aggregate.ts --export orders --out src/generated/orders.ts
redemeine extract-schemas --kind projection --entry src/projection.ts --export view --out src/generated/view.ts
redemeine extract-schemas --entry src/aggregate.ts --export aggregate --format json-schema --target draft-7 --out schemas/aggregate.json
redemeine extract-schemas --kind projection --entry src/projection.ts --export view --format json-schema --out schemas/view.json
redemeine extract-schema-registries --manifest schema-registry.json --out src/generated/schema-registries.ts
```

Run in an existing project with `package.json`. Init creates a typed command/event
example and Vitest tests under `src/domains/orders`, an absent shared
`src/test-utils.ts`, and an absent version-1 manifest. Existing files and scripts
are preserved. Names must be non-reserved lowerCamelCase identifiers. Symlinks
are refused; new files are created exclusively. Add-entity requires an existing
aggregate and only auto-mounts an exact, unmodified generated scaffold; custom
files receive a manual mount recipe. This is not a crash-transactional filesystem
operation. Non-TTY and `--no-install` runs never prompt or install; interactive
installation requires explicit consent and uses argv, not a shell.

Use Zod 4 and strict TypeScript. Generated tests explicitly import Vitest; adapt
those imports manually if your project uses Jest. Keep the builder export
`ordersAggregate` for composition and built export `orders` for discovery.
Compiler-only extraction does not execute application source.
Scaffold preflight checks dependency presence, not installed version ranges: it
prints the Zod 4 requirement but never silently upgrades an existing Zod 3 entry.
Upgrade incompatible project dependencies explicitly before compiling the scaffold.

`describeContract` accepts compatible independent Zod 4 installations (Zod's
trait-based instance check supports this); Zod 3 and non-Zod values are unsupported.
Command/event keys, including `__proto__`, are preserved as own data properties.
`generateSchemaFiles` prevalidates all requested filenames before creating output:
individual names cannot be empty, dot segments, paths, drive names, or contain
control characters. Duplicate destinations, symlinks and hard-linked existing
files are refused. `aggregateName` is metadata/prefix matching, not a filename.
Bundle-only generation still supports names unsuitable for individual files.
Validation is not a transaction or protection against concurrent filesystem changes.

Legacy `extractZodSchemas` reuses a recognized `z.infer` schema only through its
exported value: public dependency imports retain their module specifier, and local
source imports are relative to the generated file. Private/unroutable schema values
fail before output writes; export the value or supply `typeOverrides`. It never
emits dependency implementation paths. When TypeScript erases alias metadata,
the existing structural conversion applies; runtime refinements are not inferred.
Keep relative source/generated files together when relocating output, and compile
computed-key output with a modern target (ES2015 or newer).

## Standalone JSON Schema (compiler metadata)

`extract-schemas --format zod|json-schema` defaults to **zod**, retaining existing
schema names and output semantics. Projection Zod output still exports
`stateSchema` and `stateJsonSchema` in TypeScript; no new projection runtime is
introduced. JSON uses `--target draft-7|draft-2020-12`, default **draft-2020-12**.
`--target` with Zod is an error. Aggregate `--no-state` omits state; JSON rejects
`--date-handling date` (Date is represented as a string without invented format
constraints). Projection continues rejecting `--no-state` and `--date-handling`.
Programmatic extraction options accept the same format/target; JSON rejects
code-string `typeOverrides` rather than evaluating them.

Aggregate JSON is `{ "commands": { shortKey: schema }, "events": { shortKey:
schema }, "state": schema }` (state optional). This bundle is **not itself one
validating JSON Schema** and is not a legacy registry. Each object schema root
identifies its `$schema` dialect; boolean schemas cannot carry that annotation.
Projection JSON is the direct business-state schema document. Keys are sorted
deterministically; command/event keys are compiler handler keys, not wire names
inferred by executing naming strategies.

Conversion reads TypeScript semantic types only. It never imports application or
schema values and never evaluates generated Zod strings. Supported aggregate
shapes include primitive/literal/enum unions, nullable/optional fields, arrays and
readonly arrays, string-index records, public data objects/classes and resolved
structural intersections (including Pick/Omit/Partial). Constructors are not run;
methods, accessors and non-public instance fields are unsupported. Underscore
fields are retained. Tuples, functions, symbols, bigint, unresolved/error types,
unproven implicit any, unsupported/conflicting intersections, recursion and depth
over 60 fail with export/property paths before output directories/files are written.
Projection retains its stricter existing policy, including rejection of
any/unknown, intersections, classes, empty objects and undefined outside optional
property boundaries. Existing destination bytes survive conversion failure.

Aggregate declaration-proven **any/unknown** becomes boolean `true`, with a
path-qualified diagnostic: this describes all **JSON values**, not every JavaScript
value. If the compiler erases the annotation provenance, conversion fails rather
than guessing. No unresolved type or depth cutoff becomes `true`.
Aggregate **void/undefined/never** becomes boolean `false`: no JSON value inhabits
that type. It does **not** mean `{}`, `null`, an omitted command, or permission to
change domain payloads. Optional fields are omitted from `required`; undefined is
not converted to null. Required undefined-only fields remain required with `false`.

These artifacts are structural **documentation**, not active transport validators.
For the unchanged PaymentAttempt author aggregate, confirm/expire processor
payloads infer void, so their JSON entries are `false` even though the public
methods send `{}` and the existing handwritten validator accepts those objects.
TypeScript does not recover integer/minItems/strict additionalProperties policies,
custom legacy refs, or runtime Zod refinements. Objects stay structurally open
unless index constraints apply; statically resolved `z.infer` is structural only.
No equivalence to handwritten schemas or Zod output is promised. The legacy
aggregate Zod converter is unchanged: its intersection/depth/any fallbacks and
underscore omission remain fidelity limits; generating JSON does not fix or use
those fallbacks.

Before CLI publication, consumers can invoke the qualified developer package
directly (record its exact version **and artifact hash**, including same-version
rebuilds). No launcher, download fallback or runtime CLI dependency is required:

```sh
node "${REDEMEINE_CLI_DIR:?set qualified CLI path}/dist/bin.js" extract-schemas --entry src/aggregate.ts --export PaymentAttemptAggregate --tsconfig tsconfig.json --format zod --out schemas/generated/zod.ts
node "${REDEMEINE_CLI_DIR:?set qualified CLI path}/dist/bin.js" extract-schemas --entry src/aggregate.ts --export PaymentAttemptAggregate --tsconfig tsconfig.json --format json-schema --target draft-7 --out src/schemas/generated/json.json
```

The historical CLI hold is removed following user approval; the normal reviewed
main/version/workflow and npm-owner gates still apply. Earlier same-version
developer artifacts remain historical/local evidence, not final release files.
See [releasing packages](https://github.com/surikaterna/redemeine/blob/main/docs/releasing.md)
for the five-package batch and future first-name owner handoff. Source workspace `npm pack` preserves
`workspace:*`; use real `pnpm pack` registry-layout artifacts for the packed gate
(the existing interop qualification `cli-packed.mjs` prepares that disposable
layout). The JSON packed test installs Ajv only in its isolated consumer fixture
to validate both dialects; no CLI dependency or repository lock change is needed.

```ts
import { extractSchemaRegistries, describeContract } from '@redemeine/cli/reflector';
```

The API also exports `generateSchemaFiles`, `extractZodSchemas`,
`extractProjectionSchemas` and their option types. TypeScript and Zod are runtime
dependencies; kernel supplies the public `Contract` declaration. No private-root
runtime import or external template asset is required.

See [the domain workflow recipe](https://github.com/surikaterna/redemeine/blob/main/docs/recipes/cli-domain-workflow.md)
for scripts, manifest discovery, boundaries and regeneration guidance.
