import { Contract } from '@redemeine/kernel';
import { z } from 'zod';
import * as ts from 'typescript';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeContract } from '../src/describeContract';
import { generateSchemaFiles } from '../src/generateSchemaFiles';
import { generateOutput } from '../src/extract/outputGenerator';
import { TypeToZodConverter } from '../src/extract/typeConverter';

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
