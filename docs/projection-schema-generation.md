# Projection business-state schemas

Generate schemas from an exported **built** projection's resolved `initialState`
factory return type, without executing the projection:

```sh
pnpm exec redemeine extract-schemas --kind projection \
  --tsconfig tsconfig.json --entry src/projections/orders.ts \
  --export ordersProjection --out src/generated/orders.schemas.ts
```

The programmatic API is `extractProjectionSchemas({ tsconfig, entry,
projectionExport, outFile })`, exported from the reflector entry point. Omitted
`--kind` still selects the existing aggregate extractor. Projection mode rejects
`--no-state` and `--date-handling`.

The generated **TypeScript module requires Zod 4** and exports:

```ts
import { z } from 'zod';
export const stateSchema = z.object({ /* business fields */ });
export const stateJsonSchema = z.toJSONSchema(stateSchema);
```

JSON Schema is materialized when you import the generated module. This command
does not write raw `.json` files. To export JSON separately in your own script:

```ts
import { writeFileSync } from 'node:fs';
import { stateJsonSchema } from './generated/orders.schemas';
writeFileSync('orders.schema.json', JSON.stringify(stateJsonSchema, null, 2));
```

Use `strictNullChecks: true` (or `strict: true`) in the extraction tsconfig.
Implicit factory types work, including primitive roots. For a larger allowed
contract, explicitly type the factory return or `createProjection<State>`; optional
fields omitted from the initializer are then included. Both public projection and
runtime-core built definitions, commit definitions, mirrors, and reexports work.
Handler mutations never infer fields; storage envelopes and adapter metadata are
not synthesized. Zod objects retain their standard unknown-key stripping behavior.

Supported shapes include primitive JSON values, nullable state, optional nested
objects, arrays/readonly arrays, pure string records, finite mapped records, and
object unions (including discriminated unions). Aliases are inlined structurally,
so differently instantiated generic aliases do not collide. Business keys,
including underscores and escaped names, are preserved. `Date` uses the existing
string representation: this validates serialized strings, not live Date objects,
and does not impose an ISO format.

Unsupported or lossy contracts fail **before any output is created/overwritten**,
with the export, type path, and a recommendation for an explicit JSON-compatible
return type. Rejected types include any/unknown/unresolved types, cycles or depth
over 60, functions, generic/overloaded state factories, class instances (except
Date), promises, intersections, tuples, symbol/numeric indexes, and mixed indexed
objects with named properties. Undefined is allowed only at an optional property
boundary; required undefined unions and undefined-only optional values fail.
The special `__proto__` key is rejected because Zod omits it for prototype safety;
ordinary single- and double-underscore business keys are preserved.
Empty object contracts (`{}` also admits non-null primitives in TypeScript) and
non-finite numeric literals are rejected rather than silently narrowed.
No fallback `z.any()` or type override escape hatch is provided. Builders and
aggregate initial-state values are not projection definitions.
