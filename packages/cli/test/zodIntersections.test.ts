import * as ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { TypeToZodConverter } from '../src/extract/typeConverter';
import { generateOutput } from '../src/extract/outputGenerator';
import { commentText, formatSchemaSource } from '../src/extract/schemaSource';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(__dirname, '.zod-intersections-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, noEmit: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, esModuleInterop: true };

function fixture(source: string) {
    const input = join(directory, 'input.ts');
    writeFileSync(input, source);
    const program = ts.createProgram([input], options);
    expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
    const checker = program.getTypeChecker();
    const declarations = program.getSourceFile(input)!.statements.filter(ts.isTypeAliasDeclaration);
    return { program, checker, types: new Map(declarations.map(node => [node.name.text, checker.getTypeAtLocation(node)])) };
}

function compileAndLoad(output: string): { commandSchemas: Record<string, ZodType> } {
    const generated = join(directory, 'generated.ts');
    writeFileSync(generated, output);
    expect(ts.getPreEmitDiagnostics(ts.createProgram([generated], options)).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const result = {};
    const code = ts.transpileModule(output, { compilerOptions: { ...options, noEmit: false } }).outputText;
    new Function('require', 'exports', code)(require, result);
    return result as { commandSchemas: Record<string, ZodType> };
}

test('resolved intersections preserve PaymentAttempt shapes, nested overlaps and requiredness', () => {
    const { program, checker, types } = fixture(`
        type Job = { jobId: string };
        type Outcome = Job & { cancelJobIds: string[] };
        type State = { id: string; amount: number; currency: string };
        type Register = Pick<State, 'id'> & { confirmation: Job };
        type Registered = Omit<Register, 'confirmation'> & Partial<Pick<State, 'amount' | 'currency'>>;
        type Failed = (Job & { reason?: string }) & Outcome;
        type Overlap = { value?: string; nested: { a: string } } & { value: 'ok'; nested: { b: number } };
        type Impossible = { value: string } & { value: number };
    `);
    const output = generateOutput(new TypeToZodConverter(checker, program), types, new Map(), null, {});
    const { commandSchemas: schemas } = compileAndLoad(output);
    const cases: [string, unknown, unknown][] = [
        ['Outcome', { jobId: 'j', cancelJobIds: ['a'] }, { jobId: 'j', cancelJobIds: [3] }],
        ['Register', { id: 'a', confirmation: { jobId: 'j' } }, { id: 'a' }],
        ['Registered', { id: 'a' }, { id: 'a', amount: 'bad' }],
        ['Failed', { jobId: 'j', cancelJobIds: [], reason: 'why' }, { cancelJobIds: [] }],
        ['Overlap', { value: 'ok', nested: { a: 'a', b: 1 } }, { value: 'other', nested: { a: 'a', b: 1 } }]
    ];
    for (const [name, good, bad] of cases) {
        expect(schemas[name]!.safeParse(good).success).toBe(true);
        expect(schemas[name]!.safeParse(bad).success).toBe(false);
    }
    expect(schemas.Overlap!.safeParse({ nested: { a: 'a', b: 1 } }).success).toBe(false);
    expect(schemas.Overlap!.safeParse({ value: 'ok', nested: { a: 'a' } }).success).toBe(false);
    for (const value of [{ value: 'a' }, { value: 1 }, {}]) expect(schemas.Impossible!.safeParse(value).success).toBe(false);
    expect(output).not.toContain('z.any()');
});

test('record and array intersections keep both constraints instead of flattening one away', () => {
    const { program, checker, types } = fixture(`
        type Indexed = Record<string, string | number> & { count: number };
        type Arrays = { a: string }[] & { b: number }[];
    `);
    const output = generateOutput(new TypeToZodConverter(checker, program), types, new Map(), null, {});
    const { commandSchemas: schemas } = compileAndLoad(output);
    expect(schemas.Indexed!.safeParse({ count: 1, extra: 'ok' }).success).toBe(true);
    expect(schemas.Indexed!.safeParse({ count: 'wrong' }).success).toBe(false);
    expect(schemas.Indexed!.safeParse({ count: 1, extra: false }).success).toBe(false);
    expect(schemas.Arrays!.parse([{ a: 'ok', b: 1 }])).toEqual([{ a: 'ok', b: 1 }]);
    expect(schemas.Arrays!.safeParse([{ a: 'ok' }]).success).toBe(false);
    expect(output).toContain('z.intersection(');
});

test('member overrides remain referenced and are never flattened into weaker structural validation', () => {
    const { program, checker, types } = fixture('type Identifier = { id: string }; type Payload = Identifier & { count: number };');
    const converter = new TypeToZodConverter(checker, program, 'string', { Identifier: 'z.object({ id: z.string().min(3) })' });
    const output = generateOutput(converter, new Map([['payload', types.get('Payload')!]]), new Map(), null, {});
    const { commandSchemas } = compileAndLoad(output);
    expect(commandSchemas.payload!.safeParse({ id: 'abc', count: 1 }).success).toBe(true);
    expect(commandSchemas.payload!.safeParse({ id: 'a', count: 1 }).success).toBe(false);
    expect(output).toContain('z.intersection(');
});

test('real z.infer intersection annotations link exported schemas and preserve refinements', () => {
    const input = `import { z } from 'zod';
        export const actual = z.object({ id: z.string().min(3) });
        type Identifier = z.infer<typeof actual>; type Payload = Identifier & { count: number };`;
    const { program, checker, types } = fixture(input);
    const payload = types.get('Payload')!;
    const generated = join(directory, 'generated.ts');
    const output = generateOutput(new TypeToZodConverter(checker, program, 'string', {}, generated), new Map([['accept', payload]]), new Map(), null, {});
    writeFileSync(generated, output);
    expect(ts.getPreEmitDiagnostics(ts.createProgram([generated], options))).toEqual([]);
    const inputExports = {};
    const result: { commandSchemas?: Record<string, ZodType> } = {};
    const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { ...options, noEmit: false } }).outputText;
    new Function('require', 'exports', compile(input))(require, inputExports);
    new Function('require', 'exports', compile(output))((name: string) => name === './input' ? inputExports : require(name), result);
    expect(result.commandSchemas!.accept!.safeParse({ id: 'abc', count: 1 }).success).toBe(true);
    expect(result.commandSchemas!.accept!.safeParse({ id: 'a', count: 1 }).success).toBe(false);
    expect(output).toContain('z.intersection(');
});

test('comment text cannot terminate documentation or introduce executable statements', () => {
    const text = commentText('Example */\nexport const injected = true;\u2028more');
    const output = formatSchemaSource(`/** ${text} */\nexport const safe = true;`);
    const parsed = ts.createSourceFile('generated.ts', output, ts.ScriptTarget.Latest, true);
    expect(parsed.statements).toHaveLength(1);
    expect(text).not.toMatch(/\*\/|[\r\n\u2028\u2029]/);
});

test.each([
    'type Unsupported = string & { brand: true };',
    'type Unsupported = (() => string) & { id: string };',
    'type Unsupported = string[] & { tag: string };',
    'type Unsupported = Record<number, string> & { tag: string };',
    'type Unsupported = Date & { tag: string };'
])('unsupported intersection reports its type rather than silently emitting any: %s', source => {
    const { program, checker, types } = fixture(source);
    expect(() => generateOutput(new TypeToZodConverter(checker, program), types, new Map(), null, {})).toThrow(/Unsupported.*intersection/i);
});

test('readable output preserves source documentation, safe keys and deterministic dependency order', () => {
    const { program, checker, types } = fixture(`
        /** A job to perform when the attempt reaches an outcome. */
        type Job = {
            /** Queue job identifier. */
            jobId: string
        };
        /** Jobs to perform and cancel after an outcome. */
        type Outcome = Job & { cancelJobIds: string[] };
    `);
    const payloads = new Map([['register', types.get('Job')!], ['do-work', types.get('Outcome')!], ['__proto__', types.get('Outcome')!]]);
    const render = () => generateOutput(new TypeToZodConverter(checker, program), payloads, new Map(), null, {});
    const output = render();
    expect(render()).toBe(output);
    expect(output).toContain('A job to perform when the attempt reaches an outcome.');
    expect(output).toContain('Queue job identifier.');
    expect(output).toMatch(/\n +register: jobSchema/);
    expect(output).toMatch(/\n +jobId: z.string\(\)/);
    const { commandSchemas } = compileAndLoad(output);
    expect(Object.getPrototypeOf(commandSchemas)).toBe(Object.prototype);
    expect(Object.keys(commandSchemas)).toEqual(['register', 'do-work', '__proto__']);
    expect(output).toMatchSnapshot();
});
