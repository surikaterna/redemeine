import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function directMixinEventRegressions(consumer, command, bin) {
  const directory = join(consumer, 'direct-events');
  mkdirSync(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module', redemeine: { schemas: { mode: 'types-first' } } }));
  const fixture = readFileSync(new URL('./fixtures/directMixinEvents.ts', import.meta.url), 'utf8')
    .replace("'../../../aggregate/src'", "'@redemeine/aggregate'")
    .replace("'../../../kernel/src'", "'@redemeine/kernel'");
  for (const extension of ['mts', 'cts']) writeFileSync(join(directory, `input.${extension}`), fixture);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    types: [], declaration: true, emitDeclarationOnly: true, outDir: './public'
  }, files: ['./input.mts', './input.cts'] }));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'direct-events/tsconfig.json']));
  writeFileSync(join(directory, 'extract.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: []
  }, include: ['./*.ts', './*.mts', './*.cts', './public/*'] }));
  const keys = ['audited', 'combined', 'counted', 'items.changed', 'rows.changed'];
  let expected;
  for (const entry of ['input.mts', 'input.cts', 'public/input.d.mts', 'public/input.d.cts']) {
    for (const [format, out] of [['zod', 'schemas.ts'], ['json-schema', 'schemas.json']]) {
      console.log(command(bin, ['extract-schemas', '--entry', `direct-events/${entry}`, '--export', 'aggregate',
        '--tsconfig', 'direct-events/extract.json', '--format', format, '--out', `direct-events/${out}`]));
      for (const name of ['repeated', 'rootCollision', 'mixinCollision', 'dottedCollision', 'structural',
        'replacedProjectors', 'intersectedProjectors', 'uncertainProjectors']) {
        writeFileSync(join(directory, 'sentinel'), 'sentinel');
        assert.throws(() => command(bin, ['extract-schemas', '--entry', `direct-events/${entry}`, '--export', name,
          '--tsconfig', 'direct-events/extract.json', '--format', format, '--out', 'direct-events/sentinel']),
        error => /collision|provenance|unresolved/.test(`${error.message}\n${error.stdout}\n${error.stderr}`));
        assert.equal(readFileSync(join(directory, 'sentinel'), 'utf8'), 'sentinel');
      }
      for (const name of ['eventsFallback', 'undefinedProjectors', 'ignoredEvents', 'prototypeEvents']) {
        const output = name === 'prototypeEvents' ? `prototype.${format === 'zod' ? 'ts' : 'json'}` : `selected.${format === 'zod' ? 'ts' : 'json'}`;
        console.log(command(bin, ['extract-schemas', '--entry', `direct-events/${entry}`, '--export', name,
          '--tsconfig', 'direct-events/extract.json', '--format', format, '--out', `direct-events/${output}`]));
        if (format === 'json-schema') assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(directory, output), 'utf8')).events),
          name === 'prototypeEvents' ? ['__proto__', 'constructor', 'toString'] : ['audited']);
      }
    }
    const json = JSON.parse(readFileSync(join(directory, 'schemas.json'), 'utf8'));
    assert.deepEqual(Object.keys(json.events), keys);
    if (expected) assert.deepEqual(json, expected);
    else expected = json;
    console.log(command('npx', ['--no-install', 'tsc', '-p', 'direct-events/extract.json', '--noEmit']));
    console.log(command('node', ['--input-type=module', '-e', `
import assert from 'node:assert/strict'; import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs'; import { createRequire } from 'node:module';
import { schemaBindings } from '@redemeine/aggregate';
const require = createRequire(import.meta.url);
const source = readFileSync('./direct-events/input.mts', 'utf8').replace("throw Error('APPLICATION_EXECUTED');", '');
writeFileSync('./direct-events/runtime.cjs', ts.transpileModule(source,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
writeFileSync('./direct-events/schemas.cjs', ts.transpileModule(readFileSync('./direct-events/schemas.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
const built = require('./direct-events/runtime.cjs');
const { eventSchemas } = require('./direct-events/schemas.cjs');
assert.deepEqual(Object.keys(eventSchemas).sort(), ${JSON.stringify(keys)});
for (const [id, valid, invalid, field, type] of [
  ['audited', {code:'yes'}, {code:3}, 'code', 'string'],
  ['counted', {amount:1}, {amount:'bad'}, 'amount', 'number'],
  ['combined', {enabled:true}, {enabled:1}, 'enabled', 'boolean'],
  ['items.changed', {value:1}, {value:'bad'}, 'value', 'number'],
  ['rows.changed', {value:1}, {value:'bad'}, 'value', 'number']]) {
  assert(eventSchemas[id].safeParse(valid).success); assert(!eventSchemas[id].safeParse(invalid).success);
  assert(!eventSchemas[id].safeParse({}).success);
  const json = JSON.parse(readFileSync('./direct-events/schemas.json', 'utf8')).events[id];
  assert.deepEqual(json.required, [field]);
  assert.deepEqual(json.properties[field], type === 'boolean'
    ? { anyOf: [{ type: 'boolean', const: false }, { type: 'boolean', const: true }] } : {type});
}
assert.deepEqual(Object.keys(schemaBindings(built.aggregate).events.schemaToWire).sort(), ${JSON.stringify(keys)});
for (const name of ['repeated', 'rootCollision', 'mixinCollision', 'dottedCollision'])
  assert.throws(() => schemaBindings(built[name]), /Ambiguous/);
assert.equal(schemaBindings(built.aggregate.withPlugins()), schemaBindings(built.aggregate));
writeFileSync('./direct-events/prototype.cjs', ts.transpileModule(readFileSync('./direct-events/prototype.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
const prototypeSchemas = require('./direct-events/prototype.cjs').eventSchemas;
const prototypeJson = JSON.parse(readFileSync('./direct-events/prototype.json', 'utf8')).events;
for (const id of ['__proto__', 'constructor', 'toString']) {
  assert(Object.hasOwn(prototypeSchemas, id)); assert(Object.hasOwn(prototypeJson, id));
  assert(prototypeSchemas[id].safeParse({count: 2}).success);
  assert(!prototypeSchemas[id].safeParse({count: 'bad'}).success);
  assert.deepEqual(prototypeJson[id].properties.count, {type: 'number'});
  assert.deepEqual(prototypeJson[id].required, ['count']);
}
for (const api of [await import('@redemeine/aggregate'), require('@redemeine/aggregate')]) {
  const handlers = { ['__proto__']: (s, e) => { s.count = e.payload.count; },
    constructor: (s, e) => { s.count = e.payload.count + 1; }, toString: (s, e) => { s.count = e.payload.count + 2; } };
  for (const shared of [false, true]) {
    const builder = api.createAggregate('host', {count: 0}).mixins(api.createMixin().events(handlers).build());
    const aggregate = (shared ? builder.naming({event: () => '__proto__'}) : builder).build();
    const snapshot = schemaBindings(aggregate);
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
    const assertFrozen = value => { assert(Object.isFrozen(value)); for (const child of Object.values(value))
      if (child && typeof child === 'object') assertFrozen(child); };
    assertFrozen(snapshot);
    for (const [id, name, offset] of [['__proto__', '__proto__', 0], ['constructor', 'constructor', 1], ['toString', 'to_string', 2]]) {
      const wire = shared ? '__proto__' : 'host.' + name + '.event';
      const winner = shared ? 'toString' : id;
      assert.deepEqual(snapshot.events.schemaToWire[id], {wireType: wire, winnerSchemaId: winner, isWireWinner: winner === id});
      assert.equal(typeof snapshot.events.schemaToWire[id].wireType, 'string');
      assert.equal(snapshot.events.wireToSchema[wire], winner);
      assert.equal(aggregate.apply({count: 0}, {type: wire, payload: {count: 2}}).count, 2 + (shared ? 2 : offset));
    }
  }
}
` ]));
  }
}
