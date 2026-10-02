import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as ts from 'typescript';
import { z } from 'zod';
import { extractSchemaRegistries, type ExtractSchemaRegistriesOptions, type SchemaRegistryDiscovery, type SchemaRegistrySelection } from '../../src/reflector';
import { readSchemaRegistryManifest, registryInputs, validateDiscovery } from '../../src/cli/schemaRegistryManifest';
import { createProgramFromConfig } from '../../src/cli/extract/aggregateNavigator';
import { discoverRegistrySelections } from '../../src/cli/extract/schemaRegistryDiscovery';
import { navigateRegistries } from '../../src/cli/extract/schemaRegistryNavigator';
import { generateSchemaRegistryOutput } from '../../src/cli/extract/schemaRegistryOutputGenerator';

const fixtures = resolve(__dirname, 'fixtures/registries/discovery');
const manifest = readSchemaRegistryManifest(join(fixtures, 'manifest.json'));
let directory: string;
let program: ts.Program;
beforeAll(() => { directory = mkdtempSync(join(fixtures, 'generated-')); program = createProgramFromConfig(manifest.tsconfig); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function discover(kind: 'aggregate' | 'projection', entry = 'mixed.ts', extra = {}): SchemaRegistryDiscovery {
  return { kind, entry: join(fixtures, entry), ...extra };
}
function selection(exportName: string, kind: 'aggregate' | 'projection' = 'aggregate', name?: string): SchemaRegistrySelection {
  return { kind, entry: join(fixtures, 'mixed.ts'), export: exportName, ...(name === undefined ? {} : { name }) };
}
function generate(discoveries = manifest.discover, definitions: SchemaRegistrySelection[] = [], compiler = program): string {
  const selections = discoverRegistrySelections(compiler, definitions, discoveries);
  return generateSchemaRegistryOutput(compiler.getTypeChecker(), navigateRegistries(compiler, selections));
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
  const js = ts.transpileModule(output, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'exports', js)((name: string) => {
    if (name !== 'zod') throw new Error(`unexpected generated import ${name}`);
    return { z };
  }, exports);
  return exports as Registries;
}
test('four deterministic strict artifacts validate every included aggregate member and projection, generated code only', () => {
  const output = generate();
  const file = join(directory, 'all.ts');
  writeFileSync(file, output);
  const compiler = ts.createProgram([file], { strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
    noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, esModuleInterop: true });
  expect(ts.getPreEmitDiagnostics(compiler).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  const maps = evaluate(output);
  expect([...maps.aggregateSchemas.keys()]).toEqual(['account', 'union']);
  const union = maps.aggregateSchemas.get('union')!;
  expect(union.state.safeParse({ kind: 'text', text: 'yes' }).success).toBe(true);
  expect(union.state.safeParse({ kind: 'number', value: 1 }).success).toBe(true);
  expect(union.state.safeParse({ kind: 'number', value: '1' }).success).toBe(false);
  expect(union.commands).toEqual({});
  expect(union.events).toEqual({});
  expect(maps.aggregateJsonSchemas.get('union')!.state).toEqual(z.toJSONSchema(union.state));
  const account = maps.aggregateSchemas.get('account')!;
  for (const [schema, positive, negative] of [[account.state, { total: 1 }, { total: '1' }],
    [account.commands.add!, 1, '1'], [account.events.added!, 1, '1']] as const) {
    expect(schema.safeParse(positive).success).toBe(true);
    expect(schema.safeParse(negative).success).toBe(false);
  }
  const examples = { annotation: [{ flag: true }, { flag: 1 }], cast: [{ cast: 'yes' }, { cast: false }],
    mirror: [{ total: 1 }, { total: '1' }], public: [{ id: 'id', active: true }, { id: 1, active: true }],
    'public-commit': [{ labels: ['yes'] }, { labels: [1] }], runtime: [{ count: 1 }, { count: '1' }],
    'runtime-commit': [{ optional: null }, { optional: 1 }] };
  expect([...maps.projectionSchemas.keys()]).toEqual(Object.keys(examples).sort());
  for (const [name, [positive, negative]] of Object.entries(examples)) {
    const schema = maps.projectionSchemas.get(name)!;
    expect(schema.safeParse(positive).success).toBe(true);
    expect(schema.safeParse(negative).success).toBe(false);
    expect(maps.projectionJsonSchemas.get(name)).toEqual(z.toJSONSchema(schema));
  }
  const json = maps.aggregateJsonSchemas.get('account')!;
  expect(json.state).toEqual(z.toJSONSchema(account.state));
  expect(json.commands.add).toEqual(z.toJSONSchema(account.commands.add!));
  expect(json.events.added).toEqual(z.toJSONSchema(account.events.added!));
});

test('alias/default/barrel and explicit overlap dedup; widened names shared across canonical routes', () => {
  const discovery = [discover('aggregate'), discover('aggregate', 'barrel.ts')];
  expect(generate(discovery)).toBe(generate(discovery, [selection('account')]));
  expect(generate(discovery)).toBe(generate([discover('aggregate', 'barrel.ts', { exclude: ['account', 'accountAlias'] })]));
  expect(generate([discover('projection', 'mixed.ts', { exclude: ['annotation', 'cast', 'mirror', 'publicCommit', 'runtimeCommit', 'runtimeView'], names: { publicAlias: 'public' } })]))
    .toBe(generate([], [selection('publicView', 'projection', 'public')]));
  expect(generate([discover('projection', 'mixed.ts', { exclude: ['annotation', 'cast', 'mirror', 'publicCommit', 'runtimeCommit', 'runtimeView'] })],
    [selection('publicView', 'projection', 'public')])).toContain('public');
  expect(generate([discover('aggregate', 'mixed.ts', { exclude: ['account', 'accountAlias', 'default', 'unionAggregate'] })], [selection('account')]))
    .toBe(generate([], [selection('account')]));
});

test('reordered entries, aliases and name mappings are byte identical; no eligible values emits empty maps', () => {
  expect(generate([...manifest.discover].reverse())).toBe(generate());
  const projection = manifest.discover[1]!;
  expect(generate([discover('aggregate', 'barrel.ts'), { ...projection,
    names: Object.fromEntries(Object.entries(projection.names!).reverse()) }])).toBe(generate());
  expect(evaluate(generate([discover('aggregate', 'types.ts')])).aggregateSchemas.size).toBe(0);
});

const badDiscovery = [
  discover('aggregate', 'mixed.ts', { exclude: ['missing'] }),
  ...['scalar', 'nearAggregate', 'publicView', 'AccountType'].map((name) => discover('aggregate', 'mixed.ts', { exclude: [name] })),
  ...['missing', 'scalar', 'account', 'Shape'].map((name) => discover('projection', 'mixed.ts', { names: { [name]: 'wrong' } })),
  discover('projection', 'mixed.ts', { exclude: ['publicView'], names: { publicView: 'public' } }),
  discover('aggregate', 'mixed.ts', { names: { account: 'wrong' } }),
  discover('projection'),
  discover('projection', 'mixed.ts', { names: { publicView: 'one', publicAlias: 'two' } }),
  discover('aggregate', 'missing.ts'),
];
test.each(badDiscovery)('invalid config preserves absent and sentinel outputs %j', (discovery) => {
  const outFile = join(directory, 'failure.ts');
  rmSync(outFile, { force: true });
  const options = { tsconfig: manifest.tsconfig, outFile, discover: [discovery] };
  expect(() => extractSchemaRegistries(options)).toThrow();
  expect(existsSync(outFile)).toBe(false);
  writeFileSync(outFile, 'sentinel');
  expect(() => extractSchemaRegistries(options)).toThrow();
  expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
});

test('explicit duplicates not masked and conflicting explicit-discovery names fail', () => {
  expect(() => generate([discover('aggregate')], [selection('account'), selection('accountAlias')])).toThrow(/duplicate explicit/);
  expect(() => generate([discover('projection', 'mixed.ts', { names: { publicView: 'public' } })],
    [selection('publicView', 'projection', 'wrong')])).toThrow(/conflicting names/);
});

test('recognized unsupported candidates are eligible for exclusion; copies and separate calls are not deduped', () => {
  const compiler = createProgramFromConfig(join(fixtures, 'unsupported.json'));
  const aggregateNames = ['badState', 'badCommand', 'badEvent', 'copy', 'separate', 'mutableAlias', 'mutableSnapshot', 'opaque'];
  const projectionNames = ['badProjection', 'erased', 'malformed', 'ambiguous'];
  for (const [kind, names] of [['aggregate', aggregateNames], ['projection', projectionNames]] as const) {
    expect(() => generate([discover(kind, 'unsupported.ts', { exclude: names })], [], compiler)).not.toThrow();
    for (const name of names) {
      const discovery = discover(kind, 'unsupported.ts', { exclude: names.filter((item) => item !== name), names: kind === 'projection' ? { [name]: name } : {} });
      if (['copy', 'separate', 'mutableAlias', 'mutableSnapshot', 'opaque'].includes(name)) {
        expect(() => generate([discover('aggregate'), discovery], [], compiler)).toThrow(/duplicate/);
      } else expect(() => generate([discovery], [], compiler)).toThrow();
    }
  }
});

test.each(['badState', 'badCommand', 'badEvent', 'badProjection', 'erased', 'malformed', 'ambiguous'])
('recognized invalid final candidate %s never creates directories or overwrites sentinel', (name) => {
  const kind = ['badState', 'badCommand', 'badEvent'].includes(name) ? 'aggregate' : 'projection';
  const all = kind === 'aggregate' ? ['badState', 'badCommand', 'badEvent', 'copy', 'separate', 'mutableAlias', 'mutableSnapshot', 'opaque'] :
    ['badProjection', 'erased', 'malformed', 'ambiguous'];
  const outFile = join(directory, 'absent', 'failure.ts');
  rmSync(join(directory, 'absent'), { recursive: true, force: true });
  const options = { tsconfig: join(fixtures, 'unsupported.json'), outFile,
    discover: [discover(kind, 'unsupported.ts', { exclude: all.filter((item) => item !== name), names: kind === 'projection' ? { [name]: name } : {} })] };
  expect(() => extractSchemaRegistries(options)).toThrow();
  expect(existsSync(join(directory, 'absent'))).toBe(false);
  const existing = join(directory, 'sentinel.ts');
  writeFileSync(existing, 'sentinel');
  expect(() => extractSchemaRegistries({ ...options, outFile: existing })).toThrow();
  expect(readFileSync(existing, 'utf8')).toBe('sentinel');
});

test.each([undefined, null, {}, [{ kind: 'wrong', entry: 'a' }], [{ kind: 'aggregate', entry: 'a', exclude: ['x', 'x'] }],
  [{ kind: 'aggregate', entry: 'a', names: { a: '' } }], [{ kind: 'aggregate', entry: 'a', names: [] }],
  [{ kind: 'aggregate', entry: 'a', exclude: undefined }]])('strict discovery data validation %j', (value) => {
  expect(() => validateDiscovery(value)).toThrow();
});
test('own definitions/discover arrays required; getters never run; prototype keys preserved', () => {
  expect(() => registryInputs({})).toThrow();
  expect(() => registryInputs({ definitions: undefined, discover: [] })).toThrow();
  expect(registryInputs({ discover: [] })).toEqual({ definitions: [], discover: [] });
  const getter = jest.fn();
  const names = Object.defineProperty({}, 'account', { get: getter });
  expect(() => validateDiscovery([{ kind: 'aggregate', entry: 'a', names }])).toThrow(/data property/);
  expect(getter).not.toHaveBeenCalled();
  const hiddenNames = Object.defineProperty({}, 'account', { value: 'account' });
  expect(() => validateDiscovery([{ kind: 'aggregate', entry: 'a', names: hiddenNames }])).toThrow(/hidden/);
  const accessors = Object.defineProperty(['account'], '0', { get: getter });
  expect(() => validateDiscovery([{ kind: 'aggregate', entry: 'a', exclude: accessors }])).toThrow(/data property/);
  expect(getter).not.toHaveBeenCalled();
  const validated = validateDiscovery([{ kind: 'aggregate', entry: 'a', names: JSON.parse('{"__proto__":"safe"}') }]);
  expect(Object.hasOwn(validated[0]!.names!, '__proto__')).toBe(true);
});

function preservesDestination(options: Omit<ExtractSchemaRegistriesOptions, 'outFile'>, error: RegExp): void {
  const parent = join(directory, 'revisions-absent');
  const outFile = join(parent, 'output.ts');
  rmSync(parent, { recursive: true, force: true });
  expect(() => extractSchemaRegistries({ ...options, outFile })).toThrow(error);
  expect(existsSync(parent)).toBe(false);
  const existing = join(directory, 'revisions-sentinel.ts');
  writeFileSync(existing, 'sentinel');
  expect(() => extractSchemaRegistries({ ...options, outFile: existing })).toThrow(error);
  expect(readFileSync(existing, 'utf8')).toBe('sentinel');
}

const malformedNestedAggregates = ['badCreators', 'badCreatorPayload', 'badCommandCreators', 'badMissingCreators', 'badUnresolvedCreator'];
const malformedNestedProjections = ['badStream', 'badSubscriptions', 'badRuntimeStream', 'badRuntimeSubscriptions',
  'badNestedBuiltStream', 'badNestedBuiltSubscriptions', 'badRuntimePick', 'badRuntimeOmitPure', 'badRuntimeOmitState',
  'badRuntimeMissingProjectors', 'badRuntimeJoinAsPrimary', 'badRuntimePublicAsPrimary', 'badPublicPickSource'];
const malformedNested = [...malformedNestedAggregates, ...malformedNestedProjections];
test.each(malformedNested)('malformed nested built candidate %s fails prewrite, but eligible exclusion bypasses validation', (name) => {
  const kind = malformedNestedAggregates.includes(name) ? 'aggregate' : 'projection';
  const names = kind === 'aggregate' ? malformedNestedAggregates : malformedNestedProjections;
  const tsconfig = join(fixtures, 'nestedContracts.json');
  const discovery = discover(kind, 'nestedContracts.ts', { exclude: names.filter((item) => item !== name),
    names: kind === 'projection' ? { [name]: name } : {} });
  preservesDestination({ tsconfig, discover: [discovery] }, /(result|payload mismatch|missing corresponding event creator|genuine aggregate contract reference|required built member)/);
  const compiler = createProgramFromConfig(tsconfig);
  expect(() => generate([discover(kind, 'nestedContracts.ts', { exclude: names })], [], compiler)).not.toThrow();
});

function aliasViewDiscovery(kind: 'aggregate' | 'projection', exportName: string): SchemaRegistryDiscovery {
  const exports = kind === 'aggregate' ? ['broad', 'equivalent', 'equivalentAgain', 'broadCommand'] : ['broadProjection', 'equivalentProjection'];
  return discover(kind, 'aliasViews.ts', { exclude: exports.filter((name) => name !== exportName),
    names: kind === 'projection' ? { [exportName]: 'public' } : {} });
}

test.each(['broad', 'broadCommand', 'broadProjection'])('annotated %s aliases consistently reject incompatible views under reorder and explicit overlap', (name) => {
  const kind = name === 'broadProjection' ? 'projection' : 'aggregate';
  const tsconfig = join(fixtures, 'aliasViews.json');
  const original = kind === 'aggregate' ? discover(kind, 'aliasOriginal.ts') : discover(kind, 'mixed.ts', {
    exclude: ['annotation', 'cast', 'mirror', 'publicCommit', 'runtimeCommit', 'runtimeView'], names: { publicView: 'public' } });
  const broad = aliasViewDiscovery(kind, name);
  for (const discoveries of [[original, broad], [broad, original]]) {
    preservesDestination({ tsconfig, discover: discoveries }, /incompatible schema views/);
  }
  const originalSelection = kind === 'aggregate' ? selection('account') : selection('publicView', 'projection', 'public');
  const broadSelection: SchemaRegistrySelection = { kind, entry: join(fixtures, 'aliasViews.ts'), export: name,
    ...(kind === 'projection' ? { name: 'public' } : {}) };
  preservesDestination({ tsconfig, definitions: [originalSelection], discover: [broad] }, /incompatible schema views/);
  preservesDestination({ tsconfig, definitions: [broadSelection], discover: [original] }, /incompatible schema views/);
});

test('equivalent separately annotated aliases and reordered properties dedup without checker Type identity', () => {
  const compiler = createProgramFromConfig(join(fixtures, 'aliasViews.json'));
  expect(ts.getPreEmitDiagnostics(compiler).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  const original = discover('aggregate', 'aliasOriginal.ts');
  const equivalent = aliasViewDiscovery('aggregate', 'equivalent');
  const equivalentAgain = aliasViewDiscovery('aggregate', 'equivalentAgain');
  const expected = generate([original], [], compiler);
  expect(generate([original, equivalent, equivalentAgain], [], compiler)).toBe(expected);
  expect(generate([equivalentAgain, equivalent, original], [], compiler)).toBe(expected);
  expect(generate([equivalent], [selection('account')], compiler)).toBe(expected);
  const annotated: SchemaRegistrySelection = { kind: 'aggregate', entry: join(fixtures, 'aliasViews.ts'), export: 'equivalent' };
  expect(generate([original], [annotated], compiler)).toBe(expected);
  const projection = aliasViewDiscovery('projection', 'equivalentProjection');
  const projectionExpected = generate([], [selection('publicView', 'projection', 'public')], compiler);
  expect(generate([projection], [selection('publicView', 'projection', 'public')], compiler)).toBe(projectionExpected);
});
