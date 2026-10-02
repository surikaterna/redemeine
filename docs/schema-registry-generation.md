# Schema registry generation

Generate a single build-time TypeScript module containing aggregate and projection
schema Maps. Extraction uses the TypeScript compiler, never imports or executes
your definitions, and requires `strictNullChecks: true` (or `strict: true`). The
generated module requires **Zod 4**. This tooling does not change runtime contracts.

## Manifest and CLI

Create a JSON-only manifest (no executable configuration):

```json
{
  "version": 1,
  "tsconfig": "./tsconfig.json",
  "definitions": [
    { "kind": "aggregate", "entry": "./src/orders.ts", "export": "orders" },
    { "kind": "aggregate", "entry": "./src/counter.ts", "export": "default" },
    { "kind": "projection", "entry": "./src/views.ts", "export": "ordersView", "name": "orders-view" }
  ]
}
```

```sh
pnpm exec redemeine extract-schema-registries --manifest ./schemas.json --out ./generated/schemas.ts
```

Only `--manifest` and `--out` are accepted; unknown, duplicate and positional
options are errors. `tsconfig` and each `entry` resolve relative to the manifest
directory, even from another working directory. Output resolves relative to the
current working directory. Unknown JSON fields and versions are rejected.
Select explicit exports, including default exports and barrel reexport aliases,
or discover exported built definitions from specified entry modules below.
There is no directory crawling or handler-shape inference.

## API

```ts
import { extractSchemaRegistries } from 'redemeine/reflector';

extractSchemaRegistries({
  tsconfig: './tsconfig.json',
  outFile: './generated/schemas.ts',
  definitions: [
    { kind: 'aggregate', entry: './src/orders.ts', export: 'orders' },
    { kind: 'projection', entry: './src/views.ts', export: 'ordersView', name: 'orders-view' },
  ],
});
```

API paths resolve against cwd. `ExtractSchemaRegistriesOptions` and
`SchemaRegistrySelection` and `SchemaRegistryDiscovery` are exported alongside the function.

## Discover all / all except

`definitions` and `discover` are optional individually; at least one **own** field
must be present and every present field must be an array. Empty arrays are valid.
Existing explicit-only version 1 manifests retain their behavior.

```json
{
  "version": 1,
  "tsconfig": "./tsconfig.json",
  "discover": [
    { "kind": "aggregate", "entry": "./src/aggregates.ts", "exclude": ["experimental"] },
    { "kind": "projection", "entry": "./src/views.ts", "names": { "ordersView": "orders-view" } }
  ]
}
```

The same `discover` array works in `extractSchemaRegistries({ tsconfig, outFile,
discover })`, optionally combined with `definitions`. Discovery entry paths follow
the same manifest-relative/API-cwd rules as explicit entries. `exclude` and `names`
keys are exact **entry-module export names**, including `default` and barrel aliases,
not runtime registry names. Every exclusion must refer to an eligible requested-kind
definition; stale, missing, unrelated, opposite-kind and type-only exports are errors.
Every mapping must target an eligible **nonexcluded** export. Duplicate exclusions,
unknown fields, symbols and accessors are rejected without invoking getters.

Eligibility precedes conversion: deliberately excluding a recognized unsupported
built definition skips its contract/schema validation. Otherwise malformed built
contracts and unsupported states/payloads fail the entire batch, never silently vanish.
Unrelated values, types/type-only reexports, schemas, helpers and unbuilt builders
are ignored. Discovery filters by kind, so ordinary opposite-kind exports are ignored.

### Package evidence and structural limits

Discovery requires resolved declarations rooted in the genuine `@redemeine/aggregate`,
`@redemeine/projection` or `@redemeine/projection-runtime-core` package plus the full
built contract. Both workspace sources and installed declarations are supported.
Named `BuiltAggregate`, ordinary/commit `ProjectionDefinition` contracts and the
anonymous `AggregateBuilder.build()` return-member declarations provide evidence;
resolved build signatures also retain evidence through direct casts/parentheses.
Required functions, containers and nested members are checked, not just
`name`/`initialState`/`aggregateType` presence. Optional runtime hooks/join streams
are not required. Public/runtime ordinary, commit-native and mirror builds are supported.

Creator functions must return message contracts, and event creators must cover the
corresponding event projectors with compatible payloads. The genuine
`EventEmitterFactory` declaration can intentionally erase inferred payloads to
`unknown`; that canonical fallback is supported, unlike a locally fabricated
unknown-returning creator. Projection stream/subscription
aggregates must retain genuine aggregate-contract evidence: a locally fabricated
`{ aggregateType: 'fake' }` reference is not enough. When canonical public/runtime
projection declarations erase a source aggregate to their narrower reference contract,
that genuine declared reference is supported; retained full built aggregates are
validated against their full contract. This is still static evidence, not runtime proof.

Reference evidence preserves the actual canonical contract, not just the ancestry
of `aggregateType`. `AggregateDefinition` requires `initialState` and
`pure.eventProjectors`; `Pick`/`Omit` views dropping these members are rejected.
A public `ProjectionAggregateSource` requires `pure.eventProjectors` but not
`initialState`. Public erased primary references and genuine join/subscription
references may require only `aggregateType`. A **runtime primary** `fromStream`
always requires `initialState` plus `pure.eventProjectors`, even if a reference was
borrowed from a narrow public or join contract. Narrow join/subscription contexts
remain supported. This context check also applies to freshly emitted declarations.

TypeScript is structural, **not a proof of runtime construction**. An explicitly
annotated canonical contract or deliberate compatible cast can qualify, even if
the runtime object was forged. Conversely opaque computations or wrappers with
erased package evidence are outside automatic discovery; use explicit `definitions`
as the escape hatch. A recognizable direct build erased to unknown is an error,
not an unrelated value. No source imports, execution or runtime name evaluation occur.

### Alias and naming rules

Compiler import/export aliases, default exports of identifiers and immutable `const`
identifier aliases (up to 64 links, with cycle guards) share canonical object identity.
Discovery deduplicates these routes, including explicit/discovery overlaps. For a
widened identity **one compatible explicit name per canonical alias group** suffices,
from any mapped nonexcluded alias or explicit selection. All supplied names must
agree, and every known literal must agree too. Explicit selections remain included
when a discovered alias is excluded. Excluding one alias removes only that route:
sibling aliases/defaults/reexports still include the object.

Canonical identity also requires **compatible schema views** to deduplicate. An
annotated alias can widen or narrow state/payloads even while referring to the same
object. Every included route in a shared group must produce the same faithful,
normalized state/command/event schemas. Separately declared equivalent types and
reordered object properties are accepted; checker Type identity is not required.
Differing normalized views are consistently rejected before any output writes,
including explicit/discovery overlaps, rather than choosing the first input route.
Exclude the other discovery routes or use one explicit selection to choose a view.

Multiple explicit selections retain the old duplicate error, even with discovery.
Distinct calls, copies/spreads, mutable aliases and opaque expressions are **not**
deduplicated by type equality, matching schemas or runtime name. Mutable/opaque
values may qualify if package type evidence remains, but no shared object identity
is guessed. Distinct definitions colliding on a runtime name fail within a kind;
cross-kind identical names are allowed. Input reordering does not change output bytes.

## Identities and typing

Keys are aggregate `aggregateType` or projection `name`, **not export variables**.
Without an explicit `name`, the compiler must resolve one nonempty string literal.
Widened strings, dynamic names and literal unions require explicit mapping.
Explicit names must match known literals. For widened names the supplied mapping
is authoritative: the caller must ensure it agrees with runtime identity, since
the generator cannot prove this without executing source. Prefer explicit names
for projections, whose built name commonly widens to `string`.

Duplicate names within one kind are errors (including explicit-only aliases).
The same name may exist in both kinds. An empty definitions array produces four
empty, explicitly typed Maps. Names and handler/property keys are escaped safely;
entries and keys are sorted in code-unit order, independent of manifest ordering.

The heterogeneous Maps have **broad value typing**, not key-specific inference:
`get(string)` returns a broad `z.ZodType`/bundle or `undefined`. Parsing does not
infer a different business-state type per registry key. Aggregate bundles use
named types and `Record<string, z.ZodType>` for handlers. JSON types derive from
the return of `z.toJSONSchema` through a single-schema wrapper (Zod's overloaded
registry conversion has a different return type).

## Four exports and handler keys

| Export | Value per name |
| --- | --- |
| `aggregateSchemas` | `{ state: ZodType, commands: { handler: ZodType }, events: { handler: ZodType } }` |
| `projectionSchemas` | business-state `ZodType` only |
| `aggregateJsonSchemas` | `{ state: JSONSchema, commands: { handler: JSONSchema }, events: { handler: JSONSchema } }` |
| `projectionJsonSchemas` | business-state JSON Schema only |

**Both batch Maps use the same unqualified handler keys**, not qualified message
names. Existing single-aggregate schemas and Contract JSON behavior are unchanged:
Contract JSON keys remain qualified, such as `orders.register.command` and
`orders.registered.event`. These batch schemas describe **payloads**, not envelopes.

```ts
import { aggregateSchemas, aggregateJsonSchemas, projectionSchemas, projectionJsonSchemas } from './generated/schemas';

aggregateSchemas.get('orders')?.commands.register?.parse(payload);
aggregateSchemas.get('orders')?.events.registered?.parse(eventPayload);
const commandJson = aggregateJsonSchemas.get('orders')?.commands.register;
projectionSchemas.get('orders-view')?.parse(document);
const viewJson = projectionJsonSchemas.get('orders-view');
```

JSON Maps derive from the **same Zod entries** via `z.toJSONSchema` when consumers
import the generated module. This is not raw `.json` emission. To export raw JSON,
serialize a selected JSON Map value in your own build script.

## Faithful conversion and failure safety

Aggregate state uses the resolved `initialState` value type; commands use creator
return `payload`; events use the projector's second parameter `payload`. Every
handler must have one non-generic resolved signature and a required payload path.
Legitimately empty handler dictionaries are allowed. **Undefined/void/any payloads
are rejected**, including legacy no-payload handlers: they are never silently
omitted or replaced with `z.any()`.

Projections use only the resolved `initialState` factory return type. Handler
mutations and storage metadata never add fields. Both kinds share the strict
projection converter, structurally inlining aliases without source schema imports.
Supported types include primitives/literals, optional/nullable nested properties,
arrays/readonly arrays, pure string-index records, finite mapped records and
discriminated unions. Quoted/escaped and underscore business keys (including
`__@business`) are preserved. **Date is represented as a string**, not a Date object.

Unsupported types fail with selection/type-path diagnostics: unresolved/unknown/
any, undefined outside optional properties, functions, generic/ambiguous handlers,
classes other than Date, tuples, intersections, symbol/numeric indexes and symbol
properties, mixed indexed objects, cycles/excessive depth, empty ambiguous object
contracts, and `__proto__` business-state properties (Zod omits them for safety).
Conversion of the entire batch finishes before destination creation or overwrite;
a malformed final selection leaves missing or preexisting output untouched.

For single-definition projection tooling see [projection schema generation](./projection-schema-generation.md).
