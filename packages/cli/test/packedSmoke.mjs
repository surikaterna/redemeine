import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { reviewRegressions } from './packedReviewRegressions.mjs';
import { surgicalRegressions } from './packedSurgicalRegressions.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tempParent = join(tmpdir(), 'opencode');
mkdirSync(tempParent, { recursive: true });
const run = mkdtempSync(join(tempParent, 'standalone-cli-vk7d-'));
const consumer = join(run, 'consumer');
mkdirSync(consumer);
const env = { ...process.env, NODE_PATH: '', npm_config_cache: join(run, 'cache') };

function command(program, args, cwd = consumer) {
  console.log(program, args.join(' '), `(cwd=${cwd})`);
  return execFileSync(program, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function pack(name) {
  const cwd = join(repo, 'packages', name);
  const inventory = command('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], cwd);
  writeFileSync(join(run, `${name}-inventory.json`), inventory);
  const packed = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', run], cwd))[0];
  if (name === 'cli') {
    for (const path of ['dist/bin.js', 'dist/reflector.js', 'dist/reflector.d.ts']) assert(packed.files.some(file => file.path === path));
    assert(packed.files.every(file => !file.path.startsWith('src/')));
  }
  return join(run, packed.filename);
}

const tarballs = Object.fromEntries(['kernel', 'aggregate', 'projection', 'cli'].map(name => [name, pack(name)]));
const dependencies = Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [`@redemeine/${name}`, `file:${path}`]));
writeFileSync(join(consumer, 'package.json'), JSON.stringify({
  name: 'packed-cli-consumer', private: true, type: 'module',
  dependencies: { ...dependencies, typescript: '5.9.3', zod: '4.4.3', 'independent-zod': 'npm:zod@4.3.6', vitest: '3.2.4', '@types/node': '24.13.2' },
  overrides: { '@redemeine/kernel': `file:${tarballs.kernel}` },
}));
console.log(command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']));
console.log(command('npm', ['ls', '--all']));
for (const name of Object.keys(tarballs)) assert(realpathSync(join(consumer, 'node_modules/@redemeine', name)).startsWith(consumer));
console.log(command('npm', ['exec', '--yes', `--package=${tarballs.cli}`, '--', 'redemeine', 'help']));
const bin = join(consumer, 'node_modules/.bin/redemeine');
reviewRegressions(consumer, command);
surgicalRegressions(consumer, command, bin);
function cli(args) { console.log(command(bin, args)); }
writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
  target: 'ES2022', lib: ['ES2022', 'ESNext.Disposable'], module: 'ESNext', moduleResolution: 'Bundler', strict: true,
  exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true,
}, include: ['src', 'api.ts'] }));
cli(['init', 'orders', '--no-install']);
console.log(command('npx', ['--no-install', 'tsc', '--noEmit']));
console.log(command('npx', ['--no-install', 'vitest', 'run', '--maxWorkers=1']));
for (const name of ['selectors', 'createAggregate', 'lineEntity', 'expect', 'reduce']) {
  cli(['init', name, '--no-install']);
  const content = readFileSync(join(consumer, `src/domains/${name}/aggregate.ts`), 'utf8');
  assert(content.includes(`export const ${name}Aggregate = _createAggregate`));
  assert(content.includes(`export const ${name} = ${name}Aggregate.build()`));
}
cli(['add-entity', 'line', '--to', 'lineEntity', '--no-install']);
cli(['add-entity', 'note', '--to', 'lineEntity', '--no-install']);
assert(readFileSync(join(consumer, 'src/domains/lineEntity/aggregate.ts'), 'utf8').includes('line: _entity_line, note: _entity_note,'));
console.log(command('npx', ['--no-install', 'tsc', '--noEmit']));
console.log(command('npx', ['--no-install', 'vitest', 'run', '--maxWorkers=1']));
cli(['add-entity', 'line', '--to', 'orders', '--no-install']);
cli(['add-entity', 'note', '--to', 'orders', '--no-install']);
console.log(command('npx', ['--no-install', 'tsc', '--noEmit']));
console.log(command('npx', ['--no-install', 'vitest', 'run', '--maxWorkers=1']));
writeFileSync(join(consumer, 'src/projection.ts'), `import { createProjection } from '@redemeine/projection';
import { orders } from './domains/orders/aggregate';
export const view = createProjection('ordersView', () => ({ total: 0 })).from(orders, {}).build();
throw new Error('SOURCE EXECUTED');
`);
cli(['extract-schemas', '--entry', 'src/domains/orders/aggregate.ts', '--export', 'orders', '--tsconfig', 'tsconfig.json', '--out', 'src/generated/aggregate.ts']);
cli(['extract-schemas', '--kind', 'projection', '--entry', 'src/projection.ts', '--export', 'view', '--tsconfig', 'tsconfig.json', '--out', 'src/generated/projection.ts']);
const manifest = JSON.parse(readFileSync(join(consumer, 'schema-registry.json'), 'utf8'));
manifest.discover.push({ kind: 'projection', entry: './src/projection.ts', names: { view: 'ordersView' } });
writeFileSync(join(consumer, 'schema-registry.json'), JSON.stringify(manifest));
cli(['extract-schema-registries', '--manifest', 'schema-registry.json', '--out', 'src/generated/registries.ts']);
writeFileSync(join(consumer, 'api.ts'), `import { describeContract, generateSchemaFiles, extractZodSchemas, extractProjectionSchemas, extractSchemaRegistries } from '@redemeine/cli/reflector';
import type { Contract } from '@redemeine/kernel';
export const describe = (contract: Contract) => describeContract(contract);
export const tools = [generateSchemaFiles, extractZodSchemas, extractProjectionSchemas, extractSchemaRegistries];
`);
writeFileSync(join(consumer, 'src/generated/registry.spec.ts'), `import { it, expect } from 'vitest';
import { aggregateSchemas, projectionSchemas, aggregateJsonSchemas, projectionJsonSchemas } from './registries';
import { z } from 'zod';
it('materializes four maps with strict payload/state schemas', () => {
  expect([...aggregateSchemas.keys()]).toEqual(['orders']);
  expect([...projectionSchemas.keys()]).toEqual(['ordersView']);
  const aggregate = aggregateSchemas.get('orders');
  if (!aggregate) throw Error('Missing aggregate schemas');
  expect(aggregate.state.safeParse({ id: '123', accepted: true }).success).toBe(true);
  expect(aggregate.state.safeParse({ id: 123, accepted: 'yes' }).success).toBe(false);
  for (const schema of [aggregate.commands.accept, aggregate.events.accepted]) {
    if (!schema) throw Error('Missing payload schema');
    expect(schema.safeParse({ id: '123' }).success).toBe(true);
    expect(schema.safeParse({ id: 123 }).success).toBe(false);
  }
  const projection = projectionSchemas.get('ordersView');
  if (!projection) throw Error('Missing projection schema');
  expect(projection.safeParse({ total: 1 }).success).toBe(true);
  expect(projection.safeParse({ total: '1' }).success).toBe(false);
  expect(aggregateJsonSchemas.get('orders')).toEqual({
    state: z.toJSONSchema(aggregate.state),
    commands: Object.fromEntries(Object.entries(aggregate.commands).map(([key, schema]) => [key, z.toJSONSchema(schema)])),
    events: Object.fromEntries(Object.entries(aggregate.events).map(([key, schema]) => [key, z.toJSONSchema(schema)])),
  });
  expect(projectionJsonSchemas.get('ordersView')).toEqual(z.toJSONSchema(projection));
});
`);
console.log(command('node', ['--input-type=module', '-e', `const api = await import('@redemeine/cli/reflector'); if(Object.keys(api).length !== 5) throw Error('API exports'); console.log(Object.keys(api));`]));
console.log(command('node', ['--input-type=module', '-e', `
import { extractSchemaRegistries } from '@redemeine/cli/reflector';
extractSchemaRegistries({ tsconfig: './tsconfig.json', discover: [
  { kind: 'aggregate', entry: './src/domains/orders/aggregate.ts' },
  { kind: 'projection', entry: './src/projection.ts', names: { view: 'ordersView' } },
], outFile: './src/generated/api-registries.ts' });
`]));
assert.equal(readFileSync(join(consumer, 'src/generated/api-registries.ts'), 'utf8'), readFileSync(join(consumer, 'src/generated/registries.ts'), 'utf8'));
console.log(command('npx', ['--no-install', 'tsc', '--noEmit']));
console.log(command('npx', ['--no-install', 'vitest', 'run', '--maxWorkers=1']));
const original = readFileSync(join(consumer, 'src/domains/orders/aggregate.ts'), 'utf8');
for (const args of [['init', '../escape', '--no-install'], ['add-entity', 'line', '--to', 'orders', '--no-install']]) {
  assert.notEqual(spawnSync(bin, args, { cwd: consumer, env }).status, 0);
  assert.equal(readFileSync(join(consumer, 'src/domains/orders/aggregate.ts'), 'utf8'), original);
}
const sentinel = join(consumer, 'src/generated/sentinel.ts');
writeFileSync(sentinel, 'sentinel');
for (const out of ['src/generated/absent.ts', 'src/generated/sentinel.ts']) {
  assert.notEqual(spawnSync(bin, ['extract-schemas', '--entry', 'src/projection.ts', '--export', 'missing', '--out', out], { cwd: consumer, env }).status, 0);
}
assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel');
assert.equal(existsSync(join(consumer, 'src/generated/absent.ts')), false);
console.log(`Packed smoke passed. Evidence retained: ${run}`);
