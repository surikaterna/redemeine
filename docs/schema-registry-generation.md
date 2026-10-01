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
Select explicit exports, including default exports and barrel reexport aliases;
there is no directory discovery or handler-shape inference.

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
`SchemaRegistrySelection` are exported alongside the function.

## Identities and typing

Keys are aggregate `aggregateType` or projection `name`, **not export variables**.
Without an explicit `name`, the compiler must resolve one nonempty string literal.
Widened strings, dynamic names and literal unions require explicit mapping.
Explicit names must match known literals. For widened names the supplied mapping
is authoritative: the caller must ensure it agrees with runtime identity, since
the generator cannot prove this without executing source. Prefer explicit names
for projections, whose built name commonly widens to `string`.

Duplicate names within one kind are errors (including aliases of one definition).
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
