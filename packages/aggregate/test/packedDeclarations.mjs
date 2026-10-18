import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function packedAggregateDeclarations(consumer, command) {
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
    for (const name of ['plain', 'mounted', 'attached']) assert(declaration.includes(`const ${name}:`));
  }
  console.log(command('npx', ['--no-install', 'tsc', '--strict', '--skipLibCheck', 'false', '--noEmit',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node',
    'aggregate-declarations/dist/input.d.mts', 'aggregate-declarations/dist/input.d.cts']));
}
