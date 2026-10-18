import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';
import type { ZodType } from 'zod';
import { extractZodSchemas } from '../src/extractZodSchemas';
import { extractSchemaRegistries } from '../src/extractSchemaRegistries';
import { createProgramFromConfig } from '../src/extract/aggregateNavigator';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(__dirname, '.plugin-model-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function fixture(state: string, mode = 'types-first', extra = '') {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, redemeine: { schemas: { mode } } }));
    writeFileSync(join(directory, 'input.ts'), `import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
        ${extra}
        const plugin = createAggregatePlugin('audit').state(${state}).build();
        export const aggregate = createAggregate('target', { count: 0 }).build().withPlugins(plugin);
        throw new Error('APPLICATION_EXECUTED');`);
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [],
        paths: { '@redemeine/aggregate': [join(__dirname, '../../aggregate/dist/index.d.ts')] }
    }, include: ['*.ts'] }));
    const options = { tsconfig: join(directory, 'tsconfig.json'), entry: join(directory, 'input.ts'),
        aggregateExport: 'aggregate', outFile: join(directory, 'output.ts') };
    expect(ts.getPreEmitDiagnostics(createProgramFromConfig(options.tsconfig))).toEqual([]);
    return options;
}

function registry(options: ReturnType<typeof fixture>, discovery: boolean) {
    const selection = { kind: 'aggregate' as const, entry: options.entry };
    extractSchemaRegistries({ tsconfig: options.tsconfig, outFile: options.outFile,
        ...(discovery ? { discover: [selection] } : { definitions: [{ ...selection, export: 'aggregate' }] }) });
}

function schemas() {
    const file = join(directory, 'output.ts');
    const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, types: [], esModuleInterop: true };
    expect(ts.getPreEmitDiagnostics(ts.createProgram([file], options))).toEqual([]);
    const authored = join(directory, 'schemas.ts');
    if (existsSync(authored)) writeFileSync(join(directory, 'schemas.js'), ts.transpileModule(readFileSync(authored, 'utf8'), { compilerOptions: options }).outputText);
    const output = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: options }).outputText;
    const result = {} as { stateSchema: ZodType; aggregateSchemas: Map<string, { state: ZodType }> };
    new Function('require', 'exports', output)(createRequire(file), result);
    return result;
}

test('canonical mounted namespace preserves declared nested optional arrays and Date model', () => {
    const options = fixture('(): { readonly rows?: readonly { at: Date; tags?: string[] }[] } => ({})');
    extractZodSchemas({ ...options, dateHandling: 'date' });
    const schema = schemas().stateSchema;
    expect(schema.safeParse({ count: 1, audit: {} }).success).toBe(true);
    expect(schema.safeParse({ count: 1, audit: { rows: [{ at: new Date(), tags: ['ok'] }] } }).success).toBe(true);
    expect(schema.safeParse({ count: 1 }).success).toBe(false);
    expect(schema.safeParse({ count: 1, audit: { rows: [{ at: 'not-date' }] } }).success).toBe(false);
    expect(schema.safeParse({ count: 1, audit: { rows: [{ at: new Date(), tags: [1] }] } }).success).toBe(false);
});

test.each([false, true])('registry discovery=%s converts full canonical mounted state, retaining Date-as-string policy', discovery => {
    const options = fixture('(): { rows?: { at: Date; tags?: string[] }[] } => ({})');
    registry(options, discovery);
    const schema = schemas().aggregateSchemas.get('target')!.state;
    expect(schema.safeParse({ count: 1, audit: {} }).success).toBe(true);
    expect(schema.safeParse({ count: 1, audit: { rows: [{ at: '2026-10-18', tags: ['ok'] }] } }).success).toBe(true);
    expect(schema.safeParse({ count: 1 }).success).toBe(false);
    expect(schema.safeParse({ count: 1, audit: { rows: [{ at: 'date', tags: [1] }] } }).success).toBe(false);
});

test.each([false, true])('zod-first mounted registry discovery=%s refuses missing whole-model schema before writes', discovery => {
    const options = fixture('() => ({ total: 0 })', 'zod-first');
    writeFileSync(options.outFile, 'sentinel');
    expect(() => registry(options, discovery)).toThrow(/initialState.*no importable Zod schema/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test.each(['unknown', '{}', '[string, number]'])('mounted registry retains strict unsupported %s policy', state => {
    const options = fixture(`(): { value: ${state} } => ({ value: ${state === '[string, number]' ? "['a', 1]" : '{}'} })`);
    writeFileSync(options.outFile, 'sentinel');
    expect(() => registry(options, false)).toThrow(/audit.*value.*(any\/unknown|empty object|tuples)/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test('unsupported mounted field fails with its full path and leaves output untouched', () => {
    const options = fixture('(): { value: () => void } => ({ value: () => {} })');
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas(options)).toThrow(/state\["audit"\]\["value"\].*functions/);
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});

test.each(['aggregate', 'explicit', 'discovery'])('%s preserves authored nested mounted-state provenance', route => {
    writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod';
        export const identifier = z.string().min(3); export type Identifier = z.infer<typeof identifier>;`);
    const options = fixture('(): { rows?: { id: Identifier }[] } => ({})', 'types-first', "import type { Identifier } from './schemas';");
    if (route === 'aggregate') extractZodSchemas(options);
    else registry(options, route === 'discovery');
    const result = schemas();
    const schema = route === 'aggregate' ? result.stateSchema : result.aggregateSchemas.get('target')!.state;
    expect(schema.safeParse({ count: 1, audit: { rows: [{ id: 'abc' }] } }).success).toBe(true);
    expect(schema.safeParse({ count: 1, audit: { rows: [{ id: 'x' }] } }).success).toBe(false);
    writeFileSync(options.outFile, 'sentinel');
    expect(() => extractZodSchemas({ ...options, format: 'json-schema' })).toThrow();
    expect(readFileSync(options.outFile, 'utf8')).toBe('sentinel');
});
