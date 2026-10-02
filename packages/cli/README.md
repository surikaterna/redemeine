# @redemeine/cli

Standalone ESM executable `redemeine` and side-effect-free typed API
`@redemeine/cli/reflector` for Node.js 22 or newer. This package is being prepared for publication;
the commands below using the registry apply **after publication**, not today.

```sh
npm install -D @redemeine/cli typescript vitest @types/node
npm install @redemeine/aggregate @redemeine/kernel zod@^4
npx --package=@redemeine/cli redemeine help
```

Before publication, build and pack this workspace package, install its local
tarball together with the scoped runtime tarballs, then use the installed bin.
The repository's `pnpm --filter @redemeine/cli test:packed` exercises that route.
First build the packages with `pnpm --filter @redemeine/kernel --filter @redemeine/aggregate --filter @redemeine/projection --filter @redemeine/cli build`.
The packed test prints its retained `/tmp/opencode/standalone-cli-vk7d-*` directory,
including tarballs, inventories and the isolated runnable consumer. It uses local
scoped tarballs and pinned external dependencies, never a registry CLI executable.

```sh
redemeine init orders --no-install
redemeine add-entity line --to orders --no-install
redemeine extract-schemas --entry src/domains/orders/aggregate.ts --export orders --out src/generated/orders.ts
redemeine extract-schemas --kind projection --entry src/projection.ts --export view --out src/generated/view.ts
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

```ts
import { extractSchemaRegistries, describeContract } from '@redemeine/cli/reflector';
```

The API also exports `generateSchemaFiles`, `extractZodSchemas`,
`extractProjectionSchemas` and their option types. TypeScript and Zod are runtime
dependencies; kernel supplies the public `Contract` declaration. No private-root
runtime import or external template asset is required.

See [the domain workflow recipe](https://github.com/surikaterna/redemeine/blob/main/docs/recipes/cli-domain-workflow.md)
for scripts, manifest discovery, boundaries and regeneration guidance.
