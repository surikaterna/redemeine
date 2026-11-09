import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractZodSchemas } from '../src/extractZodSchemas';
import * as ts from 'typescript';
import { z } from 'zod';
import { createProgramFromConfig } from '../src/extract/aggregateNavigator';
import { resolvedAggregateEvents } from '../src/extract/mountedEventWalker';

const keys = ['byKey.registered', 'changed', 'deep.children.children.registered', 'inherited.registered',
    'items.registered', 'mixed.registered', 'parents.children.registered'];

test('extract-schemas includes declared root/list/map/nested event payloads without commands', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mounted-events-'));
    try {
        const entry = join(__dirname, 'fixtures/mountedEvents.ts');
        const config = join(directory, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022',
            module: 'ESNext', moduleResolution: 'Bundler', types: [] }, files: [entry] }));
        const program = createProgramFromConfig(config);
        expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
        const outFile = join(directory, 'schemas.json');
        extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile, format: 'json-schema' });
        const output = JSON.parse(readFileSync(outFile, 'utf8'));
        expect(Object.keys(output.events)).toEqual(keys);
        expect(output.events['parents.children.registered'].properties).toEqual({ label: { type: 'string' } });
        expect(output.commands).toEqual({});
        extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile });
        const source = readFileSync(outFile, 'utf8');
        const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
        const exported: { eventSchemas?: Record<string, z.ZodType> } = {};
        new Function('require', 'exports', js)(() => ({ z }), exported);
        expect(Object.keys(exported.eventSchemas!).sort()).toEqual(keys);
        for (const key of keys.filter(key => key !== 'changed')) {
            expect(exported.eventSchemas![key]!.safeParse({ label: 'yes' }).success).toBe(true);
            expect(exported.eventSchemas![key]!.safeParse({ label: 42 }).success).toBe(false);
        }
        for (const format of ['zod', 'json-schema'] as const) {
            writeFileSync(outFile, 'sentinel');
            expect(() => extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'collision', outFile, format })).toThrow(/collision/);
            expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

function declaredEvents(registry: string) {
    const file = 'declared-events.ts';
    const host = ts.createCompilerHost({ strict: true, noLib: true });
    const node = ts.createSourceFile(file, `declare const aggregate: { pure: { eventProjectors: { root: (s: {}, e: { payload: string }) => void } }; ${registry} };`, ts.ScriptTarget.Latest, true);
    host.getSourceFile = name => name === file ? node : undefined;
    const program = ts.createProgram([file], { strict: true, noLib: true }, host);
    const checker = program.getTypeChecker();
    const declaration = (node.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
    return () => resolvedAggregateEvents(checker, checker.getTypeAtLocation(declaration), node);
}

test.each(['types-first', undefined])('structural generic events preserve concrete payloads (%s)', mode => {
    const directory = mkdtempSync(join(__dirname, '.structural-events-'));
    try {
        writeFileSync(join(directory, 'package.json'), JSON.stringify(mode ? { redemeine: { schemas: { mode } } } : {}));
        const entry = join(directory, 'input.ts');
        writeFileSync(entry, readFileSync(join(__dirname, 'fixtures/structuralEvents.ts'), 'utf8'));
        const config = join(directory, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false,
            target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, include: ['*.ts'] }));
        expect(ts.getPreEmitDiagnostics(createProgramFromConfig(config))).toEqual([]);
        const outFile = join(directory, 'output.ts');
        if (!mode) {
            for (const format of ['zod', 'json-schema'] as const) {
                writeFileSync(outFile, 'sentinel');
                expect(() => extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile, format }))
                    .toThrow(format === 'zod' ? /no importable Zod schema/ : /zod-first requires linked Zod output/);
                expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
            }
            return;
        }
        extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile });
        expect(ts.getPreEmitDiagnostics(createProgramFromConfig(config))).toEqual([]);
        const exported: { eventSchemas?: Record<string, z.ZodType> } = {};
        new Function('require', 'exports', ts.transpileModule(readFileSync(outFile, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText)(() => ({ z }), exported);
        extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile, format: 'json-schema' });
        const json = JSON.parse(readFileSync(outFile, 'utf8'));
        const expected = ['byKey.aliased', 'byKey.changed', 'byKey.nested', 'changed', 'items.aliased',
            'items.changed', 'items.nested', 'parents.children.aliased', 'parents.children.changed', 'parents.children.nested'];
        expect(Object.keys(json.events)).toEqual(expected);
        expect(Object.keys(exported.eventSchemas!).sort()).toEqual(expected);
        for (const key of expected) {
            const nested = key.endsWith('.nested');
            expect(exported.eventSchemas![key]!.safeParse({ value: nested ? { value: 1 } : 1 }).success).toBe(true);
            expect(exported.eventSchemas![key]!.safeParse({ value: nested ? { value: 'bad' } : 'bad' }).success).toBe(false);
            expect(exported.eventSchemas![key]!.safeParse({}).success).toBe(false);
            const numberBox = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] };
            expect(json.events[key]).toMatchObject(nested
                ? { type: 'object', properties: { value: numberBox }, required: ['value'] } : numberBox);
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each([
    ['interface Box<T> { value: T }', 'Event<Box<Output>>'],
    ['interface Box<T = Output> { value: T }', 'Event<Box>'],
    ['interface Box<T extends Output> { value: T }', 'Event<Box<string>>'],
    ['type Box<T> = { generic: T; concrete: Output }', 'Event<Box<Output>>'],
    ['interface Base<T> { value: T }; interface Box<T> extends Base<T> { concrete: Output }', 'Event<Box<Output>>'],
    ['declare class Result<T = Output> { payload: T }', 'Result'],
    ['declare class Result<T> { payload: T }', 'Result<Output>'],
    ['declare class Base<T = Output> { payload: T }; declare class Result extends Base {}', 'Result'],
    ['declare class Hidden<T = Output> { value: T }; interface Box<T> { value: T }', 'Event<Box<Hidden>>'],
    ['declare class Hidden<T = Output> { value: T }; interface Box<T = Hidden> { value: T }', 'Event<Box>'],
    ['declare class Base<T = Output> { value: T }; declare class Hidden extends Base {}; declare const hidden: Hidden; interface Box<T> { value: T }', 'Event<Box<typeof hidden>>'],
    ['declare class Base<T = Output> { value: T }; declare class Hidden extends Base {}; interface Box<T> { value: T }', 'Event<Box<InstanceType<typeof Hidden>>>'],
    ['declare class Base<T = Output> { value: T }; declare class Hidden extends Base {}; declare const hidden: Hidden; type Actual = typeof hidden; interface Box<T> { value: T }', 'Event<Box<Actual>>'],
])('schema-linked or opaque event substitutions fail closed: %s', (wrapper, event) => {
    const directory = mkdtempSync(join(__dirname, '.event-provenance-'));
    try {
        const entry = join(directory, 'input.ts');
        writeFileSync(entry, `import { z } from 'zod'; import type { Event } from '../../../kernel/src';
            const schema = z.string().min(3); type Output = z.infer<typeof schema>; ${wrapper};
            export declare const aggregate: { initialState: { count: number }; commandCreators: {};
                pure: { eventProjectors: { changed: (state: {}, event: ${event}) => void } } };
            throw Error('APPLICATION_EXECUTED');`);
        const config = join(directory, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false,
            target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, files: [entry] }));
        expect(ts.getPreEmitDiagnostics(createProgramFromConfig(config))).toEqual([]);
        const outFile = join(directory, 'output.ts');
        for (const mode of ['types-first', 'zod-first']) {
            writeFileSync(join(directory, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode } } }));
            for (const format of ['zod', 'json-schema'] as const) {
                writeFileSync(outFile, 'sentinel');
                expect(() => extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile, format }))
                    .toThrow(/schema-linked|schema-derived|provenance/);
                expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
            }
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('legacy absent registry remains valid', () => {
    expect([...declaredEvents('')().keys()]).toEqual(['root']);
});

test.each([
    '__registryType?: unknown', '__registryType?: any',
    '__registryType?: { [name: string]: { kind: "list" } }',
    '__registryType?: { items: { kind: "list"; entity: { events: {}; __registryType?: typeof aggregate.__registryType } } }',
    '__registryType?: { items: { kind: "list"; entity: { events: { changed: ((s: {}, e: { payload: string }) => void) & ((s: {}, e: { payload: number }) => void) } } } }',
])('opaque or ambiguous declared registries fail closed: %s', registry => {
    expect(declaredEvents(registry)).toThrow(/unresolved|ambiguous|cyclic/);
});
