import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function packedAggregateDeclarations(consumer, command) {
  packedStatelessRuntime(command);
  const directory = join(consumer, 'aggregate-declarations');
  mkdirSync(directory, { recursive: true });
  for (const extension of ['mts', 'cts']) {
    writeFileSync(join(directory, `input.${extension}`), `
      import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
      import type { AggregateStateModel, AggregateStateView } from '@redemeine/aggregate';
      const plugin = createAggregatePlugin('audit')
        .state((): { rows?: { at: Date; tags?: string[] }[] } => ({})).build();
      export const plain = createAggregate('plain', { count: 0 }).build();
      export const mounted = createAggregate('mounted', { count: 0 }).plugins(plugin).build();
      export const attached = createAggregate('attached', { count: 0 }).build().withPlugins(plugin);
      export const stateless = plain.withPlugins(createAggregatePlugin('transport')
        .commandEnvelope(() => ({ dateTime: new Date() }))
        .eventEnvelope((_, ctx) => ({ executionDateTime: ctx.command.dateTime.toISOString() })).build());
      const unchanged: AggregateStateModel<typeof stateless> = { count: 1 };
      const date: Date = stateless.prepareCommand(unchanged, { type: 'noop', payload: {} }).dateTime;
      // @ts-expect-error Stateless decoration does not add a namespace.
      stateless.initialState.transport;
      const model: AggregateStateModel<typeof mounted> = {
        count: 1, audit: { rows: [{ at: new Date(), tags: ['ok'] }] }
      };
      const view: AggregateStateView<typeof model> = mounted.initialState;
      const attachedView: typeof attached.initialState = view;
      attachedView.audit.rows?.[0]?.at.getTime();
      // @ts-expect-error Public state views are readonly.
      view.count = 2;
      // @ts-expect-error Public Date views exclude mutation.
      view.audit.rows?.[0]?.at.setTime(0);
      // @ts-expect-error Mounted namespaces cannot be omitted.
      const missing: AggregateStateModel<typeof mounted> = { count: 1 };
    `);
  }
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    types: ['node'], declaration: true, emitDeclarationOnly: true, outDir: './dist'
  }, include: ['input.mts', 'input.cts'] }));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'aggregate-declarations/tsconfig.json']));
  for (const extension of ['mts', 'cts']) {
    const declaration = readFileSync(join(directory, `dist/input.d.${extension}`), 'utf8');
    for (const name of ['plain', 'mounted', 'attached', 'stateless']) assert(declaration.includes(`const ${name}:`));
  }
  console.log(command('npx', ['--no-install', 'tsc', '--strict', '--skipLibCheck', 'false', '--noEmit',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node',
    'aggregate-declarations/dist/input.d.mts', 'aggregate-declarations/dist/input.d.cts']));
}

function packedStatelessRuntime(command) {
  console.log(command('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    for (const api of [await import('@redemeine/aggregate'), createRequire(import.meta.url)('@redemeine/aggregate')]) {
      const plain = api.createAggregate('plain', { count: 0 }).build();
      const plugin = api.createAggregatePlugin('transport').commandEnvelope(() => ({ dateTime: new Date(0) })).build();
      const built = plain.withPlugins(plugin);
      assert.equal(built.initialState, plain.initialState);
      assert.deepEqual(built.initialState, { count: 0 });
      assert.equal(built.prepareCommand({ count: 0 }, { type: 'noop', payload: {} }).dateTime.getTime(), 0);
    }
    console.log('Packed ESM/CJS stateless envelope runtime PASS');
  `]));
}
