import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function surgicalRegressions(consumer, command, bin) {
  restrictedNames(consumer, bin);
  aliases(consumer, command);
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
export const surgical = createAggregate<State, 'surgical'>('surgical', { ready: false })
.events({ second: (state, event: Event<B>) => { state.ready = !!event.payload; } })
.commands(emit => ({
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
console.log('Packed distinct aliases/case/generics/state, runtime negatives and dedup PASS');` ]));
}
