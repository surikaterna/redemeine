import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';
import { z } from 'zod';
import { extractProjectionSchemas } from '../../src/reflector';
import { createProgramFromConfig } from '../../src/cli/extract/aggregateNavigator';
import { resolveProjectionState } from '../../src/cli/extract/projectionNavigator';
import { ProjectionTypeConverter } from '../../src/cli/extract/projectionTypeConverter';
import { generateProjectionOutput } from '../../src/cli/extract/projectionOutputGenerator';

const fixtures = resolve(__dirname, 'fixtures/projection');
const config = join(fixtures, 'tsconfig.json');
let directory: string;
let program: ts.Program;
beforeAll(() => {
  directory = mkdtempSync(join(fixtures, 'generated-'));
  program = createProgramFromConfig(config);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function generate(exportName: string, entry = 'test-projection.ts'): string {
  const type = resolveProjectionState(program, join(fixtures, entry), exportName);
  const converter = new ProjectionTypeConverter(program.getTypeChecker());
  return generateProjectionOutput(converter.convert(type, `${exportName}.initialState`));
}

function evaluate(output: string): { stateSchema: z.ZodType; stateJsonSchema: Record<string, unknown> } {
  const js = ts.transpileModule(output, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('require', 'exports', js)((name: string) => {
    if (name !== 'zod') throw new Error(`Unexpected generated import ${name}`);
    return { z };
  }, exports);
  return exports as { stateSchema: z.ZodType; stateJsonSchema: Record<string, unknown> };
}

const valid = {
  id: 'id', tags: ['one'], strings: { a: 'value' }, numbers: { a: 1 }, finite: { left: true, right: false },
  nullable: null, variant: { kind: 'ok', value: 1 }, _business: 'kept', 'escaped"\\key': 2, __business: 'kept', '__@business': 'kept'
};

test('generated advanced module compiles strictly and parses complete business contracts', () => {
  const output = generate('advancedProjection');
  const file = join(directory, 'schemas.ts');
  writeFileSync(file, output);
  const compiler = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, esModuleInterop: true });
  expect(ts.getPreEmitDiagnostics(compiler).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  const { stateSchema, stateJsonSchema } = evaluate(output);
  expect(stateSchema.safeParse(valid).success).toBe(true);
  expect(stateSchema.parse(valid)).toMatchObject({ '__@business': 'kept' });
  expect(stateSchema.safeParse({ ...valid, optional: { values: [{ label: 'yes', active: true }] }, date: '2026-01-01' }).success).toBe(true);
  expect(stateSchema.safeParse({ ...valid, nullable: 'yes', variant: { kind: 'error', message: 'bad' } }).success).toBe(true);
  expect(stateJsonSchema).toMatchObject({ type: 'object', properties: {
    optional: { type: 'object', properties: { values: { type: 'array' } } },
    strings: { type: 'object', additionalProperties: { type: 'string' } },
    numbers: { type: 'object', additionalProperties: { type: 'number' } },
    _business: { type: 'string' }, '__@business': { type: 'string' }, variant: { anyOf: expect.any(Array) }
  }, required: expect.arrayContaining(['id', 'finite', '_business', '__business', '__@business']) });
  expect(stateJsonSchema.required).not.toContain('optional');
  expect(output).not.toMatch(/z.any\(|typeof .*Schema|import.*Dictionary/);
});

test.each([
  { id: 3 }, { tags: [3] }, { strings: { a: 3 } }, { numbers: { a: '3' } }, { finite: { left: true } },
  { nullable: 4 }, { variant: { kind: 'other', value: 1 } }, { optional: { values: [{ label: 1 }] } },
  { optional: { values: [null] } }, { _business: 3 }, { 'escaped"\\key': 'bad' }, { '__@business': 3 }, { date: new Date() }
])('rejects invalid advanced document %j', (change) => {
  expect(evaluate(generate('advancedProjection')).stateSchema.safeParse({ ...valid, ...change }).success).toBe(false);
});

test.each(['implicitProjection', 'runtimeProjection', 'commitProjection', 'mirrorProjection', 'handlerProjection'])
('resolves built state for %s without handlers or storage metadata', (name) => {
  const output = generate(name);
  expect(output).not.toMatch(/handlerOnly|aggregateId|lastCommit|checkpoint|deduplication/);
  const values: Record<string, object> = { implicitProjection: { id: 'id', count: 1 }, mirrorProjection: { mirrored: 'yes' } };
  expect(evaluate(output).stateSchema.safeParse(values[name] ?? { value: 1 }).success).toBe(true);
});

test('resolves reexport aliases and primitive/nullable roots', () => {
  expect(generate('aliasedProjection', 'reexport.ts')).toBe(generate('advancedProjection'));
  const primitive = evaluate(generate('primitiveProjection')).stateSchema;
  expect(primitive.safeParse(2).success).toBe(true);
  expect(primitive.safeParse('2').success).toBe(false);
  const nullable = evaluate(generate('nullableProjection'));
  expect(nullable.stateSchema.safeParse(null).success).toBe(true);
  expect(nullable.stateSchema.safeParse({ value: 1 }).success).toBe(true);
  expect(nullable.stateSchema.safeParse({ value: '1' }).success).toBe(false);
  expect(nullable.stateJsonSchema).toMatchObject({ anyOf: expect.arrayContaining([{ type: 'null' }]) });
});

test.each([
  ['publicDefinition', true, 'wrong'], ['runtimeDefinition', 'yes', 1], ['commitDefinition', 1, 'wrong']
])('navigates built declaration exports %s', (name, value, wrong) => {
  const output = generate(String(name), 'built-projections.d.ts');
  const { stateSchema, stateJsonSchema } = evaluate(output);
  expect(stateSchema.safeParse({ built: value }).success).toBe(true);
  expect(stateSchema.safeParse({ built: wrong }).success).toBe(false);
  expect(stateJsonSchema).toMatchObject({ type: 'object', required: ['built'] });
});

test('all supported generated artifacts compile together under strict compiler options', () => {
  const names = ['implicitProjection', 'advancedProjection', 'runtimeProjection', 'commitProjection', 'mirrorProjection',
    'handlerProjection', 'primitiveProjection', 'nullableProjection'];
  const files = names.map((name) => {
    const file = join(directory, `${name}.ts`);
    writeFileSync(file, generate(name));
    return file;
  });
  const compiler = ts.createProgram(files, { strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
    noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, esModuleInterop: true });
  expect(ts.getPreEmitDiagnostics(compiler).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
});

test.each(['unknownState', 'anyState', 'undefinedState', 'undefinedOptional', 'functionState', 'tupleState', 'mixedState',
  'numericState', 'symbolState', 'computedSymbolState', 'mappedSymbolState', 'wellKnownSymbolState',
  'intersectionState', 'promiseState', 'cycleState', 'classState', 'unresolvedState',
  'prototypeState', 'emptyState', 'infiniteState', 'unresolvedBaseState', 'deepState', 'arrayUndefinedState', 'optionalFactory',
  'aggregateValue', 'overloadedFactory', 'genericFactory'])('rejects %s before creating or overwriting output', (name) => {
  const outFile = join(directory, `${name}.ts`);
  const options = { tsconfig: config, entry: join(fixtures, 'unsupported.ts'), projectionExport: name, outFile };
  expect(() => extractProjectionSchemas(options)).toThrow(new RegExp(`${name}\\.initialState`));
  expect(existsSync(outFile)).toBe(false);
  writeFileSync(outFile, 'preserve me');
  expect(() => extractProjectionSchemas(options)).toThrow();
  expect(readFileSync(outFile, 'utf8')).toBe('preserve me');
});

test('rejects unbuilt/missing exports and non-strict configuration; API writes deterministic artifact', () => {
  expect(() => generate('unbuilt')).toThrow(/built projection/);
  expect(() => generate('missing')).toThrow(/not found/);
  const loose = join(directory, 'loose.json');
  writeFileSync(loose, JSON.stringify({ extends: config, compilerOptions: { strictNullChecks: false } }));
  const outFile = join(directory, 'api.ts');
  const options = { tsconfig: loose, entry: join(fixtures, 'test-projection.ts'), projectionExport: 'implicitProjection', outFile };
  expect(() => extractProjectionSchemas(options)).toThrow(/strictNullChecks/);
  expect(existsSync(outFile)).toBe(false);
  extractProjectionSchemas({ ...options, tsconfig: config });
  expect(readFileSync(outFile, 'utf8')).toBe(generate('implicitProjection'));
});
