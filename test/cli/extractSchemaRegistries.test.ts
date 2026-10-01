import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';
import { z } from 'zod';
import { extractSchemaRegistries, type SchemaRegistrySelection } from '../../src/reflector';
import { plainObject, readSchemaRegistryManifest, validateSelections } from '../../src/cli/schemaRegistryManifest';
import { createProgramFromConfig } from '../../src/cli/extract/aggregateNavigator';
import { navigateRegistries } from '../../src/cli/extract/schemaRegistryNavigator';
import { generateSchemaRegistryOutput } from '../../src/cli/extract/schemaRegistryOutputGenerator';

const fixtures = resolve(__dirname, 'fixtures/registries');
const config = join(fixtures, 'tsconfig.json');
const selections = readSchemaRegistryManifest(join(fixtures, 'manifest.json')).definitions;
let directory: string;
let program: ts.Program;
beforeAll(() => { directory = mkdtempSync(join(fixtures, 'generated-')); program = createProgramFromConfig(config); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function selection(exportName: string, kind: 'aggregate' | 'projection' = 'aggregate', entry = 'definitions.ts', name?: string): SchemaRegistrySelection {
  return { kind, entry: join(fixtures, entry), export: exportName, ...(name === undefined ? {} : { name }) };
}
function generate(definitions = selections): string {
  return generateSchemaRegistryOutput(program.getTypeChecker(), navigateRegistries(program, definitions));
}
function jsonSchema(schema: z.ZodType) { return z.toJSONSchema(schema); }
type Json = ReturnType<typeof jsonSchema>;
type Bundle<T> = { state: T; commands: Record<string, T>; events: Record<string, T> };
interface Registries {
  aggregateSchemas: Map<string, Bundle<z.ZodType>>;
  projectionSchemas: Map<string, z.ZodType>;
  aggregateJsonSchemas: Map<string, Bundle<Json>>;
  projectionJsonSchemas: Map<string, Json>;
}
function evaluate(output: string): Registries {
  const exports = {};
  const js = ts.transpileModule(output, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', js)((name: string) => {
    if (name !== 'zod') throw new Error(`unexpected import ${name}`);
    return { z };
  }, exports);
  return exports as Registries;
}
function strictCompile(output: string, name: string): void {
  const file = join(directory, name);
  writeFileSync(file, output);
  const compiler = ts.createProgram([file], { strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
    noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, esModuleInterop: true });
  expect(ts.getPreEmitDiagnostics(compiler).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
}
const valid = {
  id: 'id', tags: ['one'], strings: { a: 'text' }, numbers: { a: 1 }, finite: { left: true, right: false },
  nullable: null, variant: { kind: 'ok', value: 1 }, '__@business': 'safe', 'escaped"\\key': 2, _business: 'safe',
};

test('strict source and generated code compile; four maps validate every entry and aggregate bundle member', () => {
  expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  const output = generate();
  strictCompile(output, 'all.ts');
  const maps = evaluate(output);
  expect(Object.keys(maps).sort()).toEqual(['aggregateJsonSchemas', 'aggregateSchemas', 'projectionJsonSchemas', 'projectionSchemas']);
  expect([...maps.aggregateSchemas.keys()]).toEqual(['counter', 'orders']);
  expect([...maps.projectionSchemas.keys()]).toEqual(['orders', 'primitive']);
  const orders = maps.aggregateSchemas.get('orders')!;
  const counter = maps.aggregateSchemas.get('counter')!;
  for (const schema of [orders.state, orders.commands.register!, orders.events.registered!, maps.projectionSchemas.get('orders')!]) {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.parse(valid)).toMatchObject({ '__@business': 'safe' });
    expect(schema.safeParse({ ...valid, optional: { values: [{ label: 'yes', active: true }] }, date: '2026-01-01' }).success).toBe(true);
    for (const invalid of [{ id: 1 }, { tags: [1] }, { strings: { a: 1 } }, { numbers: { a: '1' } }, { finite: { left: true } },
      { nullable: 1 }, { variant: { kind: 'bad' } }, { optional: { values: [{ label: 1 }] } }, { '__@business': 1 }, { 'escaped"\\key': 'bad' }]) {
      expect(schema.safeParse({ ...valid, ...invalid }).success).toBe(false);
    }
  }
  expect(counter.state.safeParse({ count: 1 }).success).toBe(true);
  expect(counter.state.safeParse({ count: '1' }).success).toBe(false);
  for (const schema of [counter.commands.count!, counter.events.counted!, maps.projectionSchemas.get('primitive')!]) {
    expect(schema.safeParse(1).success).toBe(true);
    expect(schema.safeParse('1').success).toBe(false);
  }
  expect(output).not.toMatch(/handlerOnly|lastCommit|checkpoint|z.any\(|import.*Advanced/);
});

test('JSON schemas derive from identical Zod schemas and unqualified handler keys', () => {
  const maps = evaluate(generate());
  for (const [name, bundle] of maps.aggregateSchemas) {
    const json = maps.aggregateJsonSchemas.get(name)!;
    expect(json.state).toEqual(z.toJSONSchema(bundle.state));
    for (const key of ['commands', 'events'] as const) {
      expect(Object.keys(json[key])).toEqual(Object.keys(bundle[key]));
      for (const [handler, schema] of Object.entries(bundle[key])) expect(json[key][handler]).toEqual(z.toJSONSchema(schema));
    }
  }
  for (const [name, schema] of maps.projectionSchemas) expect(maps.projectionJsonSchemas.get(name)).toEqual(z.toJSONSchema(schema));
  const orders = maps.aggregateJsonSchemas.get('orders')!;
  expect(Object.keys(orders.commands)).toEqual(['register']);
  expect(Object.keys(orders.events)).toEqual(['registered']);
  expect(orders.state).toMatchObject({ type: 'object', properties: {
    optional: { type: 'object', properties: { values: { type: 'array' } } },
    strings: { additionalProperties: { type: 'string' } }, numbers: { additionalProperties: { type: 'number' } },
    finite: { required: ['left', 'right'] }, nullable: { anyOf: expect.arrayContaining([{ type: 'null' }]) },
    variant: { anyOf: expect.any(Array) }, '__@business': { type: 'string' }, 'escaped"\\key': { type: 'number' },
  }, required: expect.arrayContaining(['id', '__@business']) });
  expect(orders.state.required).not.toContain('optional');
  expect(maps.projectionJsonSchemas.get('primitive')).toMatchObject({ type: 'number' });
});

test('selection aliases/defaults, explicit dynamic mapping, inferred state, literal names, escaped names and determinism', () => {
  expect(generate([...selections].reverse())).toBe(generate());
  expect(generate([selection('stableA', 'aggregate', 'unsupported.ts')])).toBe(generate([selection('stableB', 'aggregate', 'unsupported.ts')]));
  expect(generate([selection('aliasedOrders', 'aggregate', 'barrel.ts')])).toBe(generate([selection('orders')]));
  expect(generate([selection('default', 'aggregate', 'barrel.ts')])).toBe(generate([selection('orders')]));
  expect(generate([selection('aliasedPrimitive', 'projection', 'barrel.ts', 'primitive')])).toBe(generate([selection('primitive', 'projection', 'definitions.ts', 'primitive')]));
  const definitions = [selection('dynamic', 'aggregate', 'definitions.ts', 'odd"\\\nname'),
    selection('literalProjection', 'projection'), selection('inferred', 'projection', 'definitions.ts', 'inferred'),
    selection('protoHandler', 'aggregate', 'unsupported.ts', 'counter')];
  const output = generate(definitions);
  strictCompile(output, 'names.ts');
  const maps = evaluate(output);
  expect(maps.aggregateSchemas.get('odd"\\\nname')!.state.safeParse({ count: 1 }).success).toBe(true);
  const prototypeKey = '__proto__';
  expect(maps.aggregateSchemas.get('counter')!.commands[prototypeKey]!.safeParse(1).success).toBe(true);
  expect(maps.aggregateJsonSchemas.get('counter')!.commands[prototypeKey]).toMatchObject({ type: 'number' });
  expect(maps.projectionSchemas.get('literal')!.safeParse(1).success).toBe(true);
  expect(maps.projectionSchemas.get('inferred')!.safeParse({ id: 'id', total: 1 }).success).toBe(true);
  expect(maps.projectionSchemas.get('inferred')!.safeParse({ id: 1, total: 1 }).success).toBe(false);
});

test('empty registries and legitimately empty handlers are explicitly typed and compile', () => {
  const output = generate([]);
  strictCompile(output, 'empty.ts');
  for (const map of Object.values(evaluate(output))) expect(map.size).toBe(0);
  const empty = evaluate(generate([selection('emptyAggregate', 'aggregate', 'unsupported.ts')])).aggregateSchemas.get('counter')!;
  expect(empty.commands).toEqual({});
  expect(empty.events).toEqual({});
  const scalar = evaluate(generate([selection('scalar')])).aggregateSchemas.get('scalar')!;
  expect(scalar.state.safeParse(1).success).toBe(true);
  expect(scalar.state.safeParse('1').success).toBe(false);
  expect(evaluate(generate([selection('unionName', 'aggregate', 'definitions.ts', 'explicit')])).aggregateSchemas.has('explicit')).toBe(true);
});

const failures: SchemaRegistrySelection[][] = [
  ...['badState', 'badCommand', 'voidCommand', 'anyCommand', 'badEvent', 'missingPayload', 'missingEvent', 'genericCommand',
    'overloadedCommand', 'optionalCommand', 'indexedCommands', 'builder', 'tupleCommand', 'intersectionEvent', 'unresolvedIdentity'].map((name) => [selection(name, 'aggregate', 'unsupported.ts')]),
  [selection('badProjection', 'projection', 'unsupported.ts', 'bad')],
  [selection('primitive', 'aggregate', 'definitions.ts', 'primitive')],
  [selection('orders', 'projection', 'definitions.ts', 'orders')],
  [selection('missing')], [selection('dynamic')], [selection('unionName')], [selection('primitive', 'projection')],
  [selection('orders', 'aggregate', 'definitions.ts', 'wrong')],
  [selection('orders'), selection('aliasedOrders', 'aggregate', 'barrel.ts')],
  [selection('literalProjection', 'projection', 'definitions.ts', 'wrong')],
  [selection('primitive', 'projection', 'definitions.ts', 'primitive'), selection('aliasedPrimitive', 'projection', 'barrel.ts', 'primitive')],
];
test.each(failures.map((definitions) => [definitions]))('rejects invalid final selection without creating/overwriting %j', (definitions) => {
  const outFile = join(directory, 'failure.ts');
  rmSync(outFile, { force: true });
  const options = { tsconfig: config, outFile, definitions: [selection('view', 'projection', 'definitions.ts', 'safe'), ...definitions] };
  expect(() => extractSchemaRegistries(options)).toThrow();
  expect(existsSync(outFile)).toBe(false);
  writeFileSync(outFile, 'sentinel');
  expect(() => extractSchemaRegistries(options)).toThrow();
  expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
});

test('strictNullChecks required; API writes only after validation', () => {
  const loose = join(directory, 'loose.json');
  writeFileSync(loose, JSON.stringify({ extends: config, compilerOptions: { strictNullChecks: false } }));
  const outFile = join(directory, 'api.ts');
  expect(() => extractSchemaRegistries({ tsconfig: loose, outFile, definitions: selections })).toThrow(/strictNullChecks/);
  expect(existsSync(outFile)).toBe(false);
  extractSchemaRegistries({ tsconfig: config, outFile, definitions: selections });
  expect(readFileSync(outFile, 'utf8')).toBe(generate());
  writeFileSync(outFile, 'sentinel');
  expect(() => extractSchemaRegistries({ tsconfig: config, outFile, definitions: selections, ...{ extra: true } })).toThrow(/unknown field/);
  expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
});

test.each([null, {}, 'bad', [{ kind: 'wrong' }], [{ kind: 'aggregate', entry: '', export: 'a' }],
  [{ kind: 'aggregate', entry: 'a', export: 'a', name: '' }], [{ kind: 'aggregate', entry: 'a', export: 'a', extra: true }]])
('strictly rejects invalid definitions %j', (value) => expect(() => validateSelections(value)).toThrow());

test('API data objects reject hidden/unknown fields and accessors without evaluation', () => {
  const hidden = Object.defineProperty({}, 'extra', { value: true });
  expect(() => plainObject(hidden, [], 'input')).toThrow(/unknown field/);
  expect(() => plainObject({ [Symbol('extra')]: true }, [], 'input')).toThrow(/unknown field/);
  const getter = jest.fn(() => 'source evaluation');
  const accessor = Object.defineProperty({}, 'entry', { get: getter });
  expect(() => plainObject(accessor, ['entry'], 'input')).toThrow(/data property/);
  expect(getter).not.toHaveBeenCalled();
});
