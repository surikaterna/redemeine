import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';
import type { ZodType } from 'zod';
import { extractSchemaRegistries } from '../src/extractSchemaRegistries';
import { extractZodSchemas } from '../src/extractZodSchemas';
import { extractProjectionSchemas } from '../src/extractProjectionSchemas';
import { createProgramFromConfig } from '../src/extract/aggregateNavigator';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(__dirname, '.schema-reconciliation-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function setup(source: string, schemas: string, mode: string, maxDepth = 60) {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode, maxDepth } } }));
    writeFileSync(join(directory, 'schemas.ts'), schemas);
    writeFileSync(join(directory, 'input.ts'), source);
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [], esModuleInterop: true,
        paths: { '@redemeine/aggregate': [join(__dirname, '../../aggregate/dist/index.d.ts')] }
    }, include: ['**/*.ts'] }));
    return { entry: join(directory, 'input.ts'), tsconfig: join(directory, 'tsconfig.json'), outFile: join(directory, 'output.ts') };
}

function load<T>(): { output: T; schemas: Record<string, ZodType> } {
    const options: ts.CompilerOptions = { strict: true, noUnusedLocals: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], esModuleInterop: true };
    const program = ts.createProgram([join(directory, 'output.ts')], options);
    expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
    for (const name of ['schemas', 'output']) {
        writeFileSync(join(directory, `${name}.js`), ts.transpileModule(readFileSync(join(directory, `${name}.ts`), 'utf8'),
            { compilerOptions: { ...options, module: ts.ModuleKind.CommonJS } }).outputText);
    }
    const requireOutput = createRequire(join(directory, 'output.js'));
    return { output: requireOutput('./output.js') as T, schemas: requireOutput('./schemas.js') };
}

const recursiveSchemas = `import { z } from 'zod';
export type Tree = { value: string; next?: Tree };
export const tree: z.ZodType<Tree> = z.lazy(() => z.object({ value: z.string().min(3), next: tree.optional() }));`;
const recursiveSource = `import { createAggregate } from '@redemeine/aggregate';
import type { z } from 'zod'; import type { tree } from './schemas';
type State = z.infer<typeof tree>;
export const aggregate = createAggregate<State, 'tree'>('tree', { value: 'abc' }).events({})
 .commands(() => ({ change: (_state, payload: State) => [] })).build();
export { aggregate as exportedAlias };
export const sameAggregate = aggregate;
export const secondAlias = sameAggregate;
throw new Error('APPLICATION_EXECUTED');`;

test.each(['types-first', 'zod-first'])('%s reconciles recursive authored export, const and public aliases', mode => {
    const options = setup(recursiveSource, recursiveSchemas, mode, 1);
    writeFileSync(join(directory, 'public.ts'), `export { secondAlias as publicAggregate } from './input';`);
    expect(ts.getPreEmitDiagnostics(createProgramFromConfig(options.tsconfig))).toEqual([]);
    const original = { kind: 'aggregate' as const, entry: options.entry };
    const publicRoute = { kind: 'aggregate' as const, entry: join(directory, 'public.ts') };
    const registryOptions = { tsconfig: options.tsconfig, outFile: options.outFile };
    extractSchemaRegistries({ ...registryOptions, definitions: [{ ...original, export: 'sameAggregate' }], discover: [original, publicRoute] });
    const first = readFileSync(options.outFile, 'utf8');
    extractSchemaRegistries({ ...registryOptions, discover: [publicRoute, original] });
    expect(readFileSync(options.outFile, 'utf8')).toBe(first);
    const { output, schemas } = load<{ aggregateSchemas: Map<string, { state: ZodType; commands: Record<string, ZodType> }> }>();
    const bundle = output.aggregateSchemas.get('tree')!;
    expect(bundle.state).toBe(schemas.tree);
    expect(bundle.commands.change).toBe(schemas.tree);
    expect(bundle.state.safeParse({ value: 'abc', next: { value: 'x' } }).success).toBe(false);
});

test('every selected route applies its own package policy before reconciliation writes', () => {
    const source = `import { createAggregate } from '@redemeine/aggregate';
        export const aggregate = createAggregate('plain', { value: 'abc' }).events({}).commands(() => ({})).build();`;
    const options = setup(source, recursiveSchemas, 'types-first');
    mkdirSync(join(directory, 'strict'));
    writeFileSync(join(directory, 'strict/package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'zod-first' } } }));
    writeFileSync(join(directory, 'strict/public.ts'), `export { aggregate } from '../input';`);
    const routes = [options.entry, join(directory, 'strict/public.ts')].map(entry => ({ kind: 'aggregate' as const, entry }));
    for (const discover of [routes, [...routes].reverse()]) {
        writeFileSync(options.outFile, 'sentinel');
        expect(() => extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile, discover })).toThrow(/no importable Zod schema/);
        expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
        const absent = join(directory, 'absent/output.ts');
        expect(() => extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: absent, discover })).toThrow(/no importable Zod schema/);
        expect(existsSync(join(directory, 'absent'))).toBe(false);
    }
});

test('different route policies agree when they reference the same authored schema', () => {
    const options = setup(recursiveSource, recursiveSchemas, 'types-first', 1);
    mkdirSync(join(directory, 'strict'));
    writeFileSync(join(directory, 'strict/package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'zod-first', maxDepth: 2 } } }));
    writeFileSync(join(directory, 'strict/public.ts'), `export { secondAlias } from '../input';`);
    const routes = [options.entry, join(directory, 'strict/public.ts')].map(entry => ({ kind: 'aggregate' as const, entry }));
    const registryOptions = { tsconfig: options.tsconfig, outFile: options.outFile };
    extractSchemaRegistries({ ...registryOptions, discover: routes });
    const first = readFileSync(options.outFile, 'utf8');
    extractSchemaRegistries({ ...registryOptions, discover: [...routes].reverse() });
    expect(readFileSync(options.outFile, 'utf8')).toBe(first);
});

const orders = ['A,B,plain', 'plain,A,B', 'B,A,plain'];
describe.each(['string[]', '[string]'])('shared compiler identity %s', items => {
    test.each(orders)('types-first isolates authored and structural schemas in order %s', order => {
        const options = cachedOptions(items, order, 'types-first');
        extractZodSchemas({ ...options, aggregateExport: 'aggregate' });
        const { output, schemas } = load<{ commandSchemas: Record<string, ZodType> }>();
        expect(output.commandSchemas.A).toBe(schemas.a);
        expect(output.commandSchemas.B).toBe(schemas.b);
        expect(output.commandSchemas.A!.safeParse(['x']).success).toBe(false);
        expect(output.commandSchemas.B!.safeParse(['abcd']).success).toBe(false);
        expect(output.commandSchemas.plain!.safeParse(['x']).success).toBe(true);
        expect(output.commandSchemas.plain!.safeParse(['abcd']).success).toBe(true);
    });
    test.each(orders)('zod-first rejects unannotated plain items before writes in order %s', order => {
        const options = cachedOptions(items, order, 'zod-first');
        writeFileSync(options.outFile, 'sentinel');
        expect(() => extractZodSchemas({ ...options, aggregateExport: 'aggregate' })).toThrow(/no importable Zod schema/);
        expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
    });
});

test.each(['projection', 'registry'] as const)('%s preserves separate authored references without leaking into nested structural items', api => {
    const options = cachedOptions('string[]', 'A,B,plain', 'types-first');
    writeFileSync(options.entry, readFileSync(options.entry, 'utf8') + `
        export const view = { name: 'view' as const, fromStream: 'events', identity: {}, subscriptions: [],
            initialState: (): { first: A; second: B; plain: Items; nested: Items[] } => { throw Error('APPLICATION_EXECUTED'); } };`);
    if (api === 'projection') extractProjectionSchemas({ ...options, projectionExport: 'view' });
    else extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile,
        definitions: [{ kind: 'projection', entry: options.entry, export: 'view' }] });
    const { output } = load<{ stateSchema?: ZodType; projectionSchemas?: Map<string, ZodType> }>();
    const schema = output.stateSchema ?? output.projectionSchemas!.get('view')!;
    const good = { first: ['abc'], second: ['x'], plain: ['abcd'], nested: [['x']] };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, first: ['x'] }).success).toBe(false);
    expect(schema.safeParse({ ...good, second: ['abcd'] }).success).toBe(false);
});

function cachedOptions(items: string, order: string, mode: string) {
    const schema = items === 'string[]' ? 'z.array' : 'z.tuple';
    const argument = (value: string) => items === 'string[]' ? value : `[${value}]`;
    return setup(`import { createAggregate } from '@redemeine/aggregate';
        import type { Items, A, B, State } from './schemas';
        export const aggregate = createAggregate<State, 'items'>('items', {}).events({}).commands(() => ({
        ${order.split(',').map(name => `${name}: (_state, payload: ${name === 'plain' ? 'Items' : name}) => []`).join(',')}
        })).build();`, `import { z } from 'zod'; export type Items = ${items};
        export const a: z.ZodType<Items> = ${schema}(${argument('z.string().min(3)')});
        export const b: z.ZodType<Items> = ${schema}(${argument('z.string().max(1)')});
        export type A = z.infer<typeof a>; export type B = z.infer<typeof b>;
        export const state = z.object({}); export type State = z.infer<typeof state>;`, mode);
}
