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
