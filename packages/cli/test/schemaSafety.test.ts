import { Contract } from '@redemeine/kernel';
import { z } from 'zod';
import * as ts from 'typescript';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeContract } from '../src/describeContract';
import { generateSchemaFiles } from '../src/generateSchemaFiles';
import { generateOutput } from '../src/extract/outputGenerator';
import { TypeToZodConverter } from '../src/extract/typeConverter';
import { extractZodSchemas } from '../src/extractZodSchemas';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(__dirname, '.schema-safety-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const names = ['__proto__', 'do-work', 'quote"\'key', 'line\n\tkey'];

test('description preserves arbitrary own keys and normal prototypes through JSON', () => {
    const contract = new Contract();
    for (const name of names) contract.addCommand(name, z.string()).addEvent(name, z.number());
    const described = describeContract(contract);
    for (const map of [described.commands, described.events]) {
        expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
        expect(Object.keys(map)).toEqual(names);
        expect(Object.keys(JSON.parse(JSON.stringify(map)))).toEqual(names);
    }
});

test.each(['../escape', '../../escape', '/absolute', 'C:\\escape', 'a/b', 'a\\b', '\0', '.', '..', ''])('rejects filename %j before any output write', name => {
    const outDir = join(dir, 'absent');
    const sentinel = join(dir, 'escape.ts');
    writeFileSync(sentinel, 'sentinel');
    const contract = new Contract().addCommand('valid', z.string()).addEvent(name, z.string());
    expect(() => generateSchemaFiles(contract, { outDir, aggregateName: 'aggregate' })).toThrow('Unsafe schema filename');
    expect(existsSync(outDir)).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('sentinel');
});

test.each(['symlink', 'hardlink', 'directory'])('prevalidates existing %s aliases before bundle writes', kind => {
    const outDir = join(dir, 'out');
    const commands = join(outDir, 'json/commands');
    mkdirSync(commands, { recursive: true });
    const sentinel = join(dir, 'outside.ts');
    writeFileSync(sentinel, 'sentinel');
    const target = join(commands, 'valid.ts');
    if (kind === 'symlink') symlinkSync(sentinel, target);
    else if (kind === 'hardlink') linkSync(sentinel, target);
    else mkdirSync(target);
    expect(() => generateSchemaFiles(new Contract().addCommand('valid', z.string()), { outDir, aggregateName: 'aggregate' })).toThrow();
    expect(existsSync(join(outDir, 'json.ts'))).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('sentinel');
});

test('invalid final event preserves the existing bundle and preceding command sentinel', () => {
    const outDir = join(dir, 'out');
    mkdirSync(join(outDir, 'json/commands'), { recursive: true });
    const bundle = join(outDir, 'json.ts');
    const command = join(outDir, 'json/commands/valid.ts');
    writeFileSync(bundle, 'bundle sentinel');
    writeFileSync(command, 'command sentinel');
    const contract = new Contract().addCommand('valid', z.string()).addEvent('aggregate.../escape.event', z.string());
    expect(() => generateSchemaFiles(contract, { outDir, aggregateName: 'aggregate' })).toThrow('Unsafe schema filename');
    expect(readFileSync(bundle, 'utf8')).toBe('bundle sentinel');
    expect(readFileSync(command, 'utf8')).toBe('command sentinel');
    expect(existsSync(join(outDir, 'json/events'))).toBe(false);
});

test('rejects directory symlink and extracted filename collisions before writing', () => {
    const outDir = join(dir, 'out');
    mkdirSync(outDir);
    symlinkSync(dir, join(outDir, 'json'));
    expect(() => generateSchemaFiles(new Contract().addCommand('safe', z.string()), { outDir, aggregateName: '../aggregate' })).toThrow('Symlink');
    expect(existsSync(join(outDir, 'json.ts'))).toBe(false);
    const contract = new Contract().addCommand('safe', z.string()).addCommand('aggregate.safe.command', z.string());
    expect(() => generateSchemaFiles(contract, { outDir: join(dir, 'absent'), aggregateName: 'aggregate' })).toThrow('Duplicate');
    expect(existsSync(join(dir, 'absent'))).toBe(false);
});

test('legacy emitted keys, property names and literals strictly compile and parse faithfully', () => {
    const source = join(dir, 'input.ts');
    // Construct unusual property names with JSON escaping rather than test-source interpolation.
    writeFileSync(source, `export type Payload = { [${JSON.stringify('do-work')}]: ${JSON.stringify('quote"\'\n')}; [${JSON.stringify('quote"key')}]?: "yes" | "no" };`);
    const program = ts.createProgram([source], compilerOptions());
    const checker = program.getTypeChecker();
    const file = program.getSourceFile(source)!;
    const declaration = file.statements[0];
    if (!declaration || !ts.isTypeAliasDeclaration(declaration)) throw Error('Missing payload');
    const type = checker.getTypeAtLocation(declaration);
    const payloads = new Map(names.map(name => [name, type]));
    const output = generateOutput(new TypeToZodConverter(checker, program), payloads, payloads, null, {});
    const generated = join(dir, 'generated.ts');
    writeFileSync(generated, output);
    expect(ts.getPreEmitDiagnostics(ts.createProgram([generated], compilerOptions())).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const exports = evaluate(output);
    for (const map of [exports.commandSchemas, exports.eventSchemas]) {
        expect(Object.keys(map)).toEqual(names);
        expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
        for (const schema of Object.values(map)) {
            expect(schema.safeParse({ 'do-work': 'quote"\'\n' }).success).toBe(true);
            expect(schema.safeParse({ 'do-work': 'wrong' }).success).toBe(false);
        }
    }
});

function compilerOptions(): ts.CompilerOptions {
    return { strict: true, noEmit: true, skipLibCheck: false, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, esModuleInterop: true };
}

function evaluate(source: string): { commandSchemas: Record<string, z.ZodType>; eventSchemas: Record<string, z.ZodType> } {
    const exports = {};
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'exports', code)(require, exports);
    return exports as { commandSchemas: Record<string, z.ZodType>; eventSchemas: Record<string, z.ZodType> };
}

test('mounted command Zod strictly compiles and validates canonical rather than pack arguments', () => {
    const entry = join(dir, 'input.ts');
    const outFile = join(dir, 'generated.ts');
    const tsconfig = join(dir, 'tsconfig.json');
    writeFileSync(entry, readFileSync(join(__dirname, 'fixtures/mountedCommands.ts'), 'utf8'));
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: {
        '@redemeine/aggregate': ['../../../aggregate/src/index.ts'], '@redemeine/kernel': ['../../../kernel/src/index.ts'],
    } }, include: ['*.ts'] }));
    extractZodSchemas({ entry, tsconfig, outFile, aggregateExport: 'aggregate' });
    expect(ts.getPreEmitDiagnostics(ts.createProgram([outFile], compilerOptions()))).toEqual([]);
    const { commandSchemas: commands, eventSchemas } = evaluate(readFileSync(outFile, 'utf8'));
    expect(Object.keys(commands).sort()).toEqual(['byKeyChangeLabel', 'byKeyLeavesChangeQty', 'changeTitle', 'childrenChangeLabel', 'childrenLeavesChangeQty']);
    for (const [key, schema] of Object.entries(commands)) {
        const good = key === 'changeTitle' ? { title: 'ok' } : key.endsWith('ChangeLabel') ? { id: 'child', label: 'ok' } : { id: 'leaf', qty: 2 };
        expect(schema.safeParse(good).success).toBe(true);
        expect(schema.safeParse({}).success).toBe(false);
        expect(schema.safeParse({ title: 1, id: 1, label: 1, qty: 'bad' }).success).toBe(false);
        expect(schema.safeParse(['child', 'label']).success).toBe(false);
    }
    expect(Object.keys(eventSchemas)).toEqual(['titleChanged']);
});

test.each(['value: Input', ''])('remapped creators retain authored return payload provenance (%s) and named imports', parameters => {
    const entry = join(dir, 'input.ts');
    const outFile = join(dir, 'generated.ts');
    const tsconfig = join(dir, 'tsconfig.json');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'zod-first' } } }));
    writeFileSync(join(dir, 'schemas.ts'), `import { z as validator } from 'zod';
        export const inputSchema = validator.string().min(10);
        export type Input = validator.infer<typeof inputSchema>;
        export const labelSchema = validator.string().min(3);
        export type Label = validator.infer<typeof labelSchema>;`);
    writeFileSync(entry, `import type { Input, Label } from './schemas';
        type Creators = { save(${parameters}): { payload: Label } };
        declare const aggregate: { commandCreators: { [K in keyof Creators as \`mounted\${Capitalize<K>}\`]: Creators[K] };
            pure: { eventProjectors: {} }; initialState: { ready: boolean } };
        export { aggregate }; throw Error('must not execute');`);
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }));
    extractZodSchemas({ entry, tsconfig, outFile, aggregateExport: 'aggregate', includeState: false });
    const source = readFileSync(outFile, 'utf8');
    expect(source).toMatch(/import \{ "labelSchema" as \w+ \} from "\.\/schemas"/);
    expect(source).not.toContain('inputSchema');
    expect(ts.getPreEmitDiagnostics(ts.createProgram([outFile], compilerOptions()))).toEqual([]);
    const exports = {} as { commandSchemas: Record<string, z.ZodType> };
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const authored = {};
    const schemaCode = ts.transpileModule(readFileSync(join(dir, 'schemas.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'exports', schemaCode)(require, authored);
    new Function('require', 'exports', code)((name: string) => name === './schemas' ? authored : require(name), exports);
    expect(exports.commandSchemas.mountedSave!.safeParse('valid').success).toBe(true);
    expect(exports.commandSchemas.mountedSave!.safeParse('no').success).toBe(false);
    expect(exports.commandSchemas.mountedSave!.safeParse(123).success).toBe(false);
    const jsonFile = join(dir, 'generated.json');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'types-first' } } }));
    expect(() => extractZodSchemas({ entry, tsconfig, outFile: jsonFile, aggregateExport: 'aggregate', includeState: false, format: 'json-schema' }))
        .toThrow(/existing Zod schema.*discard its constraints/);
    expect(existsSync(jsonFile)).toBe(false);
});

test.each(['zod', 'json-schema'] as const)('generic canonical return fails closed before %s output', format => {
    const entry = join(dir, 'input.ts');
    const outFile = join(dir, 'generated.' + (format === 'zod' ? 'ts' : 'json'));
    const tsconfig = join(dir, 'tsconfig.json');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode: 'types-first' } } }));
    writeFileSync(join(dir, 'schemas.ts'), `import { z } from 'zod';
        export const inputSchema = z.string().min(10); export type Input = z.infer<typeof inputSchema>;
        export const outputSchema = z.string().min(3); export type Output = z.infer<typeof outputSchema>;`);
    writeFileSync(entry, `import type { Input, Output } from './schemas';
        type Result<T> = { payload: T }; type Creators = { save(value: Input): Result<Output> };
        declare const aggregate: { commandCreators: { [K in keyof Creators as \`mounted\${Capitalize<K>}\`]: Creators[K] };
            pure: { eventProjectors: {} }; initialState: { ready: boolean } };
        export { aggregate }; throw Error('must not execute');`);
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }));
    expect(ts.getPreEmitDiagnostics(ts.createProgram([entry], compilerOptions()))).toEqual([]);
    expect(() => extractZodSchemas({ entry, tsconfig, outFile, aggregateExport: 'aggregate', includeState: false, format }))
        .toThrow(/mountedSave: cannot preserve schema-linked return payload provenance; use an authored concrete return payload type/);
    expect(existsSync(outFile)).toBe(false);
    writeFileSync(entry, readFileSync(entry, 'utf8').replace('Result<Output>', 'Result<string>'));
    extractZodSchemas({ entry, tsconfig, outFile, aggregateExport: 'aggregate', includeState: false, format });
    if (format === 'zod') {
        const schema = evaluate(readFileSync(outFile, 'utf8')).commandSchemas.mountedSave!;
        expect(schema.safeParse('no').success).toBe(true);
        expect(schema.safeParse(123).success).toBe(false);
    } else {
        expect(JSON.parse(readFileSync(outFile, 'utf8')).commands.mountedSave).toMatchObject({ type: 'string' });
    }
});

test.each([
    ['mixed siblings', 'type Result<T> = { payload: { generic: T; concrete: Output } }', 'Result<Output>'],
    ['unrelated sibling', 'type Result<T> = { payload: { generic: T; concrete: Choice } }', 'Result<Output>'],
    ['multiple parameters', 'type Result<T, U> = { payload: { first: T; second: U; concrete: Choice } }', 'Result<Output, Output>'],
    ['nested wrapper', 'type Wrapped<T> = { value: T }; type Result<T> = { payload: { nested: Wrapped<T>; concrete: Choice } }', 'Result<Output>'],
    ['repeated parameter', 'type Result<T> = { payload: { first: T; second: T; concrete: Output } }', 'Result<Output>'],
    ['inherited payload', 'interface Fields<T> { generic: T }; interface Mixed<T> extends Fields<T> { concrete: Choice }; type Result<T> = { payload: Mixed<T> }', 'Result<Output>'],
])('schema-linked generic return rejects %s regardless of concrete sibling links', (_name, wrapper, result) => {
    const entry = join(dir, 'input.ts');
    const tsconfig = join(dir, 'tsconfig.json');
    writeFileSync(join(dir, 'schemas.ts'), `import { z } from 'zod';
        export const inputSchema = z.string().min(10); export type Input = z.infer<typeof inputSchema>;
        export const outputSchema = z.string().min(3); export type Output = z.infer<typeof outputSchema>;
        export const choiceSchema = z.enum(['yes', 'no']); export type Choice = z.infer<typeof choiceSchema>;`);
    writeFileSync(entry, `import type { Input, Output, Choice } from './schemas'; ${wrapper};
        type Creators = { save(value: Input): ${result} };
        declare const aggregate: { commandCreators: { [K in keyof Creators as \`mounted\${Capitalize<K>}\`]: Creators[K] };
            pure: { eventProjectors: {} }; initialState: { ready: boolean } };
        export { aggregate }; throw Error('must not execute');`);
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }));
    expect(ts.getPreEmitDiagnostics(ts.createProgram([entry], compilerOptions()))).toEqual([]);
    for (const mode of ['types-first', undefined]) {
        writeFileSync(join(dir, 'package.json'), JSON.stringify(mode ? { redemeine: { schemas: { mode } } } : {}));
        for (const format of ['zod', 'json-schema'] as const) {
            const outFile = join(dir, `generated.${format === 'zod' ? 'ts' : 'json'}`);
            writeFileSync(outFile, 'sentinel');
            expect(() => extractZodSchemas({ entry, tsconfig, outFile, aggregateExport: 'aggregate', includeState: false, format }))
                .toThrow(/mountedSave: cannot preserve schema-linked return payload provenance; use an authored concrete return payload type/);
            expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
            rmSync(outFile);
            expect(() => extractZodSchemas({ entry, tsconfig, outFile, aggregateExport: 'aggregate', includeState: false, format }))
                .toThrow(/cannot preserve schema-linked return payload provenance/);
            expect(existsSync(outFile)).toBe(false);
        }
    }
});

test.each([
    ['default class', 'declare class Result<T = Output> { payload: T }', 'Result'],
    ['explicit class', 'declare class Result<T> { payload: T }', 'Result<Output>'],
    ['inherited class', 'declare class Base<T = Output> { payload: T }; declare class Result extends Base {}', 'Result'],
    ['structural class', 'declare class Result<T> { payload: T }', 'Result<string>'],
])('unresolved generic %s rejects before schema visibility checks', (_name, wrapper, result) => {
    const entry = join(dir, 'input.ts');
    const tsconfig = join(dir, 'tsconfig.json');
    writeFileSync(join(dir, 'schemas.ts'), `import { z } from 'zod';
        export const inputSchema = z.string().min(10); export type Input = z.infer<typeof inputSchema>;
        export const outputSchema = z.string().min(3); export type Output = z.infer<typeof outputSchema>;`);
    writeFileSync(entry, `import type { Input, Output } from './schemas'; ${wrapper};
        type Creators = { save(value: Input): ${result} };
        declare const aggregate: { commandCreators: { [K in keyof Creators as \`mounted\${Capitalize<K>}\`]: Creators[K] };
            pure: { eventProjectors: {} }; initialState: { ready: boolean } };
        export { aggregate }; throw Error('must not execute');`);
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }));
    expect(ts.getPreEmitDiagnostics(ts.createProgram([entry], compilerOptions()))).toEqual([]);
    for (const mode of ['types-first', 'zod-first']) {
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ redemeine: { schemas: { mode } } }));
        for (const format of ['zod', 'json-schema'] as const) {
            const outFile = join(dir, `generated.${format === 'zod' ? 'ts' : 'json'}`);
            writeFileSync(outFile, 'sentinel');
            const extract = () => extractZodSchemas({ entry, tsconfig, outFile, aggregateExport: 'aggregate', includeState: false, format });
            expect(extract).toThrow(/mountedSave: cannot establish generic class return payload provenance; use an authored concrete return payload type/);
            expect(readFileSync(outFile, 'utf8')).toBe('sentinel');
            rmSync(outFile);
            expect(extract).toThrow(/cannot establish generic class return payload provenance/);
            expect(existsSync(outFile)).toBe(false);
        }
    }
});

test('bundle TypeScript keeps __proto__ as data at runtime', () => {
    const outDir = join(dir, 'out');
    generateSchemaFiles(new Contract().addCommand('__proto__', z.string()).addEvent('__proto__', z.number()), { outDir, aggregateName: '../metadata', individual: false });
    const source = readFileSync(join(outDir, 'json.ts'), 'utf8');
    expect(ts.getPreEmitDiagnostics(ts.createProgram([join(outDir, 'json.ts')], compilerOptions()))).toEqual([]);
    const exports: { jsonSchemas?: ReturnType<typeof describeContract> } = {};
    new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports);
    expect(Object.keys(exports.jsonSchemas!.commands)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(exports.jsonSchemas!.commands)).toBe(Object.prototype);
    expect(exports.jsonSchemas!.aggregate).toBe('../metadata');
});
