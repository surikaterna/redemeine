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
    expect(schemaPolicyForEntry(options.entry)).toEqual({ mode: 'zod-first', maxDepth: 60 });
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas(options)).toThrow(/no importable Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested/package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'types-first', maxDepth: 4 } } }));
    expect(schemaPolicyForEntry(join(directory, 'nested/source.ts'))).toEqual({ mode: 'types-first', maxDepth: 4 });
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
