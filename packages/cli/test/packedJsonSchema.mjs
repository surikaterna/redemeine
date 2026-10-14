import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function writeFixture(consumer) {
  const directory = join(consumer, 'json-review');
  mkdirSync(directory);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true,
  }, include: ['*.ts'] }));
  writeFileSync(join(directory, 'imported.ts'), `import { z } from 'zod'; import { writeFileSync } from 'node:fs';
    export const external = z.string().min(99); export type External = z.infer<typeof external>;
    writeFileSync('json-review/import-executed', 'bad'); throw Error('IMPORTED SOURCE EXECUTED');`);
  writeFileSync(join(directory, 'conflict.d.ts'), `interface A { x: string } interface B { x: number }
    export interface Conflict extends A, B {}`);
  writeFileSync(join(directory, 'input.ts'), `import { createAggregate } from '@redemeine/aggregate';
    import { createProjection } from '@redemeine/projection'; import type { Event } from '@redemeine/kernel';
    import { writeFileSync } from 'node:fs'; import type { External } from './imported'; import type { Conflict } from './conflict';
    class Money { amount!: number; currency!: { name: 'EUR' | 'GBP' }; }
    type State = { id: string; note: string | null; total: number };
    type Payload = Pick<State, 'id'> & Partial<Omit<State, 'id'>> & { prices: readonly Money[]; reference: External };
    export const aggregate = createAggregate('payment', {} as State)
      .events({ registered: (_state, event: Event<Payload>) => {} })
      .commands(emit => ({ register: (_state, payload: Payload) => emit.registered(payload), confirm: () => [], expire: () => [] })).build();
    export const view = createProjection('view', (): State => ({ id: '', note: null, total: 0 })).from(aggregate, {}).build();
    export const invalid = createAggregate('invalid', {})
      .events({ saved: (_state, event: Event<Conflict>) => {} })
      .commands(emit => ({ save: (_state, payload: Conflict) => emit.saved(payload) })).build();
    type Recursive = { next: Recursive };
    export const cyclic = createProjection('cycle', (): Recursive => ({} as Recursive)).from(aggregate, {}).build();
    writeFileSync('json-review/source-executed', 'bad'); throw Error('USER SOURCE EXECUTED');`);
  return directory;
}

function validateDocuments(command, aggregateFile, projectionFile, target) {
  console.log(command('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
    import Ajv from 'ajv'; import Ajv2020 from 'ajv/dist/2020.js';
    const ajv = new (${target === 'draft-7' ? 'Ajv' : 'Ajv2020'})({strict:true});
    const aggregate = JSON.parse(readFileSync(${JSON.stringify(aggregateFile)}, 'utf8'));
    const projection = JSON.parse(readFileSync(${JSON.stringify(projectionFile)}, 'utf8'));
    assert.deepEqual(Object.keys(aggregate.commands), ['confirm', 'expire', 'register']);
    for (const schema of [...Object.values(aggregate.commands), ...Object.values(aggregate.events), aggregate.state, projection]) {
      assert(ajv.validateSchema(schema)); ajv.compile(schema);
    }
    for (const name of ['confirm', 'expire']) {
      assert.equal(aggregate.commands[name], false);
      for (const value of [{}, null, '']) assert(!ajv.compile(aggregate.commands[name])(value));
    }
    const validate = ajv.compile(aggregate.commands.register);
    const payload = {id:'1',prices:[{amount:1,currency:{name:'EUR'}}],reference:'x',extra:true};
    assert(validate(payload)); assert(!validate({...payload, id:2}));
    assert(!validate({...payload, prices:[{amount:'1',currency:{name:'EUR'}}]}));
    assert(!validate({...payload, prices:[{amount:1,currency:{name:'USD'}}]}));
    assert(validate({...payload, note:null})); assert(!validate({...payload, note:2}));
    assert(!('minLength' in aggregate.commands.register.properties.reference));
    assert(ajv.compile(projection)({id:'1',note:null,total:1}));
    assert(!ajv.compile(projection)({id:'1',total:1}));
    console.log('Packed aggregate/projection ${target} validation PASS');
  `]));
}

function assertFailures(consumer, command, base) {
  const out = join(consumer, 'json-review/sentinel.json');
  writeFileSync(out, 'sentinel');
  const invalid = [
    ['--format', 'invalid'], ['--target', 'draft-7'], ['--format', 'json-schema', '--target', 'draft-4'],
    ['--format', 'json-schema', '--date-handling', 'date'], ['--kind', 'projection', '--export', 'view', '--no-state'],
    ['--format', 'json-schema', '--kind', 'projection', '--export', 'cyclic'],
  ];
  for (const flags of invalid) {
    assert.throws(() => command(process.execPath, [...base, ...flags, '--out', out]));
    assert.equal(readFileSync(out, 'utf8'), 'sentinel');
    assert.throws(() => command(process.execPath, [...base, ...flags, '--out', 'json-review/absent/output.json']));
    assert(!existsSync(join(consumer, 'json-review/absent')));
  }
  const conflict = [...base, '--format', 'json-schema', '--export', 'invalid'];
  const diagnostic = /invalid\.commands\["save"\].*cannot simultaneously extend/s;
  const rejected = error => error.status === 1 && diagnostic.test(`${error.stdout}${error.stderr}`);
  assert.throws(() => command(process.execPath, [...conflict, '--out', out]), rejected);
  assert.equal(readFileSync(out, 'utf8'), 'sentinel');
  assert.throws(() => command(process.execPath, [...conflict, '--out', 'json-review/absent/output.json']), rejected);
  assert(!existsSync(join(consumer, 'json-review/absent')));
}

export function jsonSchemaRegressions(consumer, command, bin) {
  const directory = writeFixture(consumer);
  const base = [bin, 'extract-schemas', '--entry', 'json-review/input.ts', '--export', 'aggregate', '--tsconfig', 'json-review/tsconfig.json'];
  for (const kind of ['aggregate', 'projection']) {
    const args = [...base, '--kind', kind, '--export', kind === 'aggregate' ? 'aggregate' : 'view'];
    const out = join(directory, `${kind}.ts`);
    command(process.execPath, [...args, '--out', out]);
    const zod = readFileSync(out, 'utf8');
    command(process.execPath, [...args, '--format', 'zod', '--out', out]);
    assert.equal(readFileSync(out, 'utf8'), zod);
    for (const target of ['draft-7', 'draft-2020-12']) {
      command(process.execPath, [...args, '--format', 'json-schema', '--target', target, '--out', `${out}.${target}.json`]);
    }
    command(process.execPath, [...args, '--format', 'json-schema', '--out', `${out}.default.json`]);
    assert.equal(readFileSync(`${out}.default.json`, 'utf8'), readFileSync(`${out}.draft-2020-12.json`, 'utf8'));
  }
  for (const target of ['draft-7', 'draft-2020-12']) {
    validateDocuments(command, join(directory, `aggregate.ts.${target}.json`), join(directory, `projection.ts.${target}.json`), target);
  }
  assertFailures(consumer, command, base);
  assert(!existsSync(join(directory, 'source-executed')));
  assert(!existsSync(join(directory, 'import-executed')));
}
