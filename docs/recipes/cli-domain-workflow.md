# CLI domain workflow

The standalone `@redemeine/cli` package is **not yet published**. Before publication,
use locally built tarballs (including aggregate and kernel) rather than assuming
registry availability. The repository verifies the blueprint with
`pnpm --filter @redemeine/cli test:packed` outside the workspace.
Use Node.js 22 or newer. To reproduce the current local blueprint from this repository:

```sh
pnpm --filter @redemeine/kernel --filter @redemeine/aggregate --filter @redemeine/projection --filter @redemeine/cli build
pnpm --filter @redemeine/cli test:packed
```

The harness prints its retained `/tmp/opencode/standalone-cli-vk7d-*` directory.
It contains dry-run inventories, local scoped tarballs and a consumer installed
with pinned TypeScript, Zod and Vitest, without workspace links. From that
consumer directory, `./node_modules/.bin/redemeine help` uses the installed CLI.
Its package.json uses local tarball dependencies and a kernel override so scoped
prerelease dependencies do not require registry availability.

## Existing-project setup

After publication, install locally so scripts use a pinned lockfile version:

```sh
npm install @redemeine/aggregate @redemeine/kernel zod@^4
npm install -D @redemeine/cli typescript vitest @types/node
```

Future, after-publication one-shot help:

```sh
npx --package=@redemeine/cli redemeine help
```

Use strict TypeScript with `moduleResolution: "Bundler"`, `module: "ESNext"`,
`target: "ES2022"`, and `lib: ["ES2022", "ESNext.Disposable"]` for the Vitest
tooling declarations. The packed test also enables `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, and checks dependency declarations without skipLibCheck.

```sh
npx --no-install redemeine init orders --no-install
npx --no-install redemeine add-entity line --to orders --no-install
npx --no-install redemeine add-entity note --to orders --no-install
```

Init is not a project generator or an add-domain command. It creates:

```text
src/domains/orders/
  contract.ts
  selectors.ts
  aggregate.ts
  aggregate.spec.ts
  entities/
  mixins/
src/test-utils.ts          # only if absent
schema-registry.json      # only if absent
```

The contract owns the initial state, Zod schema and inferred payload type;
selectors own typed read-only queries. Aggregate handlers accept an `accept`
command, validate it, emit `accepted`, and apply the event immutably. The generated
Vitest suite proves positive command/apply behavior and invalid-payload rejection.
Entities isolate nested state and commands; mixins remain a place for manually
authored reusable behavior. No projection is scaffolded. Keep `ordersAggregate`
(builder) for composition and `orders` (built definition) for extraction.

Add-entity emits a built entity and mounts it only when aggregate.ts exactly
matches the generated scaffold, including previous generated mounts. Otherwise
the aggregate is byte-preserved and the CLI prints a manual import/mount recipe.
Review custom state initialization and entity collection lifecycle separately.
Existing shared helpers, manifests and package scripts are never rewritten.
Names and `--to` must be non-reserved lowerCamelCase identifiers; paths through
symlinks and collisions are refused. Creates are exclusive, not whole-tree
crash transactions. `--no-install` and noninteractive runs never install or prompt;
interactive install needs consent and uses fixed argv without a shell. For Jest,
adapt the generated explicit Vitest imports rather than relying on hidden globals.

## Schema lifecycle

An absent root manifest is initialized as:

```json
{
  "version": 1,
  "tsconfig": "./tsconfig.json",
  "discover": [{ "kind": "aggregate", "entry": "./src/domains/orders/aggregate.ts" }]
}
```

Discovery selects built exports and ignores builders. Add another domain's entry
manually; existing manifests are preserved and init prints the precise entry to add.
For a manually authored projection, its published declaration may widen `name`:

```json
{
  "kind": "projection",
  "entry": "./src/projection.ts",
  "exclude": ["experimentalView"],
  "names": { "view": "ordersView" }
}
```

All eligible exports in a discovery entry are selected unless excluded. Exclude
and names keys must identify actual exports; duplicate/ambiguous aliases fail
before writes. Explicit `definitions` entries support individual export/name
selection. Provenance comes from compiler declarations, not shape-only lookalikes.
Unsupported state/payload types fail rather than silently producing permissive
registry schemas. Zod 4 materializes JSON Schema. The output contains
`aggregateSchemas`, `projectionSchemas`, `aggregateJsonSchemas`,
`projectionJsonSchemas`. See [registry reference](../schema-registry-generation.md)
and [projection extraction](../projection-schema-generation.md) for limits.

Add scripts manually, preserving your own build configuration:

```json
{
  "scripts": {
    "schema:generate": "redemeine extract-schema-registries --manifest schema-registry.json --out src/generated/schema-registries.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc",
    "test": "vitest run"
  }
}
```

Development blueprint: edit contracts/handlers, run `npm run schema:generate`,
`npm run typecheck`, `npm test`, then your build. Commit generated artifacts if
your project tracks them. A freshness gate regenerates and runs
`git diff --exit-code -- src/generated/schema-registries.ts`; no invented
`--check` extraction flag exists. Schema tooling never executes your application
source and is separate from runtime validation/transport/worker configuration.

Single-definition alternatives:

```sh
npx --no-install redemeine extract-schemas --entry src/domains/orders/aggregate.ts --export orders --tsconfig tsconfig.json --out src/generated/orders.ts
npx --no-install redemeine extract-schemas --kind projection --entry src/projection.ts --export view --tsconfig tsconfig.json --out src/generated/view.ts
```

The compiled, side-effect-free API is available to tooling:

```ts
import { extractSchemaRegistries } from '@redemeine/cli/reflector';
```

Root source reflector imports remain compatibility shims only; consumers should
never import private repository source or require tsx to execute the packed CLI.
