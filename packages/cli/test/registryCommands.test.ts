import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as ts from 'typescript';
import { z } from 'zod';
import { createProgramFromConfig, resolveAggregateType } from '../src/extract/aggregateNavigator';
import { registryMemberType } from '../src/extract/schemaRegistryDefinitionClassifier';
import { navigateRegistries } from '../src/extract/schemaRegistryNavigator';
import { generateSchemaRegistryOutput } from '../src/extract/schemaRegistryOutputGenerator';
import { extractSchemaRegistries } from '../src/extractSchemaRegistries';

test('source and public registries use canonical mounted command outputs, without expanding event catalogs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'registry-commands-'));
    try {
        const entry = join(__dirname, 'fixtures/registryCommands.ts');
        const config = join(directory, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022',
            module: 'ESNext', moduleResolution: 'Bundler', types: [], declaration: true, emitDeclarationOnly: true,
            paths: { '@redemeine/aggregate': [resolve(__dirname, '../../aggregate/src')],
                '@redemeine/kernel': [resolve(__dirname, '../../kernel/src')] } }, files: [entry] }));
        const program = createProgramFromConfig(config);
        expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
        const declarations = new Map<string, string>();
        expect(program.emit(program.getSourceFile(entry), (file, text) => declarations.set(file, text)).emitSkipped).toBe(false);
        const publicEntry = entry.replace(/\.ts$/, '.d.ts');
        const host = ts.createCompilerHost(program.getCompilerOptions());
        const read = host.readFile;
        host.readFile = file => declarations.get(file) ?? read(file);
        host.getSourceFile = (file, version) => {
            const text = host.readFile(file);
            return text === undefined ? undefined : ts.createSourceFile(file, text, version, true);
        };
        const emitted = ts.createProgram([publicEntry], program.getCompilerOptions(), host);
        for (const [compiler, selected] of [[program, entry], [emitted, publicEntry]] as const) {
            const checker = compiler.getTypeChecker();
            const aggregate = resolveAggregateType(compiler, checker, selected, 'aggregate');
            const selectors = checker.getPropertyOfType(aggregate, 'selectors')!;
            const location = selectors.declarations![0]!;
            const map = checker.getTypeOfSymbolAtLocation(selectors, location);
            const selector = checker.getPropertyOfType(map, 'getCoreState')!;
            if (selected === entry) expect(selector.declarations).toBeUndefined();
            const signature = registryMemberType(checker, selector, 'aggregate.selectors.getCoreState', location, true).getCallSignatures()[0]!;
            expect(ts.isFunctionTypeNode(signature.declaration!)).toBe(true);
            expect(checker.typeToString(checker.getReturnTypeOfSignature(signature))).toBe('{ count: number; }');
            const definitions = navigateRegistries(compiler, [{ kind: 'aggregate', entry: selected, export: 'aggregate' }]);
            const output = generateSchemaRegistryOutput(compiler.getTypeChecker(), definitions);
            checkOutput(output);
        }
        const outFile = join(directory, 'registries.ts');
        extractSchemaRegistries({ tsconfig: config, outFile, discover: [{ kind: 'aggregate', entry }] });
        checkOutput(readFileSync(outFile, 'utf8'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

function checkOutput(output: string): void {
    const js = ts.transpileModule(output, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports: { aggregateSchemas?: Map<string, { state: z.ZodType; commands: Record<string, z.ZodType>; events: Record<string, z.ZodType> }>;
        aggregateJsonSchemas?: Map<string, { commands: Record<string, unknown>; events: Record<string, unknown> }> } = {};
    new Function('require', 'exports', js)(() => ({ z }), exports);
    const schemas = exports.aggregateSchemas!.get('registryCommands')!;
    const json = exports.aggregateJsonSchemas!.get('registryCommands')!;
    expect(schemas.state.safeParse({ count: 1, line: [], note: {} }).success).toBe(true);
    expect(schemas.state.safeParse({ count: 'wrong', line: [], note: {} }).success).toBe(false);
    expect(Object.keys(schemas.commands).sort()).toEqual(['accept', 'lineChange', 'noteChange']);
    expect(Object.keys(schemas.events)).toEqual(['accepted']);
    expect(Object.keys(json.events)).toEqual(['accepted']);
    for (const key of ['lineChange', 'noteChange']) {
        const schema = schemas.commands[key];
        expect(schema.safeParse({ id: 'child', value: 'trimmed' }).success).toBe(true);
        for (const wrong of [{ raw: 'input' }, { id: 1, value: 'bad' }, { id: 'child' }]) {
            expect(schema.safeParse(wrong).success).toBe(false);
        }
        expect(json.commands[key]).toMatchObject({ type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } },
            required: ['id', 'value'] });
        expect(json.commands[key]).toEqual(z.toJSONSchema(schema));
    }
}

test('registry discovery still rejects unrelated declarationless maps and malformed creator returns', () => {
    const directory = mkdtempSync(join(tmpdir(), 'registry-malformed-'));
    try {
        const entry = join(__dirname, 'fixtures/registryMalformedCommands.ts');
        const config = join(directory, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022',
            module: 'ESNext', moduleResolution: 'Bundler', types: [],
            paths: { '@redemeine/aggregate': [resolve(__dirname, '../../aggregate/src')],
                '@redemeine/kernel': [resolve(__dirname, '../../kernel/src')] } }, files: [entry] }));
        const outFile = join(directory, 'registries.ts');
        writeFileSync(outFile, 'sentinel');
        const cases = [['unrelated', /unresolved handler/], ['malformed', /type.*missing/],
            ['noncallableSelector', /expected one non-generic built function/], ['unrelatedSelectors', /unresolved handler/]] as const;
        for (const [name, error] of cases) {
            expect(() => extractSchemaRegistries({ tsconfig: config, outFile, discover: [{ kind: 'aggregate', entry,
                exclude: cases.map(([other]) => other).filter(other => other !== name) }] })).toThrow(error);
            expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
