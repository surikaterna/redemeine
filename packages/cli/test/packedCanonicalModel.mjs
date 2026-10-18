import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function canonicalModelRegressions(consumer, command, bin) {
  const directory = join(consumer, 'canonical-model');
  mkdirSync(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', redemeine: { schemas: { mode: 'types-first' } } }));
  writeFileSync(join(directory, 'input.ts'), `import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
    const plugin = createAggregatePlugin('audit').state((): { rows?: { at: Date; tags?: string[] }[] } => ({})).build();
    export const aggregate = createAggregate('canonical', { count: 0 }).build().withPlugins(plugin);
    throw new Error('APPLICATION_EXECUTED');`);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: ['node'],
    declaration: true, emitDeclarationOnly: true, outDir: './dist'
  }, include: ['input.ts', '*-schemas.ts'] }));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'canonical-model/tsconfig.json', '--noEmit', '--emitDeclarationOnly', 'false', '--declaration', 'false']));
  console.log(command(bin, ['extract-schemas', '--entry', 'canonical-model/input.ts', '--export', 'aggregate',
    '--tsconfig', 'canonical-model/tsconfig.json', '--date-handling', 'date', '--out', 'canonical-model/model-schemas.ts']));
  writeFileSync(join(directory, 'registry.json'), JSON.stringify({ version: 1, tsconfig: './tsconfig.json',
    discover: [{ kind: 'aggregate', entry: './input.ts' }] }));
  console.log(command(bin, ['extract-schema-registries', '--manifest', 'canonical-model/registry.json', '--out', 'canonical-model/registry-schemas.ts']));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'canonical-model/tsconfig.json', '--noEmit', '--emitDeclarationOnly', 'false', '--declaration', 'false']));
  console.log(command('node', ['--input-type=module', '-e', `
    import ts from 'typescript'; import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    function load(file) {
      const output = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
      const result = {}; new Function('require', 'exports', output)(require, result); return result;
    }
    const schema = load('./canonical-model/model-schemas.ts').stateSchema;
    const registry = load('./canonical-model/registry-schemas.ts').aggregateSchemas.get('canonical').state;
    for (const [current, at] of [[schema, new Date()], [registry, '2026-10-18']]) {
      if (!current.safeParse({ count: 1, audit: { rows: [{ at, tags: ['ok'] }] } }).success) throw Error('valid mounted model rejected');
      if (current.safeParse({ count: 1 }).success) throw Error('mount omitted');
      if (current.safeParse({ count: 1, audit: { rows: [{ at, tags: [1] }] } }).success) throw Error('nested model weakened');
    }
  `]));
  // Normal published-package consumer: no explicit aggregate generics or extra Immer dependency/import.
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'canonical-model/tsconfig.json']));
  assert(readFileSync(join(directory, 'dist/input.d.ts'), 'utf8').includes('aggregate'));
}
