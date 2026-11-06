import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const source = `import { createAggregate, createAggregatePluginFor } from '@redemeine/aggregate';
import type { BuiltAggregate, BuiltAggregateResult } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
const initial: { count: number; at: Date; nullable: string | null; optional?: string } = {
  count: 0, at: new Date(), nullable: null };
export const builder = createAggregate('ordinary', initial)
  .events({ changed: (state, event: Event<{ count: number }>) => { state.count = event.payload.count; } })
  .commands(emit => ({ change: (_state, payload: { count: number }) => [emit.changed(payload)] }));
export const aggregate = builder.build();
type State = NonNullable<typeof aggregate.__stateType>;
const compatible: BuiltAggregate<State> = aggregate;
const named: BuiltAggregateResult<State, 'ordinary'> = aggregate;
const literal: 'ordinary' = aggregate.aggregateType;
// @ts-expect-error Canonical command payloads remain constrained.
aggregate.commandCreators.change({ count: 'wrong' });
const sourceBuilder = createAggregate('source', { count: 0 }).events({ changed(_state, _event: Event<number>) {} });
const sourcePlugin = createAggregatePluginFor(sourceBuilder.build(), 'audit').state(() => ({}))
  .events({ changed(_state, event) { event.payload.toFixed(2); } }).build();
const incompatible = createAggregate('incompatible', { count: 0 }).extends(sourceBuilder).plugins(sourcePlugin)
  .events({ changed(_state, _event: Event<string>) {} });
// @ts-expect-error Naming the return type cannot bypass build validation.
const invalid: ReturnType<typeof incompatible.build> = incompatible.build();
throw Error('APPLICATION_EXECUTED');`;

export function buildResultRegressions(consumer, command, bin) {
  const directory = join(consumer, 'build-result');
  mkdirSync(directory);
  for (const extension of ['mts', 'cts']) writeFileSync(join(directory, `input.${extension}`), source);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [],
    declaration: true, emitDeclarationOnly: true, outDir: './public',
  }, files: ['./input.mts', './input.cts'] }));
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'build-result/tsconfig.json']));
  writeFileSync(join(directory, 'extract.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [],
  }, include: ['./*.mts', './*.cts', './*.ts', './public/*'] }));
  for (const extension of ['mts', 'cts']) {
    const declaration = readFileSync(join(directory, `public/input.d.${extension}`), 'utf8');
    assert.match(declaration, /const aggregate: (?:import\("@redemeine\/aggregate"\)\.)?BuiltAggregateResult</);
  }
  console.log(command('node', ['--input-type=module', '-e', provenanceCheck]));
  for (const entry of ['input.mts', 'input.cts', 'public/input.d.mts', 'public/input.d.cts']) {
    for (const format of ['zod', 'json-schema']) console.log(command(bin, ['extract-schemas',
      '--entry', `build-result/${entry}`, '--export', 'aggregate', '--tsconfig', 'build-result/extract.json',
      '--format', format, '--out', `build-result/output.${format === 'zod' ? 'ts' : 'json'}`]));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ version: 1, tsconfig: './extract.json',
      discover: [{ kind: 'aggregate', entry: `./${entry}` }] }));
    console.log(command(bin, ['extract-schema-registries', '--manifest', 'build-result/manifest.json', '--out', 'build-result/registry.ts']));
    console.log(command('npx', ['--no-install', 'tsc', '-p', 'build-result/extract.json', '--noEmit']));
  }
  console.log(command('node', ['--input-type=module', '-e', runtimeCheck]));
  forgedMarkers(directory, command, bin);
}

function forgedMarkers(directory, command, bin) {
  const shape = `interface BuiltAggregateResult extends Omit<typeof original, '__stateType' | 'apply'> {
    readonly __stateType?: NonNullable<typeof original.__stateType>;
    apply: typeof original.apply;
  }`;
  const localImport = `import { aggregate as original } from './input.mjs';`;
  writeFileSync(join(directory, 'foreign.ts'), `${localImport} export ${shape}`);
  mkdirSync(join(directory, 'node_modules/foreign'), { recursive: true });
  writeFileSync(join(directory, 'node_modules/foreign/package.json'), JSON.stringify({ name: 'foreign', types: './index.d.ts' }));
  writeFileSync(join(directory, 'node_modules/foreign/index.d.ts'),
    `import { aggregate as original } from '../../input.mjs'; export ${shape}`);
  for (const [name, source] of [
    ['local', `${localImport} ${shape}\nexport declare const aggregate: BuiltAggregateResult;`],
    ['module', `import type { BuiltAggregateResult } from './foreign'; export declare const aggregate: BuiltAggregateResult;`],
    ['package', `import type { BuiltAggregateResult } from 'foreign'; export declare const aggregate: BuiltAggregateResult;`],
    ['class', `${localImport}
      declare const Base: new () => Omit<typeof original, '__stateType' | 'apply'>;
      declare class BuiltAggregateResult extends Base {
        readonly __stateType?: NonNullable<typeof original.__stateType>; apply: typeof original.apply;
      } export declare const aggregate: BuiltAggregateResult;`],
    ['broader', `import { aggregate as original } from './input.mjs';
      interface Broader extends Omit<typeof original, 'initialState'> {
        initialState: { readonly count: number; readonly at: typeof original.initialState.at;
          readonly nullable: string | null; readonly optional?: string; readonly extra?: string };
      } export declare const aggregate: Broader;`],
  ]) {
    writeFileSync(join(directory, 'forged.ts'), source);
    console.log(command('npx', ['--no-install', 'tsc', '-p', 'build-result/extract.json', '--noEmit']));
    for (const format of ['zod', 'json-schema']) {
      writeFileSync(join(directory, 'sentinel'), 'sentinel');
      assert.throws(() => command(bin, ['extract-schemas', '--entry', 'build-result/forged.ts', '--export', 'aggregate',
        '--tsconfig', 'build-result/extract.json', '--format', format, '--out', 'build-result/sentinel']),
      error => /noncanonical|incompatible schema views/.test(`${error.message}\n${error.stdout}\n${error.stderr}`), name);
      assert.equal(readFileSync(join(directory, 'sentinel'), 'utf8'), 'sentinel');
    }
  }
  console.log(command('npx', ['--no-install', 'tsc', '-p', 'build-result/extract.json', '--noEmit']));
}

const provenanceCheck = `import assert from 'node:assert/strict';
import ts from 'typescript';
for (const extension of ['mts', 'cts']) {
  const file = 'build-result/public/input.d.' + extension;
  const program = ts.createProgram([file], { strict: true, skipLibCheck: false,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  assert.deepEqual(ts.getPreEmitDiagnostics(program), []);
  const checker = program.getTypeChecker();
  const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file)))
    .find(symbol => symbol.name === 'aggregate');
  const aggregate = checker.getTypeOfSymbol(symbol);
  for (const key of ['__stateType', 'apply']) {
    const declarations = checker.getPropertyOfType(aggregate, key).declarations;
    assert(declarations.length);
    for (const declaration of declarations) {
      assert(ts.isPropertySignature(declaration));
      assert(ts.isInterfaceDeclaration(declaration.parent));
      assert.equal(declaration.parent.name.text, 'BuiltAggregateResult');
      assert(declaration.getSourceFile().fileName.endsWith('/node_modules/@redemeine/aggregate/dist/index.d.' +
        (extension === 'mts' ? 'ts' : 'cts')));
    }
  }
}
console.log('Packed independent ESM/CJS canonical interface provenance PASS');`;

const runtimeCheck = `import assert from 'node:assert/strict';
import ts from 'typescript'; import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function load(name) {
  const output = ts.transpileModule(readFileSync('build-result/' + name + '.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const result = {}; new Function('require', 'exports', output)(require, result); return result;
}
const standalone = load('output');
const registry = load('registry').aggregateSchemas.get('ordinary');
for (const schema of [standalone.stateSchema, registry.state]) {
  assert(schema.safeParse({ count: 1, at: '2026-01-01T00:00:00Z', nullable: null }).success);
  assert(!schema.safeParse({ count: 'wrong', at: '2026-01-01T00:00:00Z', nullable: null }).success);
  assert(!schema.safeParse({ count: 1, at: 1, nullable: null }).success);
}
for (const schemas of [standalone, registry]) {
  const commands = schemas.commandSchemas ?? schemas.commands;
  const events = schemas.eventSchemas ?? schemas.events;
  assert.deepEqual(Object.keys(commands), ['change']); assert.deepEqual(Object.keys(events), ['changed']);
  assert(commands.change.safeParse({ count: 1 }).success);
  assert(!commands.change.safeParse({ count: 'wrong' }).success);
  assert(events.changed.safeParse({ count: 1 }).success);
  assert(!events.changed.safeParse({ count: 'wrong' }).success);
}
console.log('Packed ordinary emitted model and payload runtime schemas PASS');`;
