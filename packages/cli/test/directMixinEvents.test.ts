import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ts from 'typescript';
import { z } from 'zod';
import { extractZodSchemas } from '../src/extractZodSchemas';
import { createProgramFromConfig } from '../src/extract/aggregateNavigator';
import { resolvedAggregateEvents } from '../src/extract/mountedEventWalker';

test('canonical direct mixins combine with mounted registries without executing the module', () => {
    const directory = mkdtempSync(join(tmpdir(), 'direct-events-'));
    try {
        const entry = join(__dirname, 'fixtures/directMixinEvents.ts');
        const config = join(directory, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false,
            target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, files: [entry] }));
        expect(ts.getPreEmitDiagnostics(createProgramFromConfig(config)).map(d =>
            ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
        const outFile = join(directory, 'output.ts');
        for (const aggregateExport of ['aggregate', 'together', 'separate', 'eventsFallback', 'undefinedProjectors', 'ignoredEvents']) {
            const keys = aggregateExport === 'aggregate'
                ? ['audited', 'combined', 'counted', 'items.changed', 'rows.changed']
                : ['together', 'separate'].includes(aggregateExport) ? ['audited', 'counted'] : ['audited'];
            extractZodSchemas({ entry, tsconfig: config, aggregateExport, outFile });
            const exported: { eventSchemas?: Record<string, z.ZodType> } = {};
            new Function('require', 'exports', ts.transpileModule(readFileSync(outFile, 'utf8'), {
                compilerOptions: { module: ts.ModuleKind.CommonJS },
            }).outputText)(() => ({ z }), exported);
            expect(Object.keys(exported.eventSchemas!).sort()).toEqual(keys);
            expect(exported.eventSchemas!.audited!.safeParse({ code: 'yes' }).success).toBe(true);
            expect(exported.eventSchemas!.audited!.safeParse({ code: 3 }).success).toBe(false);
            extractZodSchemas({ entry, tsconfig: config, aggregateExport, outFile, format: 'json-schema' });
            const json = JSON.parse(readFileSync(outFile, 'utf8'));
            expect(Object.keys(json.events)).toEqual(keys);
            expect(json.events.audited).toMatchObject({ properties: { code: { type: 'string' } }, required: ['code'] });
        }
        for (const aggregateExport of ['repeated', 'rootCollision', 'mixinCollision', 'dottedCollision', 'structural',
            'replacedProjectors', 'intersectedProjectors', 'uncertainProjectors']) {
            for (const format of ['zod', 'json-schema'] as const) {
                writeFileSync(outFile, 'sentinel');
                expect(() => extractZodSchemas({ entry, tsconfig: config, aggregateExport, outFile, format }))
                    .toThrow(/collision|provenance|unresolved/);
                expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
            }
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each(['unknown', 'any', '{}[]', '[{}?]', '[...{}[]]', '{ projectors: { [key: string]: () => void } }[]',
    '[{ projectors: { fake: () => void } }]', '[MixinPackage]'])('opaque mixin evidence fails closed: %s', marker => {
    const file = 'opaque.ts';
    const host = ts.createCompilerHost({ strict: true });
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, onError) => name === file ? ts.createSourceFile(file,
        `interface MixinPackage { projectors: { spoofed: () => void } }
        declare const aggregate: { pure: { eventProjectors: {} }; __mixinEventDeclarationsType?: ${marker} };`,
        ts.ScriptTarget.Latest, true) : original(name, language, onError);
    const program = ts.createProgram([file], { strict: true }, host);
    const source = program.getSourceFile(file)!;
    const declaration = (source.statements[1] as ts.VariableStatement).declarationList.declarations[0]!;
    const checker = program.getTypeChecker();
    expect(() => resolvedAggregateEvents(checker, checker.getTypeAtLocation(declaration), source))
        .toThrow(/unresolved|tuple|provenance/);
});

test('direct mixin schema-linked constraints retain their Zod schema and reject lossy JSON', () => {
    const directory = mkdtempSync(join(__dirname, '.direct-linked-'));
    try {
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'types-first' } } }));
        writeFileSync(join(directory, 'schemas.ts'), `import { z } from 'zod';
            export const payload = z.object({ code: z.string().min(3) }); export type Payload = z.output<typeof payload>;`);
        const entry = join(directory, 'input.ts');
        writeFileSync(entry, `import { createAggregate, createMixin } from '../../../aggregate/src';
            import type { Event } from '../../../kernel/src'; import type { Payload } from './schemas';
            const mixin = createMixin<{}>().events({ audited: (_state, _event: Event<Payload>) => {} }).build();
            export const aggregate = createAggregate('host', {}).mixins(mixin).build(); throw Error('APPLICATION_EXECUTED');`);
        const config = join(directory, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false,
            target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, include: ['*.ts'] }));
        expect(ts.getPreEmitDiagnostics(createProgramFromConfig(config))).toEqual([]);
        const outFile = join(directory, 'output.ts');
        extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile });
        expect(ts.getPreEmitDiagnostics(createProgramFromConfig(config))).toEqual([]);
        const payload = z.object({ code: z.string().min(3) });
        const exported: { eventSchemas?: Record<string, z.ZodType> } = {};
        new Function('require', 'exports', ts.transpileModule(readFileSync(outFile, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText)((id: string) => id === 'zod' ? { z } : { payload }, exported);
        expect(exported.eventSchemas!.audited).toBe(payload);
        expect(exported.eventSchemas!.audited!.safeParse({ code: 'abc' }).success).toBe(true);
        expect(exported.eventSchemas!.audited!.safeParse({ code: 'x' }).success).toBe(false);
        writeFileSync(outFile, 'sentinel');
        expect(() => extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile, format: 'json-schema' }))
            .toThrow(/discard its constraints/);
        expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
