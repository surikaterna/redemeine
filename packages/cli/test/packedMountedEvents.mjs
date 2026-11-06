import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const diagnostic = pattern => error => pattern.test(`${error.message}\n${error.stdout}\n${error.stderr}`);

export function mountedEventRegressions(consumer, command, bin) {
  const directory = join(consumer, 'mounted-events');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module', redemeine: { schemas: { mode: 'types-first' } } }));
  const fixture = readFileSync(new URL('./fixtures/mountedEvents.ts', import.meta.url), 'utf8')
    .replace("'../../../aggregate/src'", "'@redemeine/aggregate'")
    .replace("'../../../kernel/src'", "'@redemeine/kernel'");
  for (const extension of ['mts', 'cts']) writeFileSync(join(directory, `input.${extension}`), fixture);
  const annotated = fixture.replace('export const aggregate = ', 'const builder = ')
    .replace(".naming({ event: () => 'custom.wire.event' })\n    .build();",
      ".naming({ event: () => 'custom.wire.event' });\nexport const aggregate: ReturnType<typeof builder.build> = builder.build();");
  writeFileSync(join(directory, 'annotated.mts'), annotated);
  writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod';
export const payload = z.object({ code: z.string().min(4) });
export type Payload = z.output<typeof payload>;`);
  writeFileSync(join(directory, 'linked.ts'), `import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import type { Payload } from './schemas';
const entity = createEntity('entity', { unrelatedState: 0 }).events({
  changed: (_state, _event: Event<Payload>) => {}
}).build();
export const aggregate = createAggregate('linked', { count: 0 }).entityMap('items', entity).build();
throw Error('APPLICATION_EXECUTED');`);
  writeFileSync(join(directory, 'unsupported.ts'), `import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel'; import type { Payload } from './schemas';
function entity<T extends Payload>() { return createEntity('generic', { count: 0 }).events({
  changed: (_state, _event: Event<T>) => {}
}).build(); }
export const aggregate = createAggregate('unsupported', { count: 0 }).entityList('items', entity()).build();`);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    types: [], declaration: true, emitDeclarationOnly: true, outDir: './public'
  }, files: ['./input.mts', './input.cts', './annotated.mts'] }));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'mounted-events/tsconfig.json']));
  writeFileSync(join(directory, 'extract.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: []
  }, include: ['./*.ts', './*.mts', './*.cts', './public/*'] }));
  let expectedJson;
  for (const entry of ['annotated.mts', 'input.mts', 'input.cts', 'public/input.d.mts', 'public/input.d.cts', 'linked.ts']) {
    extractAndCheck(command, bin, entry);
    if (entry === 'linked.ts') continue;
    const json = JSON.parse(readFileSync(join(directory, 'output.json'), 'utf8'));
    if (expectedJson) assert.deepEqual(json, expectedJson);
    else expectedJson = json;
  }
  for (const format of ['zod', 'json-schema']) {
    const out = join(directory, 'sentinel');
    writeFileSync(out, 'sentinel');
    for (const [entry, name] of [['input.mts', 'collision'], ['unsupported.ts', 'aggregate']]) {
      assert.throws(() => command(bin, ['extract-schemas', '--entry', `mounted-events/${entry}`, '--export', name,
        '--tsconfig', 'mounted-events/extract.json', '--format', format, '--out', 'mounted-events/sentinel']),
      diagnostic(/collision|schema-linked|provenance|type parameter/));
      assert.equal(readFileSync(out, 'utf8'), 'sentinel');
    }
  }
  bindingRegressions(directory, command, bin);
}

function bindingRegressions(directory, command, bin) {
  const fixture = readFileSync(new URL('./fixtures/schemaBindings.ts', import.meta.url), 'utf8')
    .replace("'../../../aggregate/src'", "'@redemeine/aggregate'")
    .replace("'../../../kernel/src'", "'@redemeine/kernel'");
  for (const extension of ['mts', 'cts']) writeFileSync(join(directory, `bindings.${extension}`), fixture);
  console.log(command('npx', ['--no-install', 'tsc', '--strict', '--skipLibCheck', 'false', '--declaration',
    '--emitDeclarationOnly', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--outDir', 'mounted-events/public', 'mounted-events/bindings.mts', 'mounted-events/bindings.cts']));
  writeFileSync(join(directory, 'bindings.ts'), fixture);
  for (const entry of ['bindings.ts', 'public/bindings.d.mts', 'public/bindings.d.cts']) {
    for (const format of ['zod', 'json-schema']) {
      console.log(command(bin, ['extract-schemas', '--entry', `mounted-events/${entry}`, '--export', 'aggregate',
        '--tsconfig', 'mounted-events/extract.json', '--format', format, '--out', `mounted-events/bindings.${format === 'zod' ? 'schemas.ts' : 'json'}`]));
    }
  }
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'mounted-events/extract.json', '--noEmit']));
  console.log(command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict'; import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs'; import { createRequire } from 'node:module';
import { schemaBindings } from '@redemeine/aggregate';
const require = createRequire(import.meta.url);
for (const name of ['bindings', 'bindings.schemas']) writeFileSync('./mounted-events/runtime/' + name + '.js',
  ts.transpileModule(readFileSync('./mounted-events/' + name + '.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText);
const { aggregate } = require('./mounted-events/runtime/bindings.js');
const { commandSchemas, eventSchemas } = require('./mounted-events/runtime/bindings.schemas.js');
const json = JSON.parse(readFileSync('./mounted-events/bindings.json', 'utf8'));
const bindings = schemaBindings(aggregate);
assert.equal(schemaBindings(aggregate.withPlugins()), bindings);
for (const [kind, schemas, raw] of [[bindings.commands, commandSchemas, json.commands], [bindings.events, eventSchemas, json.events]]) {
  assert.deepEqual(Object.keys(kind.schemaToWire).sort(), Object.keys(schemas).sort());
  for (const id of Object.values(kind.wireToSchema)) if (!schemas[id] || !Object.hasOwn(raw, id)) throw Error('Missing schema: ' + id);
}
const command = aggregate.commandCreators.create('42');
assert.equal(command.type, bindings.commands.schemaToWire.create.wireType);
assert(commandSchemas.create.safeParse(command.payload).success);
assert(!commandSchemas.create.safeParse(['42']).success);
const mounted = aggregate.commandCreators.itemsRegister(' valid ');
assert(commandSchemas.itemsRegister.safeParse(mounted.payload).success);
const event = aggregate.process({ count: 0, items: { one: { key: 'one', label: '' } } }, mounted)[0];
const id = bindings.events.wireToSchema[event.type];
assert.equal(id, 'items.registered'); assert(eventSchemas[id].safeParse(event.payload).success);
assert(!eventSchemas[id].safeParse({ count: 1 }).success);
assert.equal(bindings.events.schemaToWire.changed.winnerSchemaId, id);
` ]));
}

function extractAndCheck(command, bin, entry) {
  const linked = entry === 'linked.ts';
  const expected = linked ? ['items.changed'] : ['byKey.registered', 'changed', 'deep.children.children.registered',
    'inherited.registered', 'items.registered', 'mixed.registered', 'parents.children.registered'];
  for (const [format, out] of [['zod', 'output.ts'], ['json-schema', 'output.json']]) {
    if (linked && format === 'json-schema') {
      assert.throws(() => command(bin, ['extract-schemas', '--entry', 'mounted-events/linked.ts', '--export', 'aggregate',
        '--tsconfig', 'mounted-events/extract.json', '--format', format, '--out', 'mounted-events/output.json']),
      diagnostic(/compiler-only JSON would discard its constraints/));
      continue;
    }
    console.log(command(bin, ['extract-schemas', '--entry', `mounted-events/${entry}`, '--export', 'aggregate',
      '--tsconfig', 'mounted-events/extract.json', '--format', format, '--out', `mounted-events/${out}`]));
  }
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'mounted-events/extract.json', '--noEmit']));
  console.log(command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict'; import ts from 'typescript';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'; import { createRequire } from 'node:module';
mkdirSync('./mounted-events/runtime', { recursive: true });
writeFileSync('./mounted-events/runtime/package.json', '{"type":"commonjs"}');
for (const name of ['schemas', 'output']) writeFileSync('./mounted-events/runtime/' + name + '.js',
  ts.transpileModule(readFileSync('./mounted-events/' + name + '.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText);
const require = createRequire(import.meta.url);
const { eventSchemas, commandSchemas } = require('./mounted-events/runtime/output.js');
const expected = ${JSON.stringify(expected)};
assert.deepEqual(Object.keys(eventSchemas).sort(), expected); assert.deepEqual(commandSchemas, {});
const json = ${linked} ? undefined : JSON.parse(readFileSync('./mounted-events/output.json', 'utf8'));
if (json) assert.deepEqual(Object.keys(json.events), expected);
for (const key of expected) {
  const valid = ${linked} ? { code: 'valid' } : key === 'changed' ? { count: 1 } : { label: 'valid' };
  const invalid = ${linked} ? { code: 'x' } : key === 'changed' ? { count: 'bad' } : { label: 1 };
  assert(eventSchemas[key].safeParse(valid).success); assert(!eventSchemas[key].safeParse(invalid).success);
  if (json) assert.deepEqual(json.events[key].required, [key === 'changed' ? 'count' : 'label']);
}
if (${linked}) assert.equal(eventSchemas['items.changed'], require('./mounted-events/runtime/schemas.js').payload);
` ]));
}
