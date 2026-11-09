import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function surgicalRegressions(consumer, command, bin) {
  restrictedNames(consumer, bin);
  aliases(consumer, command);
  mountedCommands(consumer, command, bin);
  canonicalProvenance(consumer, command, bin);
}

function canonicalProvenance(consumer, command, bin) {
  const root = join(consumer, 'canonical-provenance');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', redemeine: { schemas: { mode: 'zod-first' } } }));
  writeFileSync(join(root, 'schemas.ts'), `import { z } from 'zod';
export const inputSchema = z.string().min(10); export type Input = z.infer<typeof inputSchema>;
export const outputSchema = z.string().min(3); export type Output = z.infer<typeof outputSchema>;`);
  writeFileSync(join(root, 'input.ts'), `import type { Input, Output } from './schemas';
type Result = { payload: Output }; type Creators = { save(value: Input): Result };
declare const aggregate: { commandCreators: { [K in keyof Creators as \`mounted\${Capitalize<K>}\`]: Creators[K] };
pure: { eventProjectors: {} }; initialState: { ready: boolean } }; export { aggregate };
throw Error('source must not execute');`);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true,
  }, include: ['*.ts'] }));
  const args = ['extract-schemas', '--entry', 'canonical-provenance/input.ts', '--export', 'aggregate', '--tsconfig', 'canonical-provenance/tsconfig.json', '--no-state'];
  console.log(command(bin, [...args, '--out', 'canonical-provenance/generated.ts']));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'canonical-provenance/tsconfig.json']));
  console.log(command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict'; import ts from 'typescript'; import { readFileSync, writeFileSync } from 'node:fs';
const root = 'canonical-provenance/';
const source = readFileSync(root + 'generated.ts', 'utf8');
assert.match(source, /outputSchema/); assert(!source.includes('inputSchema'));
for (const name of ['schemas', 'generated']) writeFileSync(root + name + '.mjs', ts.transpileModule(readFileSync(root + name + '.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText.replace('"./schemas"', '"./schemas.mjs"'));
const { commandSchemas } = await import('./' + root + 'generated.mjs');
assert(commandSchemas.mountedSave.safeParse('valid').success);
assert(!commandSchemas.mountedSave.safeParse('no').success); assert(!commandSchemas.mountedSave.safeParse(123).success);
console.log('Packed canonical return schema, not equal-primitive pack input PASS');` ]));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', redemeine: { schemas: { mode: 'types-first' } } }));
  const json = spawnSync(bin, [...args, '--format', 'json-schema', '--out', 'canonical-provenance/generated.json'], { cwd: consumer, encoding: 'utf8' });
  assert.notEqual(json.status, 0);
  assert.match(json.stderr + json.stdout, /existing Zod schema.*discard its constraints/);
  assert(!existsSync(join(root, 'generated.json')));
  writeFileSync(join(root, 'input.ts'), readFileSync(join(root, 'input.ts'), 'utf8')
    .replace('type Result = { payload: Output }', 'type Result<T> = { payload: T }')
    .replace('): Result }', '): Result<Output> }'));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'canonical-provenance/tsconfig.json']));
  for (const format of ['zod', 'json-schema']) {
    const output = `canonical-provenance/generic.${format === 'zod' ? 'ts' : 'json'}`;
    const result = spawnSync(bin, [...args, '--format', format, '--out', output], { cwd: consumer, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /mountedSave: cannot preserve schema-linked return payload provenance; use an authored concrete return payload type/);
    assert(!existsSync(join(consumer, output)));
  }
  console.log('Packed schema-linked generic return fails closed in Zod and JSON PASS');
  writeFileSync(join(root, 'input.ts'), readFileSync(join(root, 'input.ts'), 'utf8').replace('Result<Output>', 'Result<string>'));
  for (const format of ['zod', 'json-schema']) {
    console.log(command(bin, [...args, '--format', format, '--out', `canonical-provenance/structural.${format === 'zod' ? 'ts' : 'json'}`]));
  }
  genericClassRejections(consumer, command, bin, root, args);
}

function genericClassRejections(consumer, command, bin, root, args) {
  const source = readFileSync(join(root, 'input.ts'), 'utf8');
  for (const [wrapper, result] of [
    ['declare class Result<T = Output> { payload: T }', 'Result'],
    ['declare class Result<T> { payload: T }', 'Result<Output>'],
    ['declare class Base<T = Output> { payload: T }; declare class Result extends Base {}', 'Result'],
    ['declare class Result<T> { payload: T }', 'Result<string>'],
  ]) {
    writeFileSync(join(root, 'input.ts'), source.replace('type Result<T> = { payload: T }', wrapper).replace('Result<string>', result));
    console.log(command('npx', ['--no-install', 'tsc', '-p', 'canonical-provenance/tsconfig.json']));
    for (const mode of ['types-first', 'zod-first']) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', redemeine: { schemas: { mode } } }));
      for (const format of ['zod', 'json-schema']) {
        const output = `canonical-provenance/class.${format === 'zod' ? 'ts' : 'json'}`;
        writeFileSync(join(consumer, output), 'sentinel');
        const rejection = spawnSync(bin, [...args, '--format', format, '--out', output], { cwd: consumer, encoding: 'utf8' });
        assert.notEqual(rejection.status, 0);
        assert.match(rejection.stderr + rejection.stdout, /mountedSave: cannot establish generic class return payload provenance; use an authored concrete return payload type/);
        assert.equal(readFileSync(join(consumer, output), 'utf8'), 'sentinel');
        rmSync(join(consumer, output));
      }
    }
  }
  console.log('Packed generic class defaults, explicit parameters and inheritance reject before writes in both modes/formats PASS');
}

function mountedCommands(consumer, command, bin) {
  const root = join(consumer, 'mounted-commands');
  mkdirSync(root);
  const source = readFileSync(new URL('./fixtures/mountedCommands.ts', import.meta.url), 'utf8');
  for (const file of ['input.ts', 'common.cts']) writeFileSync(join(root, file), source);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    declaration: true, emitDeclarationOnly: true, outDir: './dist', types: ['node'],
  }, include: ['input.ts', 'common.cts'] }));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'mounted-commands/tsconfig.json']));
  const entries = ['input.ts', 'dist/input.d.ts', 'dist/common.d.cts'];
  writeFileSync(join(root, 'extract.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true,
  }, include: ['*.ts', 'dist/*'] }));
  for (const [index, entry] of entries.entries()) {
    const args = ['extract-schemas', '--entry', `mounted-commands/${entry}`, '--export', 'aggregate', '--tsconfig', 'mounted-commands/extract.json'];
    console.log(command(bin, [...args, '--out', `mounted-commands/generated${index}.ts`]));
    console.log(command(bin, [...args, '--format', 'json-schema', '--out', `mounted-commands/generated${index}.json`]));
  }
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'mounted-commands/extract.json']));
  console.log(command('npx', ['--no-install', 'tsc', '--strict', '--skipLibCheck', 'false', '--noEmit', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', ...entries.map((_, index) => `mounted-commands/generated${index}.ts`)]));
  console.log(command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict'; import ts from 'typescript'; import { readFileSync, writeFileSync } from 'node:fs';
const keys = ['byKeyChangeLabel', 'byKeyLeavesChangeQty', 'changeTitle', 'childrenChangeLabel', 'childrenLeavesChangeQty'];
let baseline;
for (let i = 0; i < 3; i++) {
  const file = 'mounted-commands/generated' + i;
  writeFileSync(file + '.mjs', ts.transpileModule(readFileSync(file + '.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText);
  const { commandSchemas, eventSchemas, stateSchema } = await import('./' + file + '.mjs');
  const json = JSON.parse(readFileSync(file + '.json', 'utf8'));
  assert.deepEqual(Object.keys(commandSchemas).sort(), keys); assert.deepEqual(Object.keys(json.commands), keys);
  for (const key of keys) {
    const good = key === 'changeTitle' ? { title: 'ok' } : key.endsWith('ChangeLabel') ? { id: 'child', label: 'ok' } : { id: 'leaf', qty: 2 };
    assert(commandSchemas[key].safeParse(good).success); assert(!commandSchemas[key].safeParse({}).success);
    assert(!commandSchemas[key].safeParse({ title: 1, id: 1, label: 1, qty: 'bad' }).success);
    assert(!commandSchemas[key].safeParse(['child', 'label']).success);
    assert.deepEqual(json.commands[key].required, Object.keys(good).sort());
    for (const [field, value] of Object.entries(good)) assert.equal(json.commands[key].properties[field].type, typeof value);
  }
  const child = { id: 'c', label: 'ok', leaves: [{ id: 'l', qty: 2 }] };
  assert(stateSchema.safeParse({ title: 'ok', children: [child], byKey: { c: child } }).success);
  assert(!stateSchema.safeParse({ title: 'ok', children: [child], byKey: { c: { ...child, leaves: [{ id: 'l', qty: 'bad' }] } } }).success);
  const events = ['byKey.labelChanged', 'byKey.leaves.qtyChanged', 'children.labelChanged', 'children.leaves.qtyChanged', 'titleChanged'];
  assert.deepEqual(Object.keys(eventSchemas).sort(), events); assert.deepEqual(Object.keys(json.events), events);
  if (baseline) assert.deepEqual(json, baseline); else baseline = json;
}
console.log('Packed mounted commands/events: source/ESM/CJS declarations, canonical JSON/Zod payloads and unchanged state PASS');` ]));
}

function restrictedNames(consumer, bin) {
  const root = join(consumer, 'restricted');
  mkdirSync(root);
  const reject = args => {
    const result = spawnSync(bin, [...args, '--no-install'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /non-reserved/);
  };
  for (const name of ['eval', 'arguments']) {
    for (const args of [['init', name], ['add-entity', name, '--to', 'orders'], ['add-entity', 'line', '--to', name]]) reject(args);
    assert.deepEqual(readdirSync(root), []);
  }
  const paths = ['src/domains/orders/aggregate.ts', 'src/domains/eval/aggregate.ts', 'src/domains/arguments/aggregate.ts', 'src/test-utils.ts', 'schema-registry.json', 'package.json'];
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `sentinel ${path}`);
  }
  for (const name of ['eval', 'arguments']) {
    for (const args of [['init', name], ['add-entity', name, '--to', 'orders'], ['add-entity', 'line', '--to', name]]) reject(args);
    assert(!existsSync(join(root, `src/domains/orders/entities/${name}`)));
    assert(!existsSync(join(root, `src/domains/${name}/entities`)));
  }
  for (const path of paths) assert.equal(readFileSync(join(root, path), 'utf8'), `sentinel ${path}`);
  console.log('Packed restricted init/entity/target absence and sentinel checks PASS');
}

function aliases(consumer, command) {
  const root = join(consumer, 'surgical');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export type Payload = { a: string };');
  writeFileSync(join(root, 'b.ts'), 'export type Payload = { b: number };');
  writeFileSync(join(root, 'aggregate.ts'), `import { createAggregate } from '@redemeine/aggregate';
import type { Payload as A } from './a'; import type { Payload as B } from './b';
import type { Event } from '@redemeine/kernel';
type Foo = { upper: string }; type foo = { lower: number }; type Box<T> = { value: T }; type State = { ready: boolean };
type Leaf = { value: string }; type Parent = { leaf: Leaf };
type Deep = ${'{ next: '.repeat(9)}Parent${' }'.repeat(9)};
export const surgical = createAggregate<State, 'surgical'>('surgical', { ready: false })
.events({ second: (state, event: Event<B>) => { state.ready = !!event.payload; } })
.commands(emit => ({
  deep: { pack: (payload: Deep) => payload, handler: () => [] },
  directParent: { pack: (payload: Parent) => payload, handler: () => [] },
  directLeaf: { pack: (payload: Leaf) => payload, handler: () => [] },
  a: { pack: (payload: A) => payload, handler: () => [] }, b: { pack: (payload: B) => payload, handler: (state: State, payload: B) => emit.second(payload) },
  upper: { pack: (payload: Foo) => payload, handler: () => [] }, lower: { pack: (payload: foo) => payload, handler: () => [] },
  stringBox: { pack: (payload: Box<string>) => payload, handler: () => [] }, numberBox: { pack: (payload: Box<number>) => payload, handler: () => [] },
  repeat: { pack: (payload: A) => payload, handler: () => [] }
})).build();`);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true }, include: ['*.ts'] }));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'surgical/tsconfig.json']));
  console.log(command('node', ['--input-type=module', '-e', `
import { extractZodSchemas } from '@redemeine/cli/reflector';
extractZodSchemas({ tsconfig: 'surgical/tsconfig.json', entry: 'surgical/aggregate.ts', aggregateExport: 'surgical', outFile: 'surgical/generated.ts' });` ]));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'surgical/tsconfig.json']));
  console.log(command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict'; import ts from 'typescript'; import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('surgical/generated.mjs', ts.transpileModule(readFileSync('surgical/generated.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { commandSchemas: c, eventSchemas: e, stateSchema: s } = await import('./surgical/generated.mjs');
const cases = { a: [{ a: 'a' }, { b: 1 }], b: [{ b: 1 }, { a: 'a' }], upper: [{ upper: 'u' }, { lower: 2 }], lower: [{ lower: 2 }, { upper: 'u' }], stringBox: [{ value: 's' }, { value: 1 }], numberBox: [{ value: 1 }, { value: 's' }] };
for (const [name, [good, bad]] of Object.entries(cases)) { assert(c[name].safeParse(good).success); assert(!c[name].safeParse(bad).success); }
assert.equal(c.a, c.repeat); assert.equal(c.b, e.second); assert(s.safeParse({ ready: true }).success); assert(!s.safeParse({ ready: 'yes' }).success);
assert(c.directLeaf.safeParse({ value: 'ok' }).success); assert(!c.directLeaf.safeParse({ value: 42 }).success);
assert(c.directParent.safeParse({ leaf: { value: 'ok' } }).success); assert(!c.directParent.safeParse({ leaf: { value: 42 } }).success);
console.log('Packed depth-truncated aliases do not weaken direct payloads PASS');
console.log('Packed distinct aliases/case/generics/state, runtime negatives and dedup PASS');` ]));
}
