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

## Package schema policy

Schema extraction reads the closest owning `package.json` for each selected entry,
not the shell's working directory. A nested package does not inherit another
package's policy implicitly. Aggregate, projection and registry entry points use
the same configuration:

```json
{
  "redemeine": {
    "schemas": {
      "mode": "zod-first",
      "maxDepth": 60
    }
  }
}
```

Those are the defaults when settings are absent. `mode` accepts `zod-first` or
`types-first`. `maxDepth` is an integer from 1 to 256; invalid values and unknown
schema options fail before generation. Root conversion starts at depth zero;
properties, arrays and composite conversions consume structural depth, not just
visible object nesting. Recursive expansion is diagnosed separately. Neither
case silently becomes `z.any()`. Imported authored schemas are referenced rather
than expanded, so their internal validation is not truncated by this limit.

**Zod-first:** each selected command payload, event payload and included state must
resolve to an existing importable Zod schema. Generated maps import the originals;
their refinements/defaults/transform behavior are not reconstructed from types.
Missing schemas or inaccessible exports fail schema compilation, not aggregate
runtime construction. This tooling change does not add a schema-accepting overload
to `createAggregate` or alter application runtime validation.

**Types-first:** existing resolvable Zod schemas still take precedence over
structural inference, including nested fields. Ordinary types can coexist for a
gradual migration. Intentional code-string `typeOverrides` remain an explicit
types-first escape hatch; they are rejected in Zod-first mode. Existing types-only
projects (including the current scaffold templates) must opt in to this mode.

Use exported schemas and explicit schema-derived annotations, for example:

```ts
export const identifierSchema = z.string().min(3);
export type Identifier = z.infer<typeof identifierSchema>;
// A handler parameter annotated Identifier links identifierSchema, not z.string().
```

The compiler follows retained aliases and original handler/event/state annotations
when available, including primitive aliases that TypeScript otherwise erases. It
does not guess by schema name or associate every `string` with the same schema.
Ambiguous/erased provenance cannot establish an authored-schema guarantee: provide
an explicit schema-derived annotation instead. An ordinary type-only declaration
with no recoverable link is inferred only in types-first mode.

For genuine Aggregate declarations, state means the canonical model retained by
`__stateType`, not the borrowed readonly `initialState` view (in particular, a
readonly Date facade is not treated as a Date model). Markerless legacy contracts
still use `initialState`; an unresolvable or noncanonical marker fails closed.
An authored creator-state schema is reused only when it covers the complete model.
Plugin-mounted namespaces are part of that model, even when their fields are
optional: a base-only schema cannot validate the whole aggregate state. Supply an
explicit whole-model schema rather than allowing extraction to omit that state.

Generic wrappers containing schema-derived arguments (for example,
`Box<z.infer<typeof identifier>>`) require an explicit exported derived Zod schema;
extraction fails before writing rather than silently losing the argument's
refinements. Ordinary types-first wrappers such as `Box<string>` remain supported.
Record keys and values are linked separately, including authored string-key
constraints. Readonly arrays and nullable tuple aliases retain element-level
annotations; a neighboring plain string does not inherit a schema's refinements.

`extractZodSchemas` reuses a recognized `z.infer` schema only through its
exported value: public dependency imports retain their module specifier, and local
source imports are relative to the generated file. Private/unroutable schema values
fail before output writes; export the value or supply a types-first override. A
schema module export/re-export is sufficient; it need not be in the domain root
barrel. External imports must respect package exports even for Node10 input
projects. The referenced value must have a resolved Zod schema type; no dependency
implementation path or fake ambient declaration is emitted.
Keep relative source/generated files together when relocating output, and compile
computed-key output with a modern target (ES2015 or newer).

### Readable aggregate Zod output

Object intersections such as `Job & { cancelJobIds: string[] }`, including resolved
`Pick`/`Omit`/`Partial` combinations, produce structural object schemas. TypeScript's
resolved property types and optionality preserve overlapping constraints rather
than treating the right-hand member as an overwrite. Contradictory properties
remain impossible (`z.never()`); they do not become `z.any()`.

String-index records and supported mutable-array intersections use
`z.intersection(...)`. Recognized imported Zod member schemas and explicit
`typeOverrides` also remain referenced through intersections, preserving their
authored constraints. Callable, branded primitive/object, mixed array/object,
numeric-index and Date intersections are not silently widened: they fail
with the type name before output is written. Supply a schema override where the
intended validation cannot be represented by the supported structural conversion.

Schema-derived unions/intersections retain their original annotated members even
when TypeScript normalizes them (for example, `Identifier & string`). A plain
`string` alternative in `Identifier | string` remains unrestricted. Generic
compositions whose original members cannot be resolved require an explicitly
derived Zod schema rather than silently losing refinements. Projection/registry
conversion likewise requires an explicit derived schema for these compositions;
its stricter structural policy is not relaxed by the aggregate converter.

Generated TypeScript is formatted by the CLI, with dependency-before-use schema
ordering, separate schema/map sections, safe normal property names, and computed
`__proto__` keys. It includes source-relative entry/export provenance and concise
source JSDoc (whitespace-normalized, escaped and capped at 400 characters), not
invented domain descriptions. No timestamp or absolute machine path is emitted.
Repeated generation with the same inputs/tool version is deterministic. An
application formatter remains optional for its own style conventions.

The public exports remain `commandSchemas`, `eventSchemas`, and optional
`stateSchema`; map keys are handler property names. Inferred void payloads remain
`z.void()`. Aggregate types-first conversion supports readonly arrays and resolved
tuples with optional/trailing-rest elements; `unknown` stays `z.unknown()` and
explicit declaration-proven `any` stays `z.any()`. Public data fields are retained,
including underscores. Unsupported functions, Maps/Sets, numeric-index records,
open template literals, bigint/symbol types, unresolved declarations and recursion
fail rather than becoming permissive or unrelated object schemas. Supplied schemas
can describe cases structural conversion cannot. Projection/registry structural
conversion retains its stricter supported-type policy; authored schema references
take precedence there too. Structural inference requires strictNullChecks (or
strict) and does not replace handwritten runtime validation automatically.

## Standalone JSON Schema (compiler metadata)

Raw `--format json-schema` is a compiler-only **types-first** path. Zod-first mode,
or a recognized authored schema anywhere in a types-first payload, refuses this
path instead of dropping constraints or silently executing application code.
Generate linked Zod/registry modules and evaluate `z.toJSONSchema` on the actual
schemas in an explicit build step instead. Projection/registry TypeScript outputs
already expose JSON maps through `z.toJSONSchema`; evaluating them imports your
schema modules normally. Put schemas in dedicated modules if those modules must
not execute application setup. Unrepresentable Zod behavior is reported by Zod,
not converted into a weaker structural JSON schema.

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
over the configured maxDepth fail with export/property paths before output directories/files are written.
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
unless index constraints apply. Recognized authored Zod schemas are refused in
this structural JSON path rather than reinterpreted. No equivalence to handwritten
schemas or Zod output is promised. Conversion never evaluates emitted schema code.

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
