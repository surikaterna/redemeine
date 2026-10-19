import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function schemaReconciliationRegressions(consumer, command) {
  const directory = join(consumer, 'reconciliation');
  mkdirSync(directory);
  writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod';
export type Tree = { value: string; next?: Tree };
export const tree: z.ZodType<Tree> = z.lazy(() => z.object({ value: z.string().min(3), next: tree.optional() }));
export type State = z.infer<typeof tree>;
export type Items = string[];
export const a: z.ZodType<Items> = z.array(z.string().min(3));
export const b: z.ZodType<Items> = z.array(z.string().max(1));
export type A = z.infer<typeof a>; export type B = z.infer<typeof b>;
`);
  writeFileSync(join(directory, 'input.ts'), `import { createAggregate } from '@redemeine/aggregate';
import type { State, A, B, Items } from './schemas';
export const aggregate = createAggregate<State, 'tree'>('tree', { value: 'abc' }).events({})
 .commands(() => ({ change: (_state, value: State) => [] })).build();
export { aggregate as exportedAlias }; export const alias = aggregate; export const alias2 = alias;
export const items = createAggregate<State, 'items'>('items', { value: 'abc' }).events({})
 .commands(() => ({ A: (_state, value: A) => [], B: (_state, value: B) => [], plain: (_state, value: Items) => [] })).build();
throw Error('APPLICATION_EXECUTED');`);
  writeFileSync(join(directory, 'public.ts'), `export { alias2 } from './input';`);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: false,
    noUnusedLocals: true, esModuleInterop: true, types: [], outDir: './compiled'
  }, include: ['./*.ts'] }));
  runExtraction(command);
  assert(readFileSync(join(directory, 'output.ts'), 'utf8').includes('from "./schemas"'));
}

function runExtraction(command) {
  console.log(command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { extractSchemaRegistries, extractZodSchemas } from '@redemeine/cli/reflector';
const root = './reconciliation/';
const options = { tsconfig: root + 'tsconfig.json', outFile: root + 'output.ts' };
const routes = ['input.ts', 'public.ts'].map(entry => ({ kind: 'aggregate', entry: root + entry, ...(entry === 'input.ts' ? { exclude: ['items'] } : {}) }));
for (const mode of ['types-first', 'zod-first']) {
  writeFileSync(root + 'package.json', JSON.stringify({ type: 'module', redemeine: { schemas: { mode, maxDepth: 1 } } }));
  extractSchemaRegistries({ ...options, discover: routes });
  const first = readFileSync(options.outFile, 'utf8');
  extractSchemaRegistries({ ...options, discover: [...routes].reverse() });
  assert.equal(readFileSync(options.outFile, 'utf8'), first);
  writeFileSync(root + 'items.ts', 'sentinel');
  const items = { ...options, outFile: root + 'items.ts', entry: root + 'input.ts', aggregateExport: 'items' };
  if (mode === 'zod-first') {
    assert.throws(() => extractZodSchemas(items), /no importable Zod schema/);
    assert.equal(readFileSync(items.outFile, 'utf8'), 'sentinel');
  }
}
writeFileSync(root + 'package.json', JSON.stringify({ type: 'module', redemeine: { schemas: { mode: 'types-first' } } }));
extractZodSchemas({ ...options, outFile: root + 'items.ts', entry: root + 'input.ts', aggregateExport: 'items' });
` ]));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'reconciliation/tsconfig.json', '--noEmit']));
  checkRuntime(command);
}

function checkRuntime(command) {
  console.log(command('node', ['--input-type=module', '-e', `
import ts from 'typescript';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('./reconciliation/compiled');
for (const name of ['schemas', 'output', 'items']) writeFileSync('./reconciliation/compiled/' + name + '.js', ts.transpileModule(
  readFileSync('./reconciliation/' + name + '.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
writeFileSync('./reconciliation/compiled/package.json', JSON.stringify({ type: 'commonjs' }));
` ]));
  console.log(command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { aggregateSchemas } = require('./reconciliation/compiled/output.js');
const { commandSchemas } = require('./reconciliation/compiled/items.js');
const { tree, a, b } = require('./reconciliation/compiled/schemas.js');
assert.equal(aggregateSchemas.get('tree').state, tree);
assert.equal(aggregateSchemas.get('tree').commands.change, tree);
assert.equal(commandSchemas.A, a); assert.equal(commandSchemas.B, b);
assert.equal(commandSchemas.A.safeParse(['x']).success, false);
assert.equal(commandSchemas.B.safeParse(['abcd']).success, false);
for (const value of ['x', 'abcd']) assert.equal(commandSchemas.plain.safeParse([value]).success, true);
` ]));
}
