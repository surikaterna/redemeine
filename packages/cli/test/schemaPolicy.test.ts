import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';
import { z, type ZodType } from 'zod';
import { extractZodSchemas } from '../src/extractZodSchemas';
import { schemaPolicyForEntry, validateSchemaPolicy } from '../src/extract/schemaConfig';
import { TypeToZodConverter } from '../src/extract/typeConverter';
import { extractProjectionSchemas } from '../src/extractProjectionSchemas';
import { extractSchemaRegistries } from '../src/extractSchemaRegistries';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(__dirname, '.schema-policy-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function setup(source: string, schemas: unknown = undefined) {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, redemeine: { schemas } }));
    writeFileSync(join(directory, 'input.ts'), source);
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [], esModuleInterop: true,
        paths: { '@redemeine/aggregate': [join(__dirname, '../../aggregate/dist/index.d.ts')] }
    }, include: ['*.ts'] }));
    return { entry: join(directory, 'input.ts'), tsconfig: join(directory, 'tsconfig.json'), aggregateExport: 'aggregate', outFile: join(directory, 'output.ts') };
}

const structural = `import { createAggregate } from '@redemeine/aggregate';
export const aggregate = createAggregate('demo', { value: 0 }).events({})
  .commands(() => ({ change: (_state, payload: { nested: { value: string } }) => [] })).build();`;

test('nearest package owns policy; missing settings default to zod-first and maxDepth 60', () => {
    const options = setup(structural);
    expect(schemaPolicyForEntry(options.entry)).toEqual({ mode: 'zod-first', maxDepth: 60, maxProvenanceDepth: 256 });
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas(options)).toThrow(/no importable Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested/package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'types-first', maxDepth: 4 } } }));
    expect(schemaPolicyForEntry(join(directory, 'nested/source.ts'))).toEqual({ mode: 'types-first', maxDepth: 4, maxProvenanceDepth: 256 });
});

test.each([0, -1, 1.5, 257, '60', null])('invalid maxDepth %j fails configuration', maxDepth => {
    expect(() => validateSchemaPolicy({ maxDepth })).toThrow(/maxDepth/);
});

test('invalid mode and unknown settings fail rather than silently opting out', () => {
    expect(() => validateSchemaPolicy({ mode: 'type-first' })).toThrow(/mode/);
    expect(() => validateSchemaPolicy({ mode: null })).toThrow(/mode/);
    expect(() => validateSchemaPolicy({ depth: 1 })).toThrow(/unknown option/);
});

test.each(['zod', 'json-schema'] as const)('types-first maxDepth is enforced before %s output writes', format => {
    const options = setup(structural, { mode: 'types-first', maxDepth: 1 });
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas({ ...options, format })).toThrow(/maxDepth \(1\)/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    expect(existsSync(join(directory, 'absent'))).toBe(false);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'types-first', maxDepth: 6 } } }));
    expect(() => extractZodSchemas({ ...options, format })).not.toThrow();
});

function authoredSource(plain = false) {
    writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod';
        export const identifier = z.string().min(3);
        export type Identifier = z.infer<typeof identifier>;
        export const changed = z.object({ id: identifier });
        export type Changed = z.infer<typeof changed>;
        export const state = z.object({ id: identifier });
        export type State = z.infer<typeof state>;`);
    return `import { createAggregate } from '@redemeine/aggregate'; import type { Event } from '@redemeine/kernel';
        import type { Identifier, Changed, State } from './schemas';
        export const aggregate = createAggregate<State, 'demo'>('demo', { id: 'old' })
          .events({ changed: (state, event: Event<Changed>) => { state.id = event.payload.id; } })
          .commands(emit => ({ change: (_state, id: Identifier) => emit.changed({ id })${plain ? ', plain: (_state, value: string) => []' : ''} })).build();`;
}

function loadOutput<T = { commandSchemas: Record<string, ZodType>; eventSchemas: Record<string, ZodType>; stateSchema: ZodType }>(): T {
    const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], esModuleInterop: true, noUnusedLocals: true };
    expect(ts.getPreEmitDiagnostics(ts.createProgram([join(directory, 'output.ts')], options))).toEqual([]);
    for (const name of ['schemas', 'output']) {
        writeFileSync(join(directory, `${name}.js`), ts.transpileModule(readFileSync(join(directory, `${name}.ts`), 'utf8'), { compilerOptions: { ...options, module: ts.ModuleKind.CommonJS } }).outputText);
    }
    const requireOutput = createRequire(join(directory, 'output.js'));
    const exported = {};
    new Function('require', 'exports', readFileSync(join(directory, 'output.js'), 'utf8'))(requireOutput, exported);
    return exported as T;
}

test.each(['zod-first', 'types-first'] as const)('%s imports authored schemas including erased primitive aliases', mode => {
    const options = setup(authoredSource(mode === 'types-first'), { mode, maxDepth: 1 });
    extractZodSchemas(options);
    const output = readFileSync(options.outFile, 'utf8');
    expect(output).toContain('from "./schemas"');
    expect(output).not.toContain('z.object(');
    expect(output).not.toContain('.min(');
    if (mode === 'zod-first') expect(output).not.toContain("import { z } from 'zod'");
    const schemas = loadOutput();
    expect(schemas.commandSchemas.change!.safeParse('abc').success).toBe(true);
    expect(schemas.commandSchemas.change!.safeParse('x').success).toBe(false);
    expect(schemas.eventSchemas.changed!.safeParse({ id: 'x' }).success).toBe(false);
    expect(schemas.stateSchema.safeParse({ id: 'x' }).success).toBe(false);
    if (mode === 'types-first') expect(schemas.commandSchemas.plain!.safeParse('x').success).toBe(true);
});

test('types-first refuses private existing schemas and lossy compiler-only JSON export', () => {
    const options = setup(authoredSource(), { mode: 'types-first' });
    expect(() => extractZodSchemas({ ...options, format: 'json-schema' })).toThrow(/existing Zod schema/);
    const source = readFileSync(join(directory, 'schemas.ts'), 'utf8').replace('export const identifier', 'const identifier');
    writeFileSync(join(directory, 'schemas.ts'), source);
    expect(() => extractZodSchemas(options)).toThrow(/portable import/);
});

test('projection and registry entry points link existing schemas under the same package policy', () => {
    const options = setup(authoredSource() + `
        export const view = { name: 'view' as const, fromStream: 'events', identity: {}, subscriptions: [],
          initialState: (): State => { throw new Error('FACTORY_EXECUTED'); } };`);
    extractProjectionSchemas({ ...options, projectionExport: 'view' });
    const projection = loadOutput<{ stateSchema: ZodType; stateJsonSchema: { properties: { id: { minLength: number } } } }>();
    expect(projection.stateSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(projection.stateJsonSchema.properties.id.minLength).toBe(3);
    extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile, definitions: [
        { kind: 'aggregate', entry: options.entry, export: 'aggregate' },
        { kind: 'projection', entry: options.entry, export: 'view' }
    ] });
    const registry = loadOutput<{ aggregateSchemas: Map<string, { commands: Record<string, ZodType> }>;
        aggregateJsonSchemas: Map<string, { commands: Record<string, { minLength: number }> }> }>();
    expect(registry.aggregateSchemas.get('demo')!.commands.change!.safeParse('x').success).toBe(false);
    expect(registry.aggregateJsonSchemas.get('demo')!.commands.change!.minLength).toBe(3);
    expect(readFileSync(options.outFile, 'utf8')).not.toContain('z.object(');
});

test('types-first preserves nested array and tuple schema refinements without leaking to ordinary strings', () => {
    const options = setup(authoredSource() + `
        interface Dictionary { [key: string]: Identifier }
        export const nested = createAggregate('nested', { ids: [] as Identifier[] }).events({})
          .commands(() => ({ accept: (_state, value: { list: readonly Identifier[]; tuple: [Identifier, string]; map: Record<string, Identifier>; named: Dictionary; plain: string }) => [] })).build();`, { mode: 'types-first' });
    extractZodSchemas({ ...options, aggregateExport: 'nested' });
    const { commandSchemas } = loadOutput();
    const good = { list: ['abc'], tuple: ['abc', 'x'], map: { a: 'abc' }, named: { a: 'abc' }, plain: 'x' };
    expect(commandSchemas.accept!.safeParse(good).success).toBe(true);
    expect(commandSchemas.accept!.safeParse({ ...good, list: ['x'] }).success).toBe(false);
    expect(commandSchemas.accept!.safeParse({ ...good, tuple: ['x', 'ok'] }).success).toBe(false);
    expect(commandSchemas.accept!.safeParse({ ...good, map: { a: 'x' } }).success).toBe(false);
    expect(commandSchemas.accept!.safeParse({ ...good, named: { a: 'x' } }).success).toBe(false);
});

test('normalized schema compositions retain member refinements without constraining plain alternatives', () => {
    const options = setup(authoredSource() + `
        type Choice = Identifier | string;
        type Required = Identifier & string;
        export const composed = createAggregate('composed', {}).events({})
          .commands(() => ({ accept: (_state, value: { choice: Choice; required: Required; optional?: Identifier }) => [] })).build();`, { mode: 'types-first' });
    extractZodSchemas({ ...options, aggregateExport: 'composed' });
    const { commandSchemas } = loadOutput();
    expect(commandSchemas.accept!.safeParse({ choice: 'x', required: 'abc' }).success).toBe(true);
    expect(commandSchemas.accept!.safeParse({ choice: 'abc', required: 'x' }).success).toBe(false);
    expect(commandSchemas.accept!.safeParse({ choice: 'x', required: 'abc', optional: 'x' }).success).toBe(false);
    expect(commandSchemas.accept!.safeParse({ choice: 'x', required: 'abc', optional: 'abc' }).success).toBe(true);
});

test.each(['Identifier | string', 'Identifier & string'])('compiler-only JSON rejects normalized schema composition %s', composition => {
    const options = setup(authoredSource() + `
        type Payload = ${composition};
        export const composed = createAggregate('composed', {}).events({})
          .commands(() => ({ accept: (_state, value: Payload) => [] })).build();`, { mode: 'types-first' });
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas({ ...options, aggregateExport: 'composed', format: 'json-schema' })).toThrow(/existing Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test('projection and registry reject lossy normalized compositions before writing', () => {
    const options = setup(authoredSource() + `
        type Required = Identifier & string;
        export const view = { name: 'view' as const, fromStream: 'events', identity: {}, subscriptions: [],
          initialState: (): { id: Required } => ({ id: 'abc' }) };`, { mode: 'types-first' });
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractProjectionSchemas({ ...options, projectionExport: 'view' })).toThrow(/explicit derived Zod schema/);
    expect(() => extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile, definitions: [
        { kind: 'projection', entry: options.entry, export: 'view' }
    ] })).toThrow(/explicit derived Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test('zod-first references authored recursive schemas without expanding them under maxDepth', () => {
    writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod';
        export interface Tree { value: string; next?: Tree }
        export const tree: z.ZodType<Tree> = z.lazy(() => z.object({ value: z.string(), next: tree.optional() }));
        export type TreePayload = z.infer<typeof tree>;`);
    const options = setup(`import { createAggregate } from '@redemeine/aggregate'; import type { TreePayload } from './schemas';
        const initial: TreePayload = { value: 'root' };
        export const aggregate = createAggregate('tree', initial).events({})
          .commands(() => ({ accept: (_state, payload: TreePayload) => [] })).build();`, { maxDepth: 1 });
    extractZodSchemas(options);
    const schemas = loadOutput();
    expect(schemas.commandSchemas.accept!.safeParse({ value: 'a', next: { value: 'b' } }).success).toBe(true);
    expect(schemas.commandSchemas.accept!.safeParse({ value: 'a', next: { value: 3 } }).success).toBe(false);
    expect(schemas.stateSchema).toBe(schemas.commandSchemas.accept);
    expect(readFileSync(options.outFile, 'utf8')).not.toContain('z.lazy');
});

test('containers are supported or diagnosed instead of becoming unrelated object schemas or any', () => {
    const source = join(directory, 'containers.ts');
    writeFileSync(source, `type List = readonly string[]; type Tuple = readonly [string, number?, ...boolean[]];
        type Unknown = unknown; type Recursive = { next: Recursive };
        type Fn = () => string; type Dict = Record<number, string>; type MapValue = Map<string, number>;
        type Pattern = \`payment_\${string}\`; type Missing = DoesNotExist;`);
    const program = ts.createProgram([source], { strict: true, target: ts.ScriptTarget.ES2022, types: [] });
    const checker = program.getTypeChecker();
    const types = new Map(program.getSourceFile(source)!.statements.filter(ts.isTypeAliasDeclaration).map(node => [node.name.text, checker.getTypeAtLocation(node)]));
    const convert = (name: string) => new TypeToZodConverter(checker, program).convert(types.get(name)!);
    const converter = new TypeToZodConverter(checker, program);
    const list = converter.convert(types.get('List')!);
    expect(converter.generatedShared.get(list) ?? list).toBe('z.array(z.string())');
    const tuple = converter.convert(types.get('Tuple')!);
    expect(converter.generatedShared.get(tuple) ?? tuple).toContain('z.tuple(');
    const load = (expression: string): ZodType => new Function('z', `${[...converter.generatedShared].map(([name, code]) => `const ${name} = ${code};`).join('\n')} return ${expression};`)(z);
    expect(load(list).safeParse(['ok']).success).toBe(true);
    expect(load(list).safeParse([1]).success).toBe(false);
    for (const good of [['a'], ['a', 1], ['a', undefined, true], ['a', 1, true, false]]) expect(load(tuple).safeParse(good).success).toBe(true);
    for (const bad of [[1], ['a', 'bad'], ['a', 1, 'bad']]) expect(load(tuple).safeParse(bad).success).toBe(false);
    expect(convert('Unknown')).toBe('z.unknown()');
    expect(() => convert('Recursive')).toThrow(/recursive/);
    expect(() => convert('Missing')).toThrow(/compiler-error/);
    for (const name of ['Fn', 'Dict', 'MapValue', 'Pattern']) expect(() => convert(name)).toThrow(/unsupported|supported|existing Zod/);
});

function provenanceSource(payload: string) {
    const source = authoredSource();
    writeFileSync(join(directory, 'schemas.ts'), readFileSync(join(directory, 'schemas.ts'), 'utf8') + `
        export const key = z.string().min(5); export type Key = z.infer<typeof key>;
        export const value = z.string().max(2); export type Value = z.infer<typeof value>;`);
    return source + `
        import type { Key, Value } from './schemas';
        type Box<T> = { value: T }; interface InterfaceBox<T> { value: T }
        type DefaultBox<T = Identifier> = { value: T };
        interface InheritedBox extends InterfaceBox<Identifier> {}
        type Renamed<T> = Box<T>; type Pair = readonly [Identifier, string?];
        type Payload = ${payload};
        export const target = createAggregate('target', { count: 0 }).events({})
          .commands(() => ({ accept: (_state, value: Payload) => [] })).build();
        export const view = { name: 'view' as const, fromStream: 'events', identity: {}, subscriptions: [],
          initialState: (): Payload => { throw new Error('APPLICATION_EXECUTED'); } };
        throw new Error('APPLICATION_EXECUTED');`;
}

function assertInputDiagnostics(options: ReturnType<typeof setup>) {
    const config = ts.readConfigFile(options.tsconfig, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
    expect(ts.getPreEmitDiagnostics(ts.createProgram([options.entry], parsed.options))).toEqual([]);
}

function provenanceExtract(options: ReturnType<typeof setup>, entry: string) {
    assertInputDiagnostics(options);
    if (entry === 'aggregate') {
        extractZodSchemas({ ...options, aggregateExport: 'target' });
        return loadOutput().commandSchemas.accept!;
    }
    if (entry === 'projection') {
        extractProjectionSchemas({ ...options, projectionExport: 'view' });
        return loadOutput<{ stateSchema: ZodType }>().stateSchema;
    }
    extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile, definitions: [
        { kind: 'aggregate', entry: options.entry, export: 'target' },
        { kind: 'projection', entry: options.entry, export: 'view' }
    ] });
    const registry = loadOutput<{ aggregateSchemas: Map<string, { commands: Record<string, ZodType> }>;
        projectionSchemas: Map<string, ZodType> }>();
    const aggregate = registry.aggregateSchemas.get('target')!.commands.accept!;
    const projection = registry.projectionSchemas.get('view')!;
    return z.intersection(aggregate, projection);
}

test.each(['aggregate', 'projection', 'registry'])('Record key/value provenance is positional through %s', entry => {
    const options = setup(provenanceSource('{ refined: Record<Key, Value>; plain: Record<Key, string> }'), { mode: 'types-first' });
    const schema = provenanceExtract(options, entry);
    const good = { refined: { abcde: 'x' }, plain: { abcde: 'x' } };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, refined: { abcde: '12345' } }).success).toBe(false);
    expect(schema.safeParse({ ...good, refined: { a: 'x' } }).success).toBe(false);
    expect(schema.safeParse({ ...good, plain: { a: 'x' } }).success).toBe(false);
    if (entry !== 'registry') {
        const records = schema as z.ZodObject<{ refined: z.ZodRecord<z.ZodString, z.ZodString> }>;
        const original = createRequire(join(directory, 'output.js'))('./schemas.js') as { key: ZodType; value: ZodType };
        expect(records.shape.refined.keyType).toBe(original.key);
        expect(records.shape.refined.valueType).toBe(original.value);
    }
});

test.each(['Box<Identifier>', 'Renamed<Identifier>', 'InterfaceBox<Identifier>', 'DefaultBox', 'InheritedBox', 'Readonly<Record<Key, Value>>'])('schema-derived generic %s fails closed across entrypoints', payload => {
    const options = setup(provenanceSource(payload), { mode: 'types-first' });
    for (const entry of ['aggregate', 'projection', 'registry']) {
        writeFileSync(options.outFile, 'sentinel');
        expect(() => provenanceExtract(options, entry)).toThrow(/schema-derived generic.*explicit.*schema/i);
        expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    }
});

test.each(['Record<Key, string>', 'Box<Identifier>', 'Renamed<Identifier>', 'DefaultBox', 'InheritedBox', '{ pair: Pair | null }'])('JSON refuses authored constraints in %s before writing', payload => {
    const options = setup(provenanceSource(payload), { mode: 'types-first' });
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })).toThrow(/existing Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test('nullable/optional readonly tuple aliases retain element provenance without plain-string leakage', () => {
    const options = setup(provenanceSource('{ pair: Pair | null; optional?: Pair; nested: { pair: Pair | null }; list: ReadonlyArray<Identifier> }'), { mode: 'types-first' });
    const schema = provenanceExtract(options, 'aggregate');
    const good = { pair: ['abc', 'x'], nested: { pair: ['abc'] }, list: ['abc'] };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, pair: null }).success).toBe(true);
    expect(schema.safeParse({ ...good, pair: ['x', 'abc'] }).success).toBe(false);
    expect(schema.safeParse({ ...good, optional: ['x'] }).success).toBe(false);
    expect(schema.safeParse({ ...good, nested: { pair: ['x'] } }).success).toBe(false);
    expect(schema.safeParse({ ...good, list: ['x'] }).success).toBe(false);
});

test.each(['aggregate', 'projection', 'registry'])('ordinary generic wrappers remain supported through %s', entry => {
    const options = setup(provenanceSource('DefaultBox<string>'), { mode: 'types-first' });
    const schema = provenanceExtract(options, entry);
    expect(schema.safeParse({ value: 'x' }).success).toBe(true);
    expect(schema.safeParse({ value: 1 }).success).toBe(false);
});

test.each(['aggregate', 'registry'])('generic C factory preserves original callback annotations through %s', entry => {
    const source = provenanceSource('Box<Identifier>').replace(
        '.commands(() => ({ accept: (_state, value: Payload) => [] }))',
        `.commands(() => ({ accept: C((_state, value: Payload) => []) }))`);
    const options = setup(source + `
        function C<P>(handler: (state: unknown, payload: P) => []) { return { handler }; }`, { mode: 'types-first' });
    writeFileSync(options.outFile, 'sentinel');
    expect(() => provenanceExtract(options, entry)).toThrow(/schema-derived generic.*explicit.*schema/i);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test.each(['aggregate', 'projection', 'registry'])('readonly array syntax retains element provenance through %s', entry => {
    const options = setup(provenanceSource('{ direct: readonly Identifier[]; generic: ReadonlyArray<Identifier>; plain: readonly string[] }'), { mode: 'types-first' });
    const schema = provenanceExtract(options, entry);
    const good = { direct: ['abc'], generic: ['abc'], plain: ['x'] };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, direct: ['x'] }).success).toBe(false);
    expect(schema.safeParse({ ...good, generic: ['x'] }).success).toBe(false);
});

test('nullable required tuple alias keeps the first schema and an independent plain second element', () => {
    const source = provenanceSource('{ pair: Pair | null }').replace('readonly [Identifier, string?]', '[Identifier, string]');
    const options = setup(source, { mode: 'types-first' });
    const schema = provenanceExtract(options, 'aggregate');
    expect(schema.safeParse({ pair: ['abc', 'x'] }).success).toBe(true);
    expect(schema.safeParse({ pair: null }).success).toBe(true);
    expect(schema.safeParse({ pair: ['x', 'abc'] }).success).toBe(false);
    expect(schema.safeParse({ pair: ['abc'] }).success).toBe(false);
});

function savedFactorySource(payload: string, command: string, copied = false) {
    return provenanceSource(payload).replace(
        '.commands(() => ({ accept: (_state, value: Payload) => [] }))',
        `.commands(() => ({ ${command} }))`) + `
        function C<P>(handler: (state: unknown, payload: P) => []) { return { handler${copied ? ': handler' : ''} }; }
        const callback = (_state: unknown, payload: Payload): [] => [];
        const saved = C(callback); const first = saved; const second = first;
        const holder = { saved: second };`;
}

function aggregateOnlyRegistry(options: ReturnType<typeof setup>): ZodType {
    extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile, definitions: [
        { kind: 'aggregate', entry: options.entry, export: 'target' }
    ] });
    return loadOutput<{ aggregateSchemas: Map<string, { commands: Record<string, ZodType> }> }>()
        .aggregateSchemas.get('target')!.commands.accept!;
}

test.each(['accept: saved', 'accept: second', 'accept: holder.saved', 'saved'])('saved factory %s retains callback Record constraints', command => {
    const source = savedFactorySource('Record<Key, Value>', command);
    const options = setup(source, { mode: 'types-first' });
    const name = command === 'saved' ? 'saved' : 'accept';
    assertInputDiagnostics(options);
    extractZodSchemas({ ...options, aggregateExport: 'target' });
    const schema = loadOutput().commandSchemas[name]!;
    expect(schema.safeParse({ abcde: 'x' }).success).toBe(true);
    expect(schema.safeParse({ a: 'x' }).success).toBe(false);
    expect(schema.safeParse({ abcde: 'long' }).success).toBe(false);
    if (name === 'accept') {
        const registry = aggregateOnlyRegistry(options);
        expect(registry.safeParse({ abcde: 'x' }).success).toBe(true);
        expect(registry.safeParse({ a: 'x' }).success).toBe(false);
        expect(registry.safeParse({ abcde: 'long' }).success).toBe(false);
    }
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })).toThrow(/existing Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test.each(['accept: saved', 'accept: second'])('saved factory %s fails closed for unsupported schema generic', command => {
    const options = setup(savedFactorySource('Box<Identifier>', command, true), { mode: 'types-first' });
    for (const extract of [() => provenanceExtract(options, 'aggregate'), () => aggregateOnlyRegistry(options),
        () => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })]) {
        writeFileSync(options.outFile, 'sentinel');
        expect(extract).toThrow(/schema-derived generic|existing Zod schema/);
        expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    }
});

test('copied handler factory and ordinary saved factories remain supported', () => {
    const options = setup(savedFactorySource('Box<string>', 'accept: second', true), { mode: 'types-first' });
    const schema = provenanceExtract(options, 'aggregate');
    expect(schema.safeParse({ value: 'x' }).success).toBe(true);
    expect(schema.safeParse({ value: 1 }).success).toBe(false);
    expect(aggregateOnlyRegistry(options).safeParse({ value: 'x' }).success).toBe(true);
    expect(() => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })).not.toThrow();
});

test('unproven saved schema-bearing callback refuses all output instead of guessing', () => {
    const source = savedFactorySource('Record<Key, Value>', 'accept: second').replace(
        'return { handler };', 'return { handler: (state: unknown, payload: P): [] => handler(state, payload) };');
    const options = setup(source, { mode: 'types-first' });
    assertInputDiagnostics(options);
    for (const extract of [() => extractZodSchemas({ ...options, aggregateExport: 'target' }),
        () => aggregateOnlyRegistry(options), () => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })]) {
        writeFileSync(options.outFile, 'sentinel');
        expect(extract).toThrow(/cannot prove callback provenance/);
        expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    }
});

test('command variable alias cycles diagnose before output writes', () => {
    const source = savedFactorySource('Box<Identifier>', 'accept: second').replace(
        'const saved = C(callback); const first = saved; const second = first;',
        'const saved: ReturnType<typeof C<Payload>> = second; const first = saved; const second = first;');
    const options = setup(source, { mode: 'types-first' });
    for (const extract of [() => extractZodSchemas({ ...options, aggregateExport: 'target' }),
        () => aggregateOnlyRegistry(options), () => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })]) {
        writeFileSync(options.outFile, 'sentinel');
        expect(extract).toThrow(/provenance cycle/);
        expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    }
});

test.each(['Child', 'Grandchild'])('inherited %s schema arguments fail closed before JSON and Zod writes', payload => {
    const options = setup(provenanceSource(payload) + `
        interface Parent extends InterfaceBox<Identifier> {}
        interface Child extends Parent {} interface Grandchild extends Child {}`, { mode: 'types-first' });
    for (const entry of ['aggregate', 'projection', 'registry']) {
        writeFileSync(options.outFile, 'sentinel');
        expect(() => provenanceExtract(options, entry)).toThrow(/schema-derived generic/);
        expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    }
    expect(() => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })).toThrow(/existing Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test('ordinary multi-hop heritage remains structural and recursive properties retain policy diagnostics', () => {
    const options = setup(provenanceSource('Child') + `
        interface Parent extends InterfaceBox<string> {} interface Child extends Parent {}`, { mode: 'types-first' });
    expect(provenanceExtract(options, 'aggregate').safeParse({ value: 'x' }).success).toBe(true);
    expect(() => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })).not.toThrow();
    writeFileSync(options.entry, readFileSync(options.entry, 'utf8') + '\ninterface Child { next: Child }');
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas({ ...options, aggregateExport: 'target' })).toThrow(/recursive/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

function wrappedFactorySource(payload: string, wrapper: string) {
    return savedFactorySource(payload, 'accept: second').replace('C(callback);', `${wrapper};`);
}

test.each(['C(callback) satisfies { handler: typeof callback }', 'C(callback)!'])('transparent factory wrapper %s preserves Record provenance', wrapper => {
    const options = setup(wrappedFactorySource('Record<Key, Value>', wrapper), { mode: 'types-first' });
    assertInputDiagnostics(options);
    for (const extract of [() => provenanceExtract(options, 'aggregate'), () => aggregateOnlyRegistry(options)]) {
        const schema = extract();
        expect(schema.safeParse({ abcde: 'x' }).success).toBe(true);
        expect(schema.safeParse({ a: 'x' }).success).toBe(false);
        expect(schema.safeParse({ abcde: 'long' }).success).toBe(false);
    }
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })).toThrow(/existing Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test.each(['C(callback) satisfies { handler: typeof callback }', 'C(callback)!'])('transparent factory wrapper %s rejects unsupported schema generics', wrapper => {
    const options = setup(wrappedFactorySource('Box<Identifier>', wrapper), { mode: 'types-first' });
    assertInputDiagnostics(options);
    for (const extract of [() => provenanceExtract(options, 'aggregate'), () => aggregateOnlyRegistry(options),
        () => extractZodSchemas({ ...options, aggregateExport: 'target', format: 'json-schema' })]) {
        writeFileSync(options.outFile, 'sentinel');
        expect(extract).toThrow(/schema-derived generic|existing Zod schema/);
        expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    }
});

test('satisfies-wrapped saved factory retains original schema identity under default zod-first', () => {
    const source = wrappedFactorySource('Identifier', 'C(callback) satisfies { handler: typeof callback }')
        .replace("createAggregate('target', { count: 0 })", "createAggregate<State, 'target'>('target', { id: 'old' })");
    const options = setup(source);
    assertInputDiagnostics(options);
    for (const extract of [() => provenanceExtract(options, 'aggregate'), () => aggregateOnlyRegistry(options)]) {
        const schema = extract();
        const original = createRequire(join(directory, 'output.js'))('./schemas.js') as { identifier: ZodType };
        expect(schema).toBe(original.identifier);
        expect(schema.safeParse('abc').success).toBe(true);
        expect(schema.safeParse('x').success).toBe(false);
    }
});

test('built readonly aggregate state retains inferred optional and array model fields', () => {
    const options = setup(`import { createAggregate } from '@redemeine/aggregate';
        const initial = { count: 0, optional: undefined as string | undefined, rows: [] as { id: string }[] };
        export const target = createAggregate('target', initial).events({}).build();
        throw new Error('APPLICATION_EXECUTED');`, { mode: 'types-first' });
    writeFileSync(join(directory, 'schemas.ts'), 'export {};');
    assertInputDiagnostics(options);
    extractZodSchemas({ ...options, aggregateExport: 'target', dateHandling: 'date' });
    const { stateSchema } = loadOutput();
    const good = { count: 1, optional: 'ok', rows: [{ id: 'a' }] };
    expect(stateSchema.safeParse(good)).toMatchObject({ success: true });
    expect(stateSchema.safeParse({ ...good, optional: 1 }).success).toBe(false);
    expect(stateSchema.safeParse({ ...good, rows: [{ id: 1 }] }).success).toBe(false);
});

test.each(['date', 'plugin'])('built %s state uses the complete canonical model', kind => {
    const options = setup(`import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
        const plugin = createAggregatePlugin('audit').state(() => ({ total: 0 })).build();
        export const target = createAggregate('target', { count: 0${kind === 'date' ? ', at: new Date()' : ''} }).events({})${kind === 'plugin' ? '.plugins(plugin)' : ''}.build();
        throw new Error('APPLICATION_EXECUTED');`, { mode: 'types-first' });
    writeFileSync(join(directory, 'schemas.ts'), 'export {};');
    assertInputDiagnostics(options);
    extractZodSchemas({ ...options, aggregateExport: 'target', dateHandling: 'date' });
    const { stateSchema } = loadOutput();
    const good = kind === 'date' ? { count: 1, at: new Date() } : { count: 1, audit: { total: 2 } };
    const bad = kind === 'date' ? { count: 1, at: 'not-a-date' } : { count: 1, audit: { total: 'wrong' } };
    expect(stateSchema.safeParse(good).success).toBe(true);
    expect(stateSchema.safeParse(bad).success).toBe(false);
});

test('authored domain state cannot silently omit plugin-mounted state', () => {
    const source = authoredSource().replace('.build();', '.plugins(plugin).build();');
    const options = setup(`import { createAggregatePlugin } from '@redemeine/aggregate';
        const plugin = createAggregatePlugin('audit').state(() => ({ total: 0 })).build();\n${source}`);
    assertInputDiagnostics(options);
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas(options)).toThrow(/plugin|explicit.*schema|state/i);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test.each(['zod-first', 'types-first'] as const)('%s rejects base schemas even when mounted plugin fields are optional', mode => {
    const source = authoredSource().replace('.build();', '.plugins(plugin).build();');
    const options = setup(`import { createAggregatePlugin } from '@redemeine/aggregate';
        const plugin = createAggregatePlugin('audit').state((): { total?: number } => ({})).build();\n${source}`, { mode });
    assertInputDiagnostics(options);
    for (const extract of [() => extractZodSchemas(options), () => extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile,
        definitions: [{ kind: 'aggregate', entry: options.entry, export: 'aggregate' }] }),
        () => extractZodSchemas({ ...options, format: 'json-schema' })]) {
        writeFileSync(options.outFile, 'sentinel');
        expect(extract).toThrow(/aggregate.state:.*explicit whole-model schema/);
        expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    }
});
